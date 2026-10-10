// Images for text-only models. Every model may take images; before a Session request
// reaches a model that cannot read them, each image becomes text from a vision model.
// Texts are kept per attachment, so later requests repeat the same words and the
// prompt cache still hits.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { OCR_CACHE_MAX, OCR_PROMPT, OCR_RETRY_MS, OCR_TIMEOUT_MS } from './constants.js'
import { splitRef } from './text.js'

export function install(rt) {
  const { ctx, config, home } = rt

  // `textOnlyModels` names models whose provider claims image input but rejects it.
  const textOnlyModels = new Set(config.textOnlyModels ?? [])
  const ocrPath = join(home, 'ocr.json')
  let ocrCache = null
  let ocrWriting = Promise.resolve()
  const ocrPending = new Map()
  const ocrFailed = new Map()

  const liveImages = message => Array.isArray(message?.content)
    && message.content.some(block => block?.type === 'image' && !block.offloaded)

  async function readsImages(provider, model) {
    if (textOnlyModels.has(`${provider}/${model}`)) return false
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      return info.inputModalities === undefined || info.inputModalities.includes('image')
    } catch {
      return true
    }
  }

  // The configured `ocrModel` first, then served models that declare image input, the
  // DSH default among them first.
  async function ocrRoute() {
    const models = await rt.catalog()
    const served = new Set(models.map(entry => entry.ref))
    const declared = models.filter(entry => entry.input?.includes('image')).map(entry => entry.ref)
    const fallback = rt.defaultRef()
    for (const ref of new Set([config.ocrModel, ...declared.filter(ref => ref === fallback), ...declared])) {
      const route = splitRef(ref)
      if (route && served.has(ref) && await readsImages(route.provider, route.model)) return { ref, ...route }
    }
    return undefined
  }

  async function loadOcr() {
    if (ocrCache !== null) return
    try {
      ocrCache = new Map(Object.entries(JSON.parse(await readFile(ocrPath, 'utf8'))))
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: unreadable OCR cache %s: %s', ocrPath, error)
      ocrCache = new Map()
    }
  }

  function saveOcr() {
    while (ocrCache.size > OCR_CACHE_MAX) ocrCache.delete(ocrCache.keys().next().value)
    const snapshot = JSON.stringify(Object.fromEntries(ocrCache))
    ocrWriting = ocrWriting.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${ocrPath}.${process.pid}.tmp`
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, ocrPath)
    }).catch(error => rt.warn('ds-bot: OCR cache write failed: %s', error))
  }

  // `sessionId` is the Session the reading is for; its usage counts there.
  async function readImage(attachment, sessionId) {
    const route = await ocrRoute()
    if (route === undefined) throw new Error('no vision model is available')
    const assembler = new BlockAssembler()
    // No sessionId: this call is not a Session request, so the hook below lets it through.
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: rt.tagUsage([{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: OCR_PROMPT }] }], { sessionId, kind: 'image' }),
      maxTokens: 8192,
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure?.message ?? finish.kind)
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    if (text === '') throw new Error('the vision model returned no text')
    const model = (await rt.catalog()).find(entry => entry.ref === route.ref)?.name ?? route.model
    return { text, model }
  }

  // Resolves to the cached reading, or to null when the image cannot be read now.
  async function imageReading(attachment, sessionId) {
    const id = String(attachment.attachmentId)
    if (ocrCache.has(id)) return ocrCache.get(id)
    const failed = ocrFailed.get(id)
    if (failed && Date.now() - failed.at < OCR_RETRY_MS) return null
    if (!ocrPending.has(id)) {
      ocrPending.set(id, readImage(attachment, sessionId).then((reading) => {
        ocrCache.set(id, reading)
        ocrFailed.delete(id)
        saveOcr()
        return reading
      }, (error) => {
        rt.warn('ds-bot: could not read image %s: %s', id, error)
        ocrFailed.set(id, { at: Date.now() })
        return null
      }).finally(() => ocrPending.delete(id)))
    }
    return ocrPending.get(id)
  }

  const imageLabel = attachment => (attachment.name
    ? `"${attachment.name}"`
    : `sha256:${String(attachment.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)}`)

  function imageAsText(attachment, reading) {
    const label = imageLabel(attachment)
    return {
      type: 'text',
      text: reading === null
        ? `[Image ${label}: you cannot see images and it could not be read right now. Ask the user what it shows if it matters.]`
        : `[Image ${label}. You cannot see images, so ${reading.model} read it for you:]\n${reading.text}\n[End of image ${label}]`,
    }
  }

  // Members read the group as text, so a picture posted there reaches every member,
  // vision model or not, as its reading.
  async function imagesForGroup(attachments, sessionId) {
    await loadOcr()
    return Promise.all(attachments.map(async (attachment) => {
      const reading = await imageReading(attachment, sessionId)
      const label = imageLabel(attachment)
      return reading === null
        ? `[Image ${label}: it could not be read right now. Ask the user what it shows if it matters.]`
        : `[Image ${label}, read by ${reading.model}:]\n${reading.text}\n[End of image ${label}]`
    }))
  }

  async function withImagesAsText(messages, sessionId) {
    await loadOcr()
    const images = new Map()
    for (const message of messages) {
      if (!liveImages(message)) continue
      for (const block of message.content) {
        if (block?.type === 'image' && !block.offloaded) images.set(String(block.attachment.attachmentId), block.attachment)
      }
    }
    const readings = new Map(await Promise.all([...images].map(async ([id, attachment]) => [id, await imageReading(attachment, sessionId)])))
    return messages.map(message => (liveImages(message)
      ? {
          ...message,
          content: message.content.map(block => (block?.type === 'image' && !block.offloaded
            ? imageAsText(block.attachment, readings.get(String(block.attachment.attachmentId)))
            : block)),
        }
      : message))
  }

  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || !(options.messages ?? []).some(liveImages)) return next()
    return (async function* imagesAsTextOrPass() {
      await rt.load()
      if (rt.roomOf(options.sessionId) !== undefined || await readsImages(options.provider, options.model)) {
        yield* next()
        return
      }
      // `next` cannot take new messages, so the rewritten request starts over; it
      // carries no image, so this listener lets it through.
      yield* ctx.llm.stream({ ...options, messages: await withImagesAsText(options.messages, options.sessionId) })
    })()
  })

  Object.assign(rt, { imagesForGroup })
}
