// Search provider `auto` for dsh's web seam (`ctx.web`). Each query first tries native search
// behind the asking Session's own model route, with that route's own key, on that route's own
// origin. Native search is found by protocol, not by vendor: the route's wire protocol defines a
// standard search tool (Anthropic Messages, OpenAI Responses, Gemini), and a host may also serve
// a separate search API, declared as data (SEARCH_APIS, or `searchApis` in config). Whether an
// endpoint supports either is only knowable by trying, so every outcome is remembered. It never
// borrows another route's key: every key bills its own account. When native search is
// unavailable, a keyless fallback parses a public results page fetched through ctx.web.fetch.
// Every result says which path answered it; when both fail, the error tells the model not to
// guess. Independent of the Bot team code in index.js.
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'web-search-auto'
export const inject = ['web']

export const AUTO_PROVIDER_ID = 'auto'
export const DEFAULTS = Object.freeze({
  native: true,
  fallback: true,
  engines: ['bing', 'duckduckgo'],
  searchApis: [],
  nativeTimeoutMs: 40_000,
  fallbackTimeoutMs: 15_000,
})

const USER_AGENT = 'deepseek-harness/0.0.1'
const SNIPPET_CHARS = 500
const PROMPT = query => `Perform a web search for the query: ${query}`

const MINUTE = 60_000
// How long one outcome keeps a candidate from being tried again.
const SKIP_FOR = {
  absent: 24 * 60 * MINUTE,
  // The query itself may be what was refused (length, content moderation).
  rejected: 30 * MINUTE,
  // The user may enable search for the key right away.
  denied: 30 * MINUTE,
  // Each retry of an endpoint that answers without searching costs a model call.
  ignored: 6 * 60 * MINUTE,
}
const STATUS_OUTCOMES = { 404: 'absent', 405: 'absent', 501: 'absent', 400: 'rejected', 415: 'rejected', 422: 'rejected', 401: 'denied', 402: 'denied', 403: 'denied' }

// Routes whose profile leaves protocol, endpoint, or key name to the adapter: dsh's DeepSeek
// adapters, and the pi-ai 0.87.1 catalog routes that sign in with an API key
// (models.generated.js, env-api-keys.js). The protocol is undefined where it differs per model.
const CATALOG = {
  'deepseek-official': ['anthropic-messages', 'https://api.deepseek.com/anthropic', 'DEEPSEEK_API_KEY'],
  'deepseek-account': ['anthropic-messages', 'https://api.deepseek.com/anthropic', undefined],
  'ant-ling': ['openai-completions', 'https://api.ant-ling.com/v1', 'ANT_LING_API_KEY'],
  anthropic: ['anthropic-messages', 'https://api.anthropic.com', 'ANTHROPIC_API_KEY'],
  baseten: ['openai-completions', 'https://inference.baseten.co/v1', 'BASETEN_API_KEY'],
  cerebras: ['openai-completions', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY'],
  deepseek: ['openai-completions', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY'],
  fireworks: [undefined, 'https://api.fireworks.ai/inference/v1', 'FIREWORKS_API_KEY'],
  google: ['google-generative-ai', 'https://generativelanguage.googleapis.com/v1beta', 'GEMINI_API_KEY'],
  groq: ['openai-completions', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY'],
  huggingface: ['openai-completions', 'https://router.huggingface.co/v1', 'HF_TOKEN'],
  'kimi-coding': ['anthropic-messages', 'https://api.kimi.com/coding', 'KIMI_API_KEY'],
  meta: ['openai-responses', 'https://api.meta.ai/v1', 'META_API_KEY'],
  minimax: ['anthropic-messages', 'https://api.minimax.io/anthropic', 'MINIMAX_API_KEY'],
  'minimax-cn': ['anthropic-messages', 'https://api.minimaxi.com/anthropic', 'MINIMAX_CN_API_KEY'],
  moonshotai: ['openai-completions', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY'],
  'moonshotai-cn': ['openai-completions', 'https://api.moonshot.cn/v1', 'MOONSHOT_API_KEY'],
  nvidia: ['openai-completions', 'https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY'],
  openai: ['openai-responses', 'https://api.openai.com/v1', 'OPENAI_API_KEY'],
  opencode: [undefined, 'https://opencode.ai/zen/v1', 'OPENCODE_API_KEY'],
  'opencode-go': [undefined, 'https://opencode.ai/zen/go/v1', 'OPENCODE_API_KEY'],
  openrouter: [undefined, 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'],
  'qwen-token-plan': ['openai-completions', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['openai-completions', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['openai-completions', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'QWEN_TOKEN_PLAN_API_KEY'],
  together: ['openai-completions', 'https://api.together.ai/v1', 'TOGETHER_API_KEY'],
  'vercel-ai-gateway': ['anthropic-messages', 'https://ai-gateway.vercel.sh', 'AI_GATEWAY_API_KEY'],
  xai: ['openai-responses', 'https://api.x.ai/v1', 'XAI_API_KEY'],
  xiaomi: ['openai-completions', 'https://api.xiaomimimo.com/v1', 'XIAOMI_API_KEY'],
  'xiaomi-token-plan-ams': ['openai-completions', 'https://token-plan-ams.xiaomimimo.com/v1', 'XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-cn': ['openai-completions', 'https://token-plan-cn.xiaomimimo.com/v1', 'XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-sgp': ['openai-completions', 'https://token-plan-sgp.xiaomimimo.com/v1', 'XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  zai: ['openai-completions', 'https://api.z.ai/api/coding/paas/v4', 'ZAI_API_KEY'],
  'zai-coding-cn': ['openai-completions', 'https://open.bigmodel.cn/api/coding/paas/v4', 'ZAI_CODING_CN_API_KEY'],
}
const DSH_DEEPSEEK_ROUTES = new Set(['deepseek-official', 'deepseek-account'])

// ---------------------------------------------------------------------------
// Small helpers

const str = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const clamp = (value, low, high) => Math.min(high, Math.max(low, Math.floor(value)))
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const httpUrl = (value) => {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const reasonOf = error => (error?.cause?.message && error.message === 'fetch failed' ? error.cause.message : error?.message ?? String(error))
const seconds = ms => `${Math.round(ms / 1000)}s`
const trimSlash = url => url.replace(/\/+$/, '')

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  middot: '·', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', copy: '©', reg: '®', trade: '™', zwj: '', zwnj: '',
}
export const decodeEntities = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
  if (ref[0] === '#') {
    const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1))
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  }
  return NAMED_ENTITIES[ref.toLowerCase()] ?? whole
})
// Inline tags vanish so "<strong>deep</strong>seek" stays one word; block ends become spaces.
export const textOf = html => decodeEntities(html
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<(br|\/p|\/div|\/li|\/h\d|\/td|\/tr)\b[^>]*>/gi, ' ')
  .replace(/<[^>]*>/g, ''))
  .replace(/\s+/g, ' ')
  .trim()
const attrOf = (attrs, attr) => {
  const match = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  return match === null ? undefined : decodeEntities(match[2] ?? match[3] ?? '')
}

const plain = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

/** One portable source from plain-text fields; empty optional fields are omitted rather than invented. */
const sourceOf = (url, title, snippet, publishedAt) => {
  const href = httpUrl(url)
  if (href === undefined) return undefined
  const cleanTitle = plain(title)
  const cleanSnippet = plain(snippet)
  const date = str(publishedAt)
  return {
    url: href,
    ...cleanTitle ? { title: clip(cleanTitle, 300) } : {},
    ...cleanSnippet ? { snippet: clip(cleanSnippet, SNIPPET_CHARS) } : {},
    ...date ? { publishedAt: date } : {},
  }
}
const dedupe = (sources) => {
  const seen = new Map()
  for (const source of sources) {
    if (source === undefined) continue
    const known = seen.get(source.url)
    if (known === undefined) seen.set(source.url, source)
    else seen.set(source.url, { ...source, ...known })
  }
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// Native search: response readers. Each returns `{ ran, sources, error? }`: whether the endpoint
// actually ran a search, and only the structured sources it reported (URL, title, excerpt,
// date), never the answer text a model wrote around them.

/** Anthropic Messages with the `web_search_20250305` server tool. */
export function readMessages(body) {
  const blocks = Array.isArray(body?.content) ? body.content : []
  const results = blocks.filter(block => block?.type === 'web_search_tool_result')
  const excerpts = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue
    for (const cite of block.citations) {
      if (typeof cite?.url === 'string' && str(cite.cited_text) && !excerpts.has(cite.url)) excerpts.set(cite.url, cite.cited_text)
    }
  }
  const sources = dedupe(results.flatMap(block => (Array.isArray(block.content) ? block.content : []))
    .filter(item => item?.type === 'web_search_result')
    .map(item => sourceOf(item.url, item.title, excerpts.get(item.url) ?? (typeof item.content === 'string' ? item.content : undefined), item.page_age)))
  const failed = results.map(block => block.content).find(content => content?.type === 'web_search_tool_result_error')
  return {
    ran: results.length > 0 || blocks.some(block => block?.type === 'server_tool_use'),
    cut: body?.stop_reason === 'max_tokens',
    sources,
    ...sources.length === 0 && failed !== undefined ? { error: `web search failed: ${failed.error_code ?? 'unknown error'}` } : {},
  }
}

/** OpenAI Responses with the `web_search` tool. */
export function readResponses(body) {
  const output = Array.isArray(body?.output) ? body.output : []
  const calls = output.filter(item => item?.type === 'web_search_call')
  const found = []
  for (const call of calls) {
    for (const source of Array.isArray(call.action?.sources) ? call.action.sources : []) found.push(sourceOf(source?.url, source?.title))
  }
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      for (const note of Array.isArray(part?.annotations) ? part.annotations : []) {
        if (note?.type === 'url_citation') found.push(sourceOf(note.url, note.title))
      }
    }
  }
  for (const cite of Array.isArray(body?.citations) ? body.citations : []) {
    found.push(typeof cite === 'string' ? sourceOf(cite) : sourceOf(cite?.url, cite?.title))
  }
  const sources = dedupe(found)
  return { ran: calls.length > 0 || sources.length > 0, cut: body?.status === 'incomplete', sources }
}

/** Gemini `generateContent` with the `google_search` tool. */
export function readGemini(body) {
  const candidates = Array.isArray(body?.candidates) ? body.candidates : []
  return {
    ran: candidates.some(candidate => candidate?.groundingMetadata),
    cut: candidates.some(candidate => candidate?.finishReason === 'MAX_TOKENS'),
    sources: dedupe(candidates
      .flatMap(candidate => candidate?.groundingMetadata?.groundingChunks ?? [])
      .map(chunk => sourceOf(chunk?.web?.uri, chunk?.web?.title))),
  }
}

const URL_KEYS = ['url', 'uri', 'link']
const TITLE_KEYS = ['title', 'name', 'site_name']
const SNIPPET_KEYS = ['snippet', 'summary', 'content', 'description', 'cited_text', 'text']
const DATE_KEYS = ['published_date', 'publish_date', 'publish_time', 'page_age', 'date', 'last_updated']
// Media links are not results, and a response that echoes the request's tools is not a search.
const NOT_SOURCES = new Set(['image_url', 'images', 'image', 'icon', 'favicon', 'logo', 'logo_url', 'thumbnail', 'tools'])
const SEARCH_MARK = /search|grounding|citation/i
const firstText = (record, keys) => keys.map(key => record[key]).find(value => typeof value === 'string' && value.trim() !== '')

/** Every object in a JSON body that carries an http(s) URL, as sources: the shape of any search API. */
export function findSources(body) {
  const found = []
  const visit = (value, depth) => {
    if (depth > 16 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    const url = URL_KEYS.map(key => httpUrl(value[key])).find(Boolean)
    if (url !== undefined) found.push(sourceOf(url, firstText(value, TITLE_KEYS), firstText(value, SNIPPET_KEYS), firstText(value, DATE_KEYS)))
    for (const [key, child] of Object.entries(value)) if (!NOT_SOURCES.has(key)) visit(child, depth + 1)
  }
  visit(body, 0)
  return dedupe(found)
}

/** Whether a JSON body shows a search ran, read from its keys and `type` tags, never from prose. */
export function showsSearch(body) {
  const visit = (value, depth) => {
    if (depth > 16 || value === null || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(item => visit(item, depth + 1))
    return Object.entries(value).some(([key, child]) => !NOT_SOURCES.has(key) && (
      SEARCH_MARK.test(key) || key === 'results'
      || (key === 'type' && typeof child === 'string' && SEARCH_MARK.test(child))
      || visit(child, depth + 1)))
  }
  return visit(body, 0)
}

/** A declared search API's response: any structured sources, wherever they sit. */
export function readDeclared(body) {
  const sources = findSources(body)
  return { ran: sources.length > 0 || showsSearch(body), sources }
}

// ---------------------------------------------------------------------------
// Native search: what to try for one route. Nothing here names a vendor except SEARCH_APIS,
// which is data in the same shape as `searchApis` config.

const bearer = key => ({ authorization: `Bearer ${key}` })
export const AUTH_STYLES = { bearer, 'x-api-key': key => ({ 'x-api-key': key }), 'api-key': key => ({ 'api-key': key }) }
// One trailing /v1 belongs to the root, as in dsh's DeepSeek adapter and pi-ai's model listing.
const messagesRoot = base => (new URL(base).pathname.replace(/\/+$/, '').endsWith('/v1') ? trimSlash(base) : `${trimSlash(base)}/v1`)

// Bounds what an endpoint that ignores the search tool can cost, while leaving a thinking model
// room to reach the search: dsh's own DeepSeek search uses the same cap.
const OUTPUT_CAP = 4096

/** The standard search tool of each wire protocol. */
export const PROTOCOL_SEARCHES = {
  messages: {
    name: 'Anthropic Messages web_search tool',
    url: base => `${messagesRoot(base)}/messages`,
    // Anthropic reads x-api-key; compatible gateways often read Bearer.
    auth: key => ({ 'x-api-key': key, ...bearer(key) }),
    request: ({ model, query }) => ({
      headers: { 'anthropic-version': '2023-06-01' },
      body: {
        model,
        max_tokens: OUTPUT_CAP,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT(query) }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      },
    }),
    read: readMessages,
  },
  responses: {
    name: 'OpenAI Responses web_search tool',
    url: base => `${trimSlash(base)}/responses`,
    auth: bearer,
    request: ({ model, query }) => ({ body: { model, input: PROMPT(query), tools: [{ type: 'web_search' }], max_output_tokens: OUTPUT_CAP } }),
    read: readResponses,
  },
  gemini: {
    name: 'Gemini google_search tool',
    url: (base, model) => `${trimSlash(base)}/models/${encodeURIComponent(model)}:generateContent`,
    auth: key => ({ 'x-goog-api-key': key }),
    request: ({ query }) => ({
      body: { contents: [{ role: 'user', parts: [{ text: PROMPT(query) }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: OUTPUT_CAP } },
    }),
    read: readGemini,
  },
}
const BY_PROTOCOL = {
  'anthropic-messages': ['messages'],
  'openai-responses': ['responses'],
  // Many OpenAI-compatible servers also serve Responses and Messages under the same base.
  'openai-completions': ['responses', 'messages'],
  'google-generative-ai': ['gemini'],
}
const UNKNOWN_PROTOCOL = ['responses', 'messages']

/**
 * Search APIs a host serves beside its model protocol. No standard advertises these, so they
 * are declared; `searchApis` in config adds more in the same shape. `$query`, `$model`, and
 * `$maxResults` in a body are replaced per call. Each path is joined to the route's own origin.
 */
export const SEARCH_APIS = Object.freeze([
  // docs.ollama.com/capabilities/web-search
  { id: 'ollama', name: 'Ollama web search API', hosts: ['ollama.com'], path: '/api/web_search', maxResults: 10, body: { query: '$query', max_results: '$maxResults' } },
  // platform.kimi.ai; an empty result is not billed.
  { id: 'kimi', name: 'Kimi search API', hosts: ['api.moonshot.ai', 'api.moonshot.cn'], path: '/v1/tools/search', maxResults: 20, body: { text_query: '$query', limit: '$maxResults', timeout_seconds: 30 } },
  // docs.bigmodel.cn; the API rejects queries over 70 characters.
  { id: 'zhipu', name: 'Zhipu web search API', hosts: ['open.bigmodel.cn', 'api.z.ai'], path: '/api/paas/v4/web_search', maxResults: 50, maxQueryChars: 70, body: { search_query: '$query', search_engine: 'search_std', count: '$maxResults' } },
  // MiMo searches only through this Chat Completions plugin tool, once the Web Search plugin is
  // enabled for the key. Each keyword is one billed search, so one keyword per query; the answer
  // text is discarded, so it stays short and without thinking.
  {
    id: 'mimo', name: 'MiMo web_search plugin', hosts: ['xiaomimimo.com', '*.xiaomimimo.com'], path: '/v1/chat/completions', auth: ['bearer', 'api-key'], maxResults: 5,
    body: {
      model: '$model',
      messages: [{ role: 'user', content: '$query' }],
      tools: [{ type: 'web_search', force_search: true, max_keyword: 1, limit: '$maxResults' }],
      max_completion_tokens: 256,
      thinking: { type: 'disabled' },
      stream: false,
    },
  },
])

const hostMatches = (patterns, host) => patterns.some(pattern => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern.toLowerCase()))
const fill = (template, values) => {
  if (Array.isArray(template)) return template.map(item => fill(item, values))
  if (isRecord(template)) return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, values)]))
  return typeof template === 'string' && Object.hasOwn(values, template) ? values[template] : template
}

const usesModel = api => JSON.stringify(api.body).includes('"$model"')

function declaredCandidate(api, origin, model) {
  const url = `${origin}${api.path}`
  // A path such as `//other.example` must not move the key to another origin.
  if (new URL(url).origin !== origin) return undefined
  const styles = (api.auth ?? ['bearer']).map(style => AUTH_STYLES[style])
  return {
    id: api.id,
    name: api.name ?? `${api.id} search API`,
    url,
    model: usesModel(api) ? model : undefined,
    auth: key => Object.assign({}, ...styles.map(style => style(key))),
    request: ({ query, maxResults }) => ({
      body: fill(api.body, {
        $query: api.maxQueryChars === undefined ? query : [...query].slice(0, api.maxQueryChars).join(''),
        $model: model,
        $maxResults: clamp(maxResults ?? 8, 1, api.maxResults ?? 10),
      }),
    }),
    read: readDeclared,
  }
}

function protocolCandidate(id, base, model) {
  const shape = PROTOCOL_SEARCHES[id]
  return { id, name: shape.name, url: shape.url(base, model), model, auth: shape.auth, request: call => shape.request({ ...call, model }), read: shape.read }
}

/**
 * Everything worth trying for one route, cheapest first: search APIs declared for its host
 * (no model call), then the standard search tool of its protocol.
 * @returns `{ candidates }`, with `reason` when there is nothing to try.
 */
export function planNative(route, searchApis = SEARCH_APIS) {
  const base = httpUrl(route.baseURL)
  if (base === undefined) return { candidates: [], reason: `route "${route.provider}" has no known endpoint` }
  const url = new URL(base)
  const model = str(route.model)
  const candidates = []
  for (const api of searchApis) {
    if (!hostMatches(api.hosts, url.hostname)) continue
    if (model === undefined && usesModel(api)) continue
    const candidate = declaredCandidate(api, url.origin, model)
    if (candidate !== undefined) candidates.push(candidate)
  }
  const shapes = route.api === undefined ? UNKNOWN_PROTOCOL : BY_PROTOCOL[route.api] ?? []
  if (model !== undefined) for (const id of shapes) candidates.push(protocolCandidate(id, base, model))
  if (candidates.length > 0) return { candidates }
  return {
    candidates,
    reason: model === undefined && shapes.length > 0
      ? `route "${route.provider}" has no current model to search with`
      : `route "${route.provider}" speaks ${route.api}, which has no standard search tool, and ${url.host} declares no search API`,
  }
}

// ---------------------------------------------------------------------------
// Keyless fallback: public results pages, parsed into sources.

/** Bing wraps result links in `bing.com/ck/a?…&u=a1<base64url>`; recover the target. */
export function decodeBingUrl(href) {
  const url = httpUrl(href)
  if (url === undefined) return undefined
  const parsed = new URL(url)
  if (!/(^|\.)bing\.com$/i.test(parsed.hostname)) return url
  const target = parsed.searchParams.get('u')
  if (parsed.pathname !== '/ck/a' || target === null || !target.startsWith('a1')) return undefined
  try { return httpUrl(Buffer.from(target.slice(2), 'base64url').toString('utf8')) } catch { return undefined }
}

/** Bing results page → `{ sources }`, or `{ error }` when the page is not a results page. */
export function parseBing(html) {
  const starts = [...html.matchAll(/<li\b[^>]*\bclass\s*=\s*"[^"]*\bb_algo\b[^"]*"[^>]*>/gi)].map(match => match.index)
  const sources = []
  starts.forEach((start, index) => {
    const block = html.slice(start, starts[index + 1] ?? start + 12_000)
    const heading = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block)
    if (heading === null) return
    const href = attrOf(heading[1], 'href')
    const caption = block.slice(Math.max(0, block.search(/<div\b[^>]*\bclass\s*=\s*"[^"]*\bb_caption\b/i)))
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(caption)
    sources.push(sourceOf(decodeBingUrl(href), textOf(heading[2]), paragraph ? textOf(paragraph[1]) : undefined))
  })
  const parsed = dedupe(sources)
  if (parsed.length > 0) return { sources: parsed }
  if (/\bclass\s*=\s*"[^"]*\bb_no\b/i.test(html)) return { sources: [] }
  return { error: /id\s*=\s*"b_results"/i.test(html) ? 'results page had no parsable results' : 'not a results page (bot check or changed layout)' }
}

/** DuckDuckGo HTML results page → `{ sources }`, or `{ error }`. */
export function parseDuckDuckGo(html) {
  if (/anomaly-modal|bots use DuckDuckGo too|challenge-form/i.test(html)) return { error: 'bot check page' }
  const links = [...html.matchAll(/<a\b([^>]*\bclass\s*=\s*"[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)]
  const sources = links.map((link, index) => {
    const href = attrOf(link[1], 'href') ?? ''
    let target
    try {
      const parsed = new URL(href, 'https://duckduckgo.com')
      // `/y.js` links are ads.
      if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) target = parsed.pathname === '/l/' ? parsed.searchParams.get('uddg') : undefined
      else target = parsed.href
    } catch { target = undefined }
    const rest = html.slice(link.index + link[0].length, links[index + 1]?.index ?? link.index + 6000)
    const snippet = /<(?:a|div|td)\b[^>]*\bclass\s*=\s*"[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(rest)
    return sourceOf(target, textOf(link[2]), snippet ? textOf(snippet[1]) : undefined)
  })
  const parsed = dedupe(sources)
  if (parsed.length > 0) return { sources: parsed }
  if (/\bresult--no-results\b|\bno-results\b/i.test(html)) return { sources: [] }
  return { error: 'not a results page (bot check or changed layout)' }
}

export const ENGINES = {
  // No market or language parameter: Bing picks them from the network, as it does for a browser.
  // `regional` is the hosts Bing itself may redirect to (mainland networks go to cn.bing.com).
  bing: { name: 'Bing', url: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBing, regional: /^https:\/\/([a-z0-9-]+\.)*bing\.com$/i },
  duckduckgo: { name: 'DuckDuckGo', url: query => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parse: parseDuckDuckGo },
}

// ---------------------------------------------------------------------------
// The provider

const aborted = signal => new WebError('web search aborted', 'WEB_ABORTED', { cause: signal?.reason })

function checkSearchApi(api, index) {
  const where = `web-search-auto: searchApis[${index}]`
  if (!isRecord(api)) throw new Error(`${where} must be an object`)
  if (str(api.id) === undefined) throw new Error(`${where} needs an id`)
  if (!Array.isArray(api.hosts) || api.hosts.length === 0 || !api.hosts.every(host => typeof host === 'string' && /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host))) {
    throw new Error(`${where}.hosts must be a list of host names; a leading *. matches subdomains`)
  }
  if (typeof api.path !== 'string' || !/^\/[^/]/.test(api.path)) throw new Error(`${where}.path must be a path on the route's host, starting with one /`)
  if (!isRecord(api.body)) throw new Error(`${where}.body must be an object`)
  if (api.auth !== undefined && (!Array.isArray(api.auth) || api.auth.length === 0 || api.auth.some(style => !Object.hasOwn(AUTH_STYLES, style)))) {
    throw new Error(`${where}.auth must be a list of ${Object.keys(AUTH_STYLES).join(', ')}`)
  }
  for (const key of ['maxResults', 'maxQueryChars']) {
    if (api[key] !== undefined && !(Number.isInteger(api[key]) && api[key] >= 1)) throw new Error(`${where}.${key} must be a positive integer`)
  }
  if (api.name !== undefined && str(api.name) === undefined) throw new Error(`${where}.name must be text`)
}

/**
 * Normalize plugin config. Invalid entries fail loud at load rather than silently searching less.
 * Declared `searchApis` come before the built-in SEARCH_APIS, so a user entry wins on its host.
 */
export function resolveConfig(config = {}) {
  const resolved = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined)) }
  if (!Array.isArray(resolved.engines) || resolved.engines.some(engine => !Object.hasOwn(ENGINES, engine))) {
    throw new Error(`web-search-auto: engines must be a list of ${Object.keys(ENGINES).join(', ')}`)
  }
  for (const key of ['nativeTimeoutMs', 'fallbackTimeoutMs']) {
    if (!Number.isFinite(resolved[key]) || resolved[key] < 1000) throw new Error(`web-search-auto: ${key} must be at least 1000`)
  }
  if (!Array.isArray(resolved.searchApis)) throw new Error('web-search-auto: searchApis must be a list')
  resolved.searchApis.forEach(checkSearchApi)
  return {
    ...resolved,
    native: resolved.native !== false,
    fallback: resolved.fallback !== false,
    searchApis: [...resolved.searchApis, ...SEARCH_APIS],
  }
}

const errorDetail = (text) => {
  try {
    const parsed = JSON.parse(text)
    return str(typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message ?? parsed?.msg) ?? ''
  } catch { return '' }
}

/**
 * Build the `auto` search provider over injected effects, so tests run it without a host.
 * @param deps.route - the asking Session's route: `{ provider, model, api, baseURL, apiKeyEnv, account, headers }`.
 * @param deps.resolveKey - credential reference → key, or undefined.
 * @param deps.resolveAccountToken - endpoint → DeepSeek account token, or undefined.
 * @param deps.fetch - the HTTP client for native searches.
 * @param deps.webFetch - `ctx.web.fetch`.
 */
export function createAutoSearchProvider(deps, config = {}) {
  const options = resolveConfig(config)
  const now = deps.now ?? Date.now
  // route + endpoint + model → `{ works: true }` or `{ until, reason }`, for this process.
  const memory = new Map()

  async function credentialFor(route, endpoint) {
    if (route.account) {
      let token
      try { token = str(await deps.resolveAccountToken?.(endpoint)) } catch (error) { return { reason: `the DeepSeek account token could not be read: ${reasonOf(error)}` } }
      return token === undefined
        ? { reason: 'it is not signed in to a DeepSeek account' }
        : { headers: () => ({ 'x-dsh-auth-token': token }), via: 'the DeepSeek account sign-in' }
    }
    if (route.apiKeyEnv === undefined) return { reason: 'it names no API key' }
    let key
    try { key = str(await deps.resolveKey(route.apiKeyEnv)) } catch (error) { return { reason: `the key ${route.apiKeyEnv} could not be read: ${reasonOf(error)}` } }
    return key === undefined
      ? { reason: `no API key is stored for ${route.apiKeyEnv}` }
      : { headers: candidate => candidate.auth(key), via: `the API key ${route.apiKeyEnv}` }
  }

  async function attempt(candidate, route, credential, request, signal, budget, known) {
    const call = candidate.request({ query: request.query, maxResults: request.maxResults })
    const timeout = AbortSignal.timeout(budget)
    let response
    let text
    try {
      response = await deps.fetch(candidate.url, {
        method: 'POST',
        // Credential-bearing requests never follow redirects (deepseek-harness/packages/web/AGENTS.md).
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT, ...route.headers, ...call.headers, ...credential.headers(candidate) },
        body: JSON.stringify(call.body),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      text = await response.text()
    } catch (error) {
      if (signal?.aborted) throw aborted(signal)
      return { reason: timeout.aborted ? `timed out after ${seconds(budget)}` : `request failed: ${reasonOf(error)}` }
    }
    if (!response.ok) {
      const detail = errorDetail(text)
      return { reason: `HTTP ${response.status}${detail ? `: ${clip(detail, 200)}` : ''}`, skip: STATUS_OUTCOMES[response.status] }
    }
    let body
    try { body = JSON.parse(text) } catch { return { reason: 'answered with a body that is not JSON', skip: 'ignored' } }
    const read = candidate.read(body)
    if (read.sources.length > 0) return { sources: read.sources }
    if (read.error !== undefined) return { reason: read.error, final: true }
    if (read.ran || known) return { reason: 'returned no results', final: true }
    // The cap says nothing about support, so a cut-off answer is not remembered.
    if (read.cut) return { reason: 'stopped at the output cap before searching' }
    return { reason: 'answered without running a search, so it does not seem to support this one', skip: 'ignored' }
  }

  async function runNative(request, signal) {
    if (!options.native) return { reason: 'native search is turned off (web-search-auto native: false)' }
    let route
    try { route = deps.route() } catch (error) { return { reason: `the conversation's model route could not be read: ${reasonOf(error)}` } }
    if (route === undefined) return { reason: 'no conversation model route is known for this search' }
    const plan = planNative(route, options.searchApis)
    if (plan.candidates.length === 0) return { reason: plan.reason }
    const keyOf = candidate => [route.provider, candidate.url, candidate.model ?? ''].join('\n')
    const works = candidate => memory.get(keyOf(candidate))?.works === true
    const ordered = [...plan.candidates.filter(works), ...plan.candidates.filter(candidate => !works(candidate))]
    const deadline = now() + options.nativeTimeoutMs
    const notes = []
    let credential
    for (const candidate of ordered) {
      const where = `${candidate.name} (${new URL(candidate.url).host}${new URL(candidate.url).pathname})`
      const memo = memory.get(keyOf(candidate))
      if (memo?.until !== undefined && memo.until > now()) {
        notes.push(`${where}: ${memo.reason}; not retried for ${Math.ceil((memo.until - now()) / MINUTE)} min`)
        continue
      }
      credential ??= await credentialFor(route, candidate.url)
      if (signal?.aborted) throw aborted(signal)
      if (credential.reason !== undefined) return { reason: `route "${route.provider}" could not search natively: ${credential.reason}` }
      const remaining = deadline - now()
      if (remaining <= 0) { notes.push(`${where}: skipped, out of time`); continue }
      const outcome = await attempt(candidate, route, credential, request, signal, remaining, memo?.works === true)
      if (outcome.sources !== undefined) {
        memory.set(keyOf(candidate), { works: true })
        return {
          result: {
            content: `Search backend: native search of this conversation's model route "${route.provider}": ${where}, billed to ${credential.via}.`,
            sources: outcome.sources,
            truncated: false,
          },
        }
      }
      notes.push(`${where}: ${outcome.reason}`)
      if (outcome.skip !== undefined) memory.set(keyOf(candidate), { until: now() + SKIP_FOR[outcome.skip], reason: outcome.reason })
      if (outcome.final) break
    }
    return { reason: `route "${route.provider}": ${notes.join('; ')}` }
  }

  async function fetchPage(engine, url, signal) {
    try {
      return { page: await deps.webFetch({ url }, signal), url }
    } catch (error) {
      // The fetch provider refuses cross-origin redirects and names the target; follow one hop
      // when it is the engine's own regional host.
      const origin = error?.code === 'WEB_REDIRECT_BLOCKED' ? /https?:\/\/[a-z0-9.-]+(:\d+)?/i.exec(error.message ?? '')?.[0] : undefined
      if (origin === undefined || engine.regional?.test(origin) !== true || origin === new URL(url).origin) throw error
      const { pathname, search } = new URL(url)
      const regional = `${origin}${pathname}${search}`
      return { page: await deps.webFetch({ url: regional }, signal), url: regional }
    }
  }

  async function runFallback(request, signal) {
    const attempts = []
    let empty
    const deadline = now() + options.fallbackTimeoutMs
    for (const [index, id] of options.engines.entries()) {
      const engine = ENGINES[id]
      const url = engine.url(request.query)
      const host = new URL(url).host
      const remaining = deadline - now()
      if (remaining <= 0) { attempts.push(`${host}: skipped, out of time`); continue }
      // Leave later engines a share of the budget when an earlier one hangs.
      const timeout = AbortSignal.timeout(index === options.engines.length - 1 ? remaining : Math.min(remaining, Math.ceil(options.fallbackTimeoutMs / 2)))
      let fetched
      try {
        fetched = await fetchPage(engine, url, signal === undefined ? timeout : AbortSignal.any([signal, timeout]))
      } catch (error) {
        if (signal?.aborted) throw aborted(signal)
        attempts.push(`${host}: ${timeout.aborted ? 'timed out' : `${error?.code ? `${error.code} ` : ''}${reasonOf(error)}`}`)
        continue
      }
      const at = new URL(fetched.url).host
      if (fetched.page.statusCode !== 200) { attempts.push(`${at}: HTTP ${fetched.page.statusCode}`); continue }
      const parsed = engine.parse(fetched.page.body?.content ?? '')
      if (parsed.error !== undefined) { attempts.push(`${at}: ${parsed.error}`); continue }
      if (parsed.sources.length === 0) { empty ??= { engine, at }; attempts.push(`${at}: no results`); continue }
      return { result: { engine, at, sources: parsed.sources } }
    }
    return empty === undefined ? { attempts } : { result: { ...empty, sources: [] } }
  }

  return {
    id: AUTO_PROVIDER_ID,
    available: () => options.native || options.fallback,
    async search(request, signal) {
      if (signal?.aborted) throw aborted(signal)
      const native = await runNative(request, signal)
      if (native.result !== undefined) return native.result
      let fallbackReason = 'turned off (web-search-auto fallback: false)'
      if (options.fallback) {
        const fallback = await runFallback(request, signal)
        if (fallback.result !== undefined) {
          return {
            content: `Search backend: keyless fallback, parsed from the public ${fallback.result.engine.name} results page at ${fallback.result.at} (no API key, no charge; less reliable than an API search). Native search was not used: ${native.reason}.`,
            sources: fallback.result.sources,
            truncated: false,
          }
        }
        fallbackReason = fallback.attempts.join('; ')
      }
      throw new WebError([
        'Web search is unavailable for this query.',
        `Native search: ${native.reason}.`,
        `Keyless fallback: ${fallbackReason}.`,
        'Do not guess URLs or present pages you remember as search results. If you have a browser tool, open a search engine in it; otherwise tell the user that web search is unavailable and why.',
      ].join('\n'), 'WEB_SEARCH_UNAVAILABLE')
    },
  }
}

// ---------------------------------------------------------------------------
// Host wiring: read the asking Session's route through public dsh services only.

const stringRecord = value => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string')) : {})

/** The route of the Session that started the current tool call: protocol, endpoint, key name, and headers. */
export function routeOf(ctx) {
  const request = ctx.get('agents')?.currentInitiator()?.session.requestContext()
  const provider = str(request?.provider)
  if (provider === undefined) return undefined
  let section
  try {
    const entry = ctx.get('llm')?.listConfigurableProviders().find(item => item.provider === provider)
    if (entry !== undefined) {
      const descriptor = ctx.get('settings')?.describe().find(item => item.ns === entry.settingsNs)
      section = entry.settingsPath.reduce((value, key) => value?.[key], descriptor?.value)
    }
  } catch { section = undefined }
  const [catalogApi, catalogBase, catalogKey] = CATALOG[provider] ?? []
  const account = provider === 'deepseek-account'
  return {
    provider,
    model: str(request.model),
    api: str(section?.api) ?? catalogApi,
    baseURL: str(section?.baseURL) ?? (DSH_DEEPSEEK_ROUTES.has(provider) ? str(envOf(ctx)('DEEPSEEK_BASE_URL')) : undefined) ?? catalogBase,
    apiKeyEnv: account ? undefined : str(section?.apiKeyEnv) ?? catalogKey,
    account,
    headers: stringRecord(section?.headers),
  }
}

const envOf = ctx => name => ctx.get('launchEnvironment')?.get(name)?.value ?? process.env[name]

export function apply(ctx, config = {}) {
  const env = envOf(ctx)
  ctx.web.registerSearchProvider(createAutoSearchProvider({
    route: () => routeOf(ctx),
    resolveKey: async (ref) => {
      const credentials = ctx.get('credentials')
      // Without the seam the environment is the whole credential plane, as in dsh's own adapters.
      return credentials === undefined ? env(ref) : (await credentials.resolve(ref))?.value
    },
    resolveAccountToken: endpoint => ctx.get('deepseekAccount')?.resolveToken(endpoint),
    fetch: (url, init) => fetch(url, init),
    webFetch: (request, signal) => ctx.web.fetch(request, signal),
  }, config))
}
