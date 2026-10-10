// A logging pass-through for runs against a real model route, in OpenAI chat completions
// or Anthropic Messages format. Point the provider's baseURL at it; it forwards every
// request to the upstream base URL unchanged (all headers but the hop-by-hop ones, the
// provider's key and session headers included) and writes one JSON line per call: what
// kind of call it was, which Bot made it, token usage, the latest input and the answer.
// Headers are never logged. `usage` is the provider's own; `tokens` puts both formats in
// one shape: { prompt (cached included), cached, output }.
//
//   node dev/llm-tap.mjs <port> <upstream base URL> <log.jsonl> [body dir]
//
// The request path is appended to the upstream base, less a leading /v1: with upstream
// https://host/v1, a request to /v1/chat/completions goes to https://host/v1/chat/completions;
// with upstream https://api.deepseek.com and baseURL http://127.0.0.1:<port>/anthropic,
// /anthropic/v1/messages goes to https://api.deepseek.com/anthropic/v1/messages.
//
// Kinds: steward (the context steward), checkpoint, handoff (a handoff note), main.
// Answers are logged whole; a main call's input and reasoning are cut short. Each line
// also compares the request with the same Bot's previous one: a provider serves only a
// shared prefix from its cache, so `prefix` names where the two first differ. With a
// body dir, every request body is saved there whole, as <id>-<kind>-<bot>.json.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const [port, upstream, log, bodies] = process.argv.slice(2)
if (!port || !upstream || !log) {
  console.error('usage: node dev/llm-tap.mjs <port> <upstream base URL> <log.jsonl> [body dir]')
  process.exit(2)
}
if (bodies) mkdirSync(bodies, { recursive: true })
const base = upstream.replace(/\/+$/, '')
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding', 'upgrade', 'te', 'trailer', 'proxy-connection'])
let next = 0

const textOf = content => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.text ?? '').join('\n') : '')

function describe(body) {
  const messages = body?.messages ?? []
  const system = body?.system !== undefined ? textOf(body.system)
    : textOf(messages.find(message => message.role === 'system' || message.role === 'developer')?.content)
  const lastUser = textOf(messages.findLast(message => message.role === 'user')?.content)
  const kind = /context steward/.test(system) ? 'steward'
    : /You keep the long-term memory of one Bot/.test(system) ? 'review'
      : /You write the memory summary/.test(system) ? 'summary'
        : /You keep the memory of one Bot/.test(system) ? 'ask'
          : /You are now writing a checkpoint/.test(lastUser) ? 'checkpoint'
            : /You are now writing a handoff note/.test(lastUser) ? 'handoff' : 'main'
  const bot = /You are ([^,\n]+), a Bot/.exec(system)?.[1]
    ?? (kind === 'review' ? /^The Bot: ([^,\n]+?)[,.]/.exec(lastUser)?.[1] : undefined)
    ?? (/Main Bot/.test(system) ? 'Main Bot' : undefined)
  return {
    kind,
    bot,
    messages: messages.length,
    lastUser,
    request: {
      max_tokens: body?.max_tokens ?? body?.max_completion_tokens,
      reasoning_effort: body?.reasoning_effort ?? body?.output_config?.effort,
      thinking: body?.thinking?.type,
      think: body?.think,
    },
  }
}

function tokensOf(usage) {
  if (usage === undefined) return undefined
  if (usage.input_tokens !== undefined) {
    const cached = usage.cache_read_input_tokens ?? 0
    return { prompt: usage.input_tokens + cached + (usage.cache_creation_input_tokens ?? 0), cached, output: usage.output_tokens }
  }
  return { prompt: usage.prompt_tokens, cached: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0, output: usage.completion_tokens }
}

const SIZE_FIELDS = new Set(['messages', 'tools', 'max_tokens', 'max_completion_tokens'])
const previousOf = new Map()

// Where this request first departs from the previous one: the other fields, the tools,
// then the messages in order, down to the first differing character.
function prefixAgainst(previous, body) {
  if (previous === undefined) return undefined
  const fields = [...new Set([...Object.keys(previous.body), ...Object.keys(body)])]
    .filter(key => !SIZE_FIELDS.has(key) && JSON.stringify(previous.body[key]) !== JSON.stringify(body[key]))
  const before = previous.body.messages ?? []
  const after = body.messages ?? []
  let same = 0
  while (same < before.length && same < after.length && JSON.stringify(before[same]) === JSON.stringify(after[same])) same += 1
  const result = {
    previous: previous.id,
    fields,
    sameTools: JSON.stringify(previous.body.tools) === JSON.stringify(body.tools),
    sameMessages: same,
    of: before.length,
  }
  if (same < before.length && same < after.length) {
    const a = JSON.stringify(before[same])
    const b = JSON.stringify(after[same])
    let at = 0
    while (at < a.length && a[at] === b[at]) at += 1
    result.firstDiff = { index: same, role: after[same]?.role, at, was: a.slice(Math.max(0, at - 80), at + 160), now: b.slice(Math.max(0, at - 80), at + 160) }
  }
  return result
}

// Text, reasoning, tool calls and usage from a streamed or a plain completion.
function answerOf(raw, streamed) {
  const out = { text: '', reasoning: '', tools: [], usage: undefined, finish: undefined }
  const take = (choice, usage) => {
    const part = choice?.delta ?? choice?.message ?? {}
    if (typeof part.content === 'string') out.text += part.content
    const thought = part.reasoning ?? part.reasoning_content
    if (typeof thought === 'string') out.reasoning += thought
    for (const call of part.tool_calls ?? []) {
      if (call.function?.name) out.tools.push(call.function.name)
    }
    if (choice?.finish_reason) out.finish = choice.finish_reason
    if (usage) out.usage = usage
  }
  // Anthropic Messages: usage comes in message_start and grows in message_delta.
  const event = json => {
    switch (json.type) {
      case 'message_start': out.usage = { ...json.message?.usage }; break
      case 'content_block_start':
        if (json.content_block?.type === 'tool_use') out.tools.push(json.content_block.name)
        if (typeof json.content_block?.text === 'string') out.text += json.content_block.text
        break
      case 'content_block_delta':
        if (json.delta?.type === 'text_delta') out.text += json.delta.text
        if (json.delta?.type === 'thinking_delta') out.reasoning += json.delta.thinking
        break
      case 'message_delta':
        if (json.delta?.stop_reason) out.finish = json.delta.stop_reason
        if (json.usage) out.usage = { ...out.usage, ...json.usage }
        break
      default:
    }
  }
  const one = json => {
    if (typeof json?.type === 'string' && json.choices === undefined) {
      if (json.type === 'message') {
        for (const block of json.content ?? []) {
          if (block.type === 'text') out.text += block.text
          if (block.type === 'thinking') out.reasoning += block.thinking
          if (block.type === 'tool_use') out.tools.push(block.name)
        }
        out.finish = json.stop_reason
        out.usage = json.usage
      } else event(json)
      return
    }
    take(json?.choices?.[0], json?.usage)
  }
  if (!streamed) {
    try { one(JSON.parse(raw)) } catch { out.text = raw.slice(0, 2000) }
    return out
  }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try { one(JSON.parse(data)) } catch { /* a partial line; the rest of the stream still counts */ }
  }
  return out
}

createServer(async (req, res) => {
  const id = ++next
  const started = Date.now()
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  let body
  try { body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined } catch { body = undefined }
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value
  let upstreamResponse
  try {
    upstreamResponse = await fetch(`${base}${req.url.replace(/^\/v1/, '')}`, { method: req.method, headers, body: raw.length > 0 ? raw : undefined })
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `tap: upstream unreachable: ${error.message}` } }))
    appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), id, path: req.url, error: error.message }) + '\n')
    return
  }
  const type = upstreamResponse.headers.get('content-type') ?? ''
  res.writeHead(upstreamResponse.status, { 'content-type': type || 'application/json', 'cache-control': 'no-cache' })
  let text = ''
  const decoder = new TextDecoder()
  if (upstreamResponse.body) {
    for await (const chunk of upstreamResponse.body) {
      res.write(chunk)
      text += decoder.decode(chunk, { stream: true })
    }
  }
  res.end()
  if (body?.messages === undefined) {
    appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), id, path: req.url, status: upstreamResponse.status }) + '\n')
    return
  }
  const call = describe(body)
  const answer = answerOf(text, type.includes('event-stream'))
  const whole = call.kind !== 'main'
  const who = call.bot ?? call.kind
  const prefix = prefixAgainst(previousOf.get(who), body)
  previousOf.set(who, { id, body })
  if (bodies) writeFileSync(path.join(bodies, `${id}-${call.kind}-${String(who).replace(/[^\w.-]+/g, '_')}.json`), raw)
  appendFileSync(log, JSON.stringify({
    t: new Date().toISOString(),
    id,
    ms: Date.now() - started,
    status: upstreamResponse.status,
    kind: call.kind,
    bot: call.bot,
    messages: call.messages,
    request: call.request,
    ...(prefix === undefined ? {} : { prefix }),
    usage: answer.usage,
    tokens: tokensOf(answer.usage),
    finish: answer.finish,
    lastUser: whole ? call.lastUser : call.lastUser.slice(0, 300),
    text: answer.text,
    reasoning: whole ? answer.reasoning : answer.reasoning.slice(0, 200),
    tools: answer.tools,
    ...(upstreamResponse.status >= 400 ? { error: text.slice(0, 1000) } : {}),
  }) + '\n')
}).listen(Number(port), '127.0.0.1', () => console.log(`llm-tap: 127.0.0.1:${port} -> ${base}`))
