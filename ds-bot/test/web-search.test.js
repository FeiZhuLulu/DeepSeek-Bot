import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  createAutoSearchProvider, decodeBingUrl, findSources, parseBing, parseDuckDuckGo, planNative,
  readDeclared, readGemini, readMessages, readResponses, resolveConfig, routeOf, SEARCH_APIS,
} from '../web-search.js'

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const page = (content, statusCode = 200, url = 'https://www.bing.com/search') => ({ url, statusCode, body: { kind: 'html', content }, truncated: false })
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A provider over recorded fakes; `keys` is the whole credential store, `fetch` answers by URL. */
function harness({ route, keys = {}, fetch, webFetch, token, now, config } = {}) {
  const calls = { fetch: [], webFetch: [], keys: [] }
  const provider = createAutoSearchProvider({
    route: () => route,
    resolveKey: async (ref) => { calls.keys.push(ref); return keys[ref] },
    resolveAccountToken: async () => token,
    fetch: async (url, init) => { calls.fetch.push({ url, init }); return fetch ? fetch(url, init) : json({}, 500) },
    webFetch: async (request, signal) => { calls.webFetch.push(request.url); return webFetch ? webFetch(request, signal) : page(fixture('bing.html')) },
    ...now ? { now } : {},
  }, config)
  return { provider, calls }
}
const urls = calls => calls.fetch.map(call => call.url)

const KIMI = { provider: 'moonshotai-cn', model: 'kimi-k3', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }
// A host this plugin has never heard of, whose protocol the route does not say.
const ACME = { provider: 'acme', model: 'acme-1', baseURL: 'https://llm.acme.example/v1', apiKeyEnv: 'ACME_KEY' }
const MESSAGES_HIT = { content: [
  { type: 'server_tool_use', name: 'web_search' },
  { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://m.example/', title: 'M' }] },
] }
const KIMI_HIT = { search_results: [{ title: 'A', url: 'https://a.example/', snippet: 'alpha', date: '2026-10-01' }] }

// ---------------------------------------------------------------------------
// Route → what to try

test('planNative tries the standard search tool of the route protocol, on the route base', () => {
  const plan = route => { const p = planNative({ provider: 'r', model: 'm', ...route }); return p.reason ?? p.candidates.map(c => `${c.id} ${c.url}`) }
  assert.deepEqual(plan({ api: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic' }), ['messages https://api.deepseek.com/anthropic/v1/messages'])
  assert.deepEqual(plan({ api: 'anthropic-messages', baseURL: 'https://api.kimi.com/coding' }), ['messages https://api.kimi.com/coding/v1/messages'])
  assert.deepEqual(plan({ api: 'anthropic-messages', baseURL: 'https://gateway.example/v1/' }), ['messages https://gateway.example/v1/messages'])
  assert.deepEqual(plan({ api: 'openai-responses', baseURL: 'https://api.openai.com/v1' }), ['responses https://api.openai.com/v1/responses'])
  assert.deepEqual(plan({ api: 'google-generative-ai', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' }),
    ['gemini https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'])
  assert.deepEqual(plan({ api: 'openai-completions', baseURL: 'https://api.together.ai/v1' }),
    ['responses https://api.together.ai/v1/responses', 'messages https://api.together.ai/v1/messages'])
  assert.deepEqual(plan({ baseURL: 'http://127.0.0.1:8795' }), ['responses http://127.0.0.1:8795/responses', 'messages http://127.0.0.1:8795/v1/messages'])
})

test('planNative puts search APIs declared for the route host first, on the route origin', () => {
  const plan = route => planNative({ provider: 'r', model: 'm', api: 'openai-completions', ...route }).candidates.map(c => `${c.id} ${c.url}`)
  assert.deepEqual(plan({ baseURL: 'https://ollama.com/v1' }).slice(0, 1), ['ollama https://ollama.com/api/web_search'])
  assert.deepEqual(plan({ baseURL: 'https://api.moonshot.ai/v1' }).slice(0, 1), ['kimi https://api.moonshot.ai/v1/tools/search'])
  assert.deepEqual(plan({ baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' }).slice(0, 1), ['zhipu https://open.bigmodel.cn/api/paas/v4/web_search'])
  assert.deepEqual(plan({ baseURL: 'https://token-plan-cn.xiaomimimo.com/v1' }).slice(0, 1), ['mimo https://token-plan-cn.xiaomimimo.com/v1/chat/completions'])
  // A local Ollama is not ollama.com: no declared API, only the protocol.
  assert.deepEqual(plan({ baseURL: 'http://localhost:11434/v1' }), ['responses http://localhost:11434/v1/responses', 'messages http://localhost:11434/v1/messages'])
  // A path that would move the key to another origin is never planned.
  const hostile = ['@evil.example/steal', '.evil.example/steal', ':8443/steal'].map(path => ({ id: 'evil', hosts: ['api.acme.example'], path, body: { q: '$query' } }))
  assert.deepEqual(planNative({ provider: 'r', model: 'm', api: 'openai-responses', baseURL: 'https://api.acme.example/v1' }, hostile).candidates.map(c => c.url), ['https://api.acme.example/v1/responses'])
})

test('planNative explains when there is nothing to try', () => {
  assert.match(planNative({ provider: 'r', model: 'm' }).reason, /no known endpoint/)
  assert.match(planNative({ provider: 'r', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com' }).reason, /no current model/)
  assert.match(planNative({ provider: 'r', model: 'm', api: 'bedrock-converse-stream', baseURL: 'https://bedrock.example' }).reason,
    /speaks bedrock-converse-stream, which has no standard search tool, and bedrock\.example declares no search API/)
  // Search APIs that need no model still run without one.
  assert.deepEqual(planNative({ provider: 'r', baseURL: 'https://api.moonshot.cn/v1', api: 'openai-completions' }).candidates.map(c => c.id), ['kimi'])
  assert.deepEqual(planNative({ provider: 'r', baseURL: 'https://api.xiaomimimo.com/v1', api: 'openai-completions' }).candidates, [])
})

test('routeOf reads the asking Session route: protocol, endpoint, key name, and headers', () => {
  const settings = [
    { ns: 'llm-pi-ai', value: { providers: { mimo: { api: 'openai-completions', apiKeyEnv: 'MIMO_KEY', baseURL: 'https://token-plan-cn.xiaomimimo.com/v1', headers: { 'x-team': 'bots', bad: 1 } } } } },
    { ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  ]
  const directory = [
    { provider: 'mimo', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'mimo'] },
    { provider: 'moonshotai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'moonshotai'] },
    { provider: 'deepseek-official', settingsNs: 'llm-deepseek-api-key', settingsPath: [] },
  ]
  const ctxFor = (provider, env = {}) => ({
    get: name => ({
      agents: { currentInitiator: () => ({ session: { requestContext: () => ({ provider, model: 'x' }) } }) },
      llm: { listConfigurableProviders: () => directory },
      settings: { describe: () => settings },
      launchEnvironment: { get: key => (env[key] === undefined ? undefined : { value: env[key] }) },
    })[name],
  })
  assert.deepEqual(routeOf(ctxFor('mimo')), {
    provider: 'mimo', model: 'x', api: 'openai-completions', baseURL: 'https://token-plan-cn.xiaomimimo.com/v1', apiKeyEnv: 'MIMO_KEY', account: false, headers: { 'x-team': 'bots' },
  })
  assert.deepEqual(routeOf(ctxFor('moonshotai')), {
    provider: 'moonshotai', model: 'x', api: 'openai-completions', baseURL: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY', account: false, headers: {},
  })
  assert.equal(routeOf(ctxFor('deepseek-official', { DEEPSEEK_BASE_URL: 'http://127.0.0.1:8795' })).baseURL, 'http://127.0.0.1:8795')
  assert.equal(routeOf(ctxFor('deepseek-official')).api, 'anthropic-messages')
  assert.deepEqual(routeOf(ctxFor('deepseek-account')), {
    provider: 'deepseek-account', model: 'x', api: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: undefined, account: true, headers: {},
  })
  assert.equal(routeOf(ctxFor('openrouter')).api, undefined)
  assert.equal(routeOf({ get: () => undefined }), undefined)
})

// ---------------------------------------------------------------------------
// Native search: own key, own origin, found by trying

test('a host this plugin has never heard of gets native search through its protocol', async () => {
  const { provider, calls } = harness({
    route: ACME,
    keys: { ACME_KEY: 'sk-acme', DEEPSEEK_API_KEY: 'sk-other' },
    fetch: url => (url.endsWith('/v1/messages') ? json(MESSAGES_HIT) : json({ error: { message: 'Not Found' } }, 404)),
  })
  const first = await provider.search({ query: 'acme news' })
  assert.deepEqual(first.sources, [{ url: 'https://m.example/', title: 'M' }])
  assert.match(first.content, /native search of this conversation's model route "acme": Anthropic Messages web_search tool \(llm\.acme\.example\/v1\/messages\), billed to the API key ACME_KEY/)
  assert.deepEqual(urls(calls), ['https://llm.acme.example/v1/responses', 'https://llm.acme.example/v1/messages'])
  const { init } = calls.fetch[1]
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers['x-api-key'], 'sk-acme')
  assert.equal(init.headers.authorization, 'Bearer sk-acme')
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'acme-1')
  assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }])
  assert.deepEqual(calls.keys, ['ACME_KEY'])
  assert.deepEqual(calls.webFetch, [])
  // What worked is tried first; what was absent is not asked again.
  await provider.search({ query: 'acme again' })
  assert.deepEqual(urls(calls).slice(2), ['https://llm.acme.example/v1/messages'])
})

test('a declared search API answers without a model call and is labeled with the route key', async () => {
  const { provider, calls } = harness({ route: KIMI, keys: { MOONSHOT_API_KEY: 'sk-kimi' }, fetch: () => json(KIMI_HIT) })
  const result = await provider.search({ query: '月之暗面', maxResults: 8 })
  assert.deepEqual(result.sources, [{ url: 'https://a.example/', title: 'A', snippet: 'alpha', publishedAt: '2026-10-01' }])
  assert.match(result.content, /route "moonshotai-cn": Kimi search API \(api\.moonshot\.cn\/v1\/tools\/search\), billed to the API key MOONSHOT_API_KEY/)
  assert.deepEqual(urls(calls), ['https://api.moonshot.cn/v1/tools/search'])
  assert.equal(calls.fetch[0].init.headers.authorization, 'Bearer sk-kimi')
  assert.deepEqual(JSON.parse(calls.fetch[0].init.body), { text_query: '月之暗面', limit: 8, timeout_seconds: 30 })
})

test('a search API declared in config works for a new host, before the built-in ones', async () => {
  const config = { searchApis: [{ id: 'acme', name: 'Acme search', hosts: ['*.acme.example'], path: '/search/v2', auth: ['x-api-key'], maxResults: 3, body: { q: '$query', n: '$maxResults', opts: ['$model'] } }] }
  const { provider, calls } = harness({
    route: ACME, keys: { ACME_KEY: 'sk-acme' }, config,
    fetch: () => json({ data: { hits: [{ link: 'https://h.example/', name: 'H', description: 'hit', icon: { url: 'https://h.example/icon.png' } }] } }),
  })
  const result = await provider.search({ query: 'q', maxResults: 9 })
  assert.deepEqual(result.sources, [{ url: 'https://h.example/', title: 'H', snippet: 'hit' }])
  assert.deepEqual(urls(calls), ['https://llm.acme.example/search/v2'])
  assert.equal(calls.fetch[0].init.headers['x-api-key'], 'sk-acme')
  assert.equal(calls.fetch[0].init.headers.authorization, undefined)
  assert.deepEqual(JSON.parse(calls.fetch[0].init.body), { q: 'q', n: 3, opts: ['acme-1'] })
  assert.equal(resolveConfig(config).searchApis.length, SEARCH_APIS.length + 1)
})

test('MiMo searches through its declared plugin request, with the route model and both key headers', async () => {
  const { provider, calls } = harness({
    route: { provider: 'xiaomi', model: 'mimo-v2.6-flash', api: 'openai-completions', baseURL: 'https://api.xiaomimimo.com/v1', apiKeyEnv: 'XIAOMI_API_KEY' },
    keys: { XIAOMI_API_KEY: 'sk-mimo' },
    fetch: () => json({ choices: [{ message: { content: 'answer', annotations: [{ type: 'url_citation', url: 'https://www.weather.com.cn/weather/101200101.shtml', title: '武汉天气预报', summary: ' 武汉天气预报，及时准确 ', site_name: '中国天气网', publish_time: '2026-09-21T08:32:25.0000000' }] } }] }),
  })
  const result = await provider.search({ query: '武汉天气', maxResults: 8 })
  assert.deepEqual(result.sources, [{ url: 'https://www.weather.com.cn/weather/101200101.shtml', title: '武汉天气预报', snippet: '武汉天气预报，及时准确', publishedAt: '2026-09-21T08:32:25.0000000' }])
  const { url, init } = calls.fetch[0]
  assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(init.headers['api-key'], 'sk-mimo')
  assert.equal(init.headers.authorization, 'Bearer sk-mimo')
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'mimo-v2.6-flash')
  assert.deepEqual(body.tools, [{ type: 'web_search', force_search: true, max_keyword: 1, limit: 5 }])
  assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('Zhipu queries are cut to the 70 characters its API accepts', async () => {
  const { provider, calls } = harness({
    route: { provider: 'zai-coding-cn', model: 'glm-5', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZAI_CODING_CN_API_KEY' },
    keys: { ZAI_CODING_CN_API_KEY: 'k' },
    fetch: () => json({ search_result: [{ title: 'Z', link: 'https://z.example/', content: 'zeta', publish_date: '2026-10-01', media: 'Z media' }] }),
  })
  const result = await provider.search({ query: '搜'.repeat(90) })
  assert.deepEqual(result.sources, [{ url: 'https://z.example/', title: 'Z', snippet: 'zeta', publishedAt: '2026-10-01' }])
  assert.equal(JSON.parse(calls.fetch[0].init.body).search_query, '搜'.repeat(70))
})

test('a route without its own key never borrows another one and falls back', async () => {
  const { provider, calls } = harness({ route: KIMI, keys: { DEEPSEEK_API_KEY: 'sk-deepseek', OPENAI_API_KEY: 'sk-openai' } })
  const result = await provider.search({ query: 'deepseek harness', maxResults: 8 })
  assert.deepEqual(calls.keys, ['MOONSHOT_API_KEY'])
  assert.equal(calls.fetch.length, 0)
  assert.equal(result.sources[0].url, 'https://github.com/deepseek-ai/deepseek-harness/tree/master')
  assert.match(result.content, /keyless fallback, parsed from the public Bing results page at www\.bing\.com/)
  assert.match(result.content, /route "moonshotai-cn" could not search natively: no API key is stored for MOONSHOT_API_KEY/)
})

test('a DeepSeek account route sends only the account token, with the Session model', async () => {
  const { provider, calls } = harness({
    route: { provider: 'deepseek-account', model: 'deepseek-v4-pro', api: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic', account: true, headers: {} },
    keys: { DEEPSEEK_API_KEY: 'sk-should-not-be-used' },
    token: 'acct-token',
    fetch: () => json(MESSAGES_HIT),
  })
  const result = await provider.search({ query: 'q' })
  assert.deepEqual(calls.keys, [])
  const { url, init } = calls.fetch[0]
  assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(init.headers['x-dsh-auth-token'], 'acct-token')
  assert.equal(init.headers['x-api-key'], undefined)
  assert.equal(init.headers.authorization, undefined)
  assert.equal(JSON.parse(init.body).model, 'deepseek-v4-pro')
  assert.match(result.content, /billed to the DeepSeek account sign-in/)
})

test('profile headers go with the request, but cannot replace the credential', async () => {
  const { calls, provider } = harness({
    route: { ...ACME, api: 'anthropic-messages', headers: { 'x-team': 'bots', 'x-api-key': 'spoofed' } },
    keys: { ACME_KEY: 'sk-acme' },
    fetch: () => json(MESSAGES_HIT),
  })
  await provider.search({ query: 'q' })
  assert.equal(calls.fetch[0].init.headers['x-team'], 'bots')
  assert.equal(calls.fetch[0].init.headers['x-api-key'], 'sk-acme')
})

test('credential-bearing native requests do not follow redirects', async (t) => {
  let targetHits = 0
  const target = createServer((_req, res) => { targetHits += 1; res.end('{}') })
  const origin = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/steal` }); res.end() })
  await new Promise(done => target.listen(0, '127.0.0.1', done))
  await new Promise(done => origin.listen(0, '127.0.0.1', done))
  t.after(() => { target.close(); origin.close() })
  const { provider } = harness({
    route: KIMI,
    keys: { MOONSHOT_API_KEY: 'sk-secret' },
    // The endpoint URLs are real; only the socket is pointed at the local redirecting server.
    fetch: (url, init) => fetch(url.replace('https://api.moonshot.cn', `http://127.0.0.1:${origin.address().port}`), init),
  })
  const result = await provider.search({ query: 'q' })
  assert.equal(targetHits, 0)
  assert.match(result.content, /Kimi search API \(api\.moonshot\.cn\/v1\/tools\/search\): request failed: .*redirect/i)
})

// ---------------------------------------------------------------------------
// Outcome memory

test('each outcome keeps its endpoint from being retried for its own time', async () => {
  const cases = [
    ['HTTP 404', () => json({ error: { message: 'Not Found' } }, 404), 24 * HOUR],
    ['HTTP 405', () => json({}, 405), 24 * HOUR],
    ['HTTP 400', () => json({ error: { message: 'web search tool found in the request body, but webSearchEnabled is false' } }, 400), 30 * MINUTE],
    ['HTTP 422', () => json({}, 422), 30 * MINUTE],
    ['HTTP 401', () => json({ error: { message: 'Invalid Authentication' } }, 401), 30 * MINUTE],
    ['HTTP 402', () => json({}, 402), 30 * MINUTE],
    ['answered without running a search', () => json({ content: [{ type: 'text', text: 'From memory, the answer is…' }], stop_reason: 'end_turn' }), 6 * HOUR],
  ]
  for (const [label, answer, ttl] of cases) {
    let clock = 0
    const { provider, calls } = harness({ route: { ...ACME, api: 'anthropic-messages' }, keys: { ACME_KEY: 'k' }, fetch: answer, now: () => clock })
    const first = await provider.search({ query: 'q' })
    assert.ok(first.content.includes(label), `${label}: ${first.content}`)
    clock += ttl - MINUTE
    const second = await provider.search({ query: 'q' })
    assert.match(second.content, /not retried for 1 min/, label)
    assert.equal(calls.fetch.length, 1, label)
    clock += 2 * MINUTE
    await provider.search({ query: 'q' })
    assert.equal(calls.fetch.length, 2, label)
  }
})

test('server errors, rate limits, timeouts, and cut-off answers are not remembered', async () => {
  for (const answer of [() => json({}, 503), () => json({}, 429), () => json({ content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' })]) {
    const { provider, calls } = harness({ route: { ...ACME, api: 'anthropic-messages' }, keys: { ACME_KEY: 'k' }, fetch: answer })
    await provider.search({ query: 'q' })
    await provider.search({ query: 'q' })
    assert.equal(calls.fetch.length, 2)
  }
  const cut = harness({ route: { ...ACME, api: 'anthropic-messages' }, keys: { ACME_KEY: 'k' }, fetch: () => json({ content: [], stop_reason: 'max_tokens' }) })
  assert.match((await cut.provider.search({ query: 'q' })).content, /stopped at the output cap before searching/)

  const slow = harness({
    route: KIMI, keys: { MOONSHOT_API_KEY: 'k' }, config: { nativeTimeoutMs: 1000 },
    fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  })
  const result = await slow.provider.search({ query: 'q' })
  assert.match(result.content, /Kimi search API \(api\.moonshot\.cn\/v1\/tools\/search\): timed out after 1s; .*skipped, out of time/)
  assert.equal(slow.calls.fetch.length, 1)
})

test('a search that ran but found nothing stops there instead of paying for the next endpoint', async () => {
  const { provider, calls } = harness({ route: KIMI, keys: { MOONSHOT_API_KEY: 'k' }, fetch: () => json({ search_results: [] }) })
  const result = await provider.search({ query: 'q' })
  assert.equal(calls.fetch.length, 1)
  assert.match(result.content, /Kimi search API .*: returned no results/)
})

test('remembered endpoints are skipped without reading the key', async () => {
  let clock = 0
  const { provider, calls } = harness({ route: { ...ACME, api: 'anthropic-messages' }, keys: { ACME_KEY: 'k' }, fetch: () => json({}, 404), now: () => clock })
  await provider.search({ query: 'q' })
  clock += MINUTE
  await provider.search({ query: 'q' })
  assert.deepEqual(calls.keys, ['ACME_KEY'])
})

// ---------------------------------------------------------------------------
// Fallback and final failure

test('the fallback follows a Bing regional redirect once, and only to bing.com', async () => {
  const redirect = origin => Object.assign(new Error(`cross-origin redirect to ${origin} is not followed automatically; retry against that URL directly`), { code: 'WEB_REDIRECT_BLOCKED' })
  const regional = harness({
    route: undefined,
    webFetch: ({ url }) => {
      if (url.startsWith('https://www.bing.com/')) throw redirect('https://cn.bing.com')
      return page(fixture('bing-zh.html'), 200, url)
    },
  })
  const result = await regional.provider.search({ query: '上海' })
  assert.deepEqual(regional.calls.webFetch, ['https://www.bing.com/search?q=%E4%B8%8A%E6%B5%B7', 'https://cn.bing.com/search?q=%E4%B8%8A%E6%B5%B7'])
  assert.equal(result.sources[0].title, '上海市 - 维基百科，自由的百科全书')
  assert.match(result.content, /public Bing results page at cn\.bing\.com/)

  const elsewhere = harness({
    route: undefined,
    webFetch: ({ url }) => {
      if (url.startsWith('https://www.bing.com/')) throw redirect('https://bing.com.evil.example')
      return page(fixture('duckduckgo.html'), 200, url)
    },
  })
  const other = await elsewhere.provider.search({ query: 'deepseek harness' })
  assert.deepEqual(elsewhere.calls.webFetch, ['https://www.bing.com/search?q=deepseek%20harness', 'https://html.duckduckgo.com/html/?q=deepseek%20harness'])
  assert.match(other.content, /public DuckDuckGo results page at html\.duckduckgo\.com/)
  assert.match(other.content, /no conversation model route is known/)
})

test('the fallback walks engines in order and reports each failure', async () => {
  const { provider, calls } = harness({
    route: undefined,
    webFetch: ({ url }) => (url.startsWith('https://www.bing.com/') ? page('<html><body>Please solve this challenge</body></html>') : page(fixture('duckduckgo.html'), 200, url)),
  })
  const result = await provider.search({ query: 'deepseek harness' })
  assert.deepEqual(calls.webFetch, ['https://www.bing.com/search?q=deepseek%20harness', 'https://html.duckduckgo.com/html/?q=deepseek%20harness'])
  assert.equal(result.sources.length, 2)
})

test('when every path fails the error forbids guessing', async () => {
  const { provider } = harness({
    route: KIMI,
    keys: { MOONSHOT_API_KEY: 'k' },
    fetch: () => json({ error: { message: 'Invalid Authentication' } }, 401),
    webFetch: ({ url }) => (url.includes('duckduckgo') ? page('<form id="challenge-form">bots use DuckDuckGo too</form>', 202) : page('', 429)),
  })
  await assert.rejects(provider.search({ query: 'q' }), (error) => {
    assert.ok(error instanceof HarnessError)
    assert.equal(error.code, 'WEB_SEARCH_UNAVAILABLE')
    assert.match(error.message, /Native search: route "moonshotai-cn": Kimi search API \(api\.moonshot\.cn\/v1\/tools\/search\): HTTP 401: Invalid Authentication; OpenAI Responses web_search tool/)
    assert.match(error.message, /Keyless fallback: www\.bing\.com: HTTP 429; html\.duckduckgo\.com: HTTP 202\./)
    assert.match(error.message, /Do not guess URLs/)
    assert.match(error.message, /browser tool/)
    return true
  })
})

test('native off means no key is read and no endpoint is called', async () => {
  const { provider, calls } = harness({ route: KIMI, keys: { MOONSHOT_API_KEY: 'k' }, config: { native: false } })
  const result = await provider.search({ query: 'q' })
  assert.deepEqual(calls.keys, [])
  assert.equal(calls.fetch.length, 0)
  assert.match(result.content, /native search is turned off/)
})

test('cancellation surfaces as WEB_ABORTED, not as a fallback', async () => {
  const controller = new AbortController()
  const { provider, calls } = harness({
    route: KIMI, keys: { MOONSHOT_API_KEY: 'k' },
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
      controller.abort()
    }),
  })
  await assert.rejects(provider.search({ query: 'q' }, controller.signal), error => error.code === 'WEB_ABORTED')
  assert.deepEqual(calls.webFetch, [])
})

test('config rejects unknown engines, tiny timeouts, and search APIs that could leave the route', () => {
  assert.deepEqual(resolveConfig().engines, ['bing', 'duckduckgo'])
  assert.throws(() => resolveConfig({ engines: ['google'] }), /engines must be a list of bing, duckduckgo/)
  assert.throws(() => resolveConfig({ fallbackTimeoutMs: 10 }), /fallbackTimeoutMs must be at least 1000/)
  assert.deepEqual(resolveConfig({ engines: ['duckduckgo'] }).engines, ['duckduckgo'])
  const api = { id: 'x', hosts: ['api.x.example'], path: '/search', body: { q: '$query' } }
  assert.doesNotThrow(() => resolveConfig({ searchApis: [api] }))
  assert.throws(() => resolveConfig({ searchApis: [{ ...api, path: '//evil.example/x' }] }), /path must be a path on the route's host/)
  assert.throws(() => resolveConfig({ searchApis: [{ ...api, path: 'https://evil.example/x' }] }), /path must be a path/)
  assert.throws(() => resolveConfig({ searchApis: [{ ...api, hosts: ['https://api.x.example'] }] }), /hosts must be a list of host names/)
  assert.throws(() => resolveConfig({ searchApis: [{ ...api, auth: ['cookie'] }] }), /auth must be a list of bearer, x-api-key, api-key/)
  assert.throws(() => resolveConfig({ searchApis: [{ ...api, id: '' }] }), /needs an id/)
  assert.throws(() => resolveConfig({ searchApis: {} }), /searchApis must be a list/)
})

// ---------------------------------------------------------------------------
// Parsers and response readers

test('parseBing reads real result pages and decodes Bing redirect links', () => {
  const en = parseBing(fixture('bing.html'))
  assert.equal(en.sources.length, 4)
  assert.deepEqual(en.sources[1], {
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases',
    title: 'Releases · deepseek-ai/deepseek-harness - GitHub',
    snippet: 'DeepSeek Harness: Everything is a Plugin. Contribute to deepseek-ai/deepseek-harness development by creating an account on …',
  })
  const zh = parseBing(fixture('bing-zh.html'))
  assert.equal(zh.sources[0].title, '上海市 - 维基百科，自由的百科全书')
  assert.ok(zh.sources.every(source => !new URL(source.url).hostname.endsWith('bing.com')))
  assert.deepEqual(parseBing('<html><body>captcha</body></html>'), { error: 'not a results page (bot check or changed layout)' })
  assert.deepEqual(parseBing('<ol id="b_results"><li class="b_no"><h1>No results</h1></li></ol>'), { sources: [] })
})

test('decodeBingUrl keeps direct links and drops undecodable Bing links', () => {
  const encoded = `a1${Buffer.from('https://example.com/a?b=c').toString('base64url')}`
  assert.equal(decodeBingUrl(`https://www.bing.com/ck/a?!&&p=x&u=${encoded}&ntb=1`), 'https://example.com/a?b=c')
  assert.equal(decodeBingUrl('https://example.org/x'), 'https://example.org/x')
  assert.equal(decodeBingUrl('https://www.bing.com/videos/search?q=x'), undefined)
  assert.equal(decodeBingUrl('/search?q=x'), undefined)
  assert.equal(decodeBingUrl(`https://www.bing.com/ck/a?u=a1${Buffer.from('javascript:alert(1)').toString('base64url')}`), undefined)
})

test('parseDuckDuckGo skips ads and recognizes the bot check', () => {
  const { sources } = parseDuckDuckGo(fixture('duckduckgo.html'))
  assert.deepEqual(sources, [
    { url: 'https://github.com/deepseek-ai/deepseek-harness', title: 'DeepSeek Harness · GitHub', snippet: 'Everything is a plugin: an agent harness & runtime.' },
    { url: 'https://api-docs.deepseek.com/zh-cn/', title: 'DeepSeek API 文档', snippet: 'DeepSeek API 使用与 OpenAI/Anthropic 兼容的格式…' },
  ])
  assert.deepEqual(parseDuckDuckGo('<p>Unfortunately, bots use DuckDuckGo too.</p>'), { error: 'bot check page' })
})

test('protocol readers take only structured sources and say whether a search ran', () => {
  assert.deepEqual(readMessages({
    content: [
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'web_search_tool_result', content: [
        { type: 'web_search_result', url: 'https://a.example/', title: 'A', page_age: '2 days ago' },
        { type: 'web_search_result', url: 'https://a.example/', title: 'A again' },
        { type: 'web_search_result', url: 'ftp://bad.example/' },
      ] },
      { type: 'text', text: 'The model says https://made-up.example/ is relevant.', citations: [{ url: 'https://a.example/', cited_text: 'quoted excerpt' }] },
    ],
    stop_reason: 'end_turn',
  }), { ran: true, cut: false, sources: [{ url: 'https://a.example/', title: 'A', snippet: 'quoted excerpt', publishedAt: '2 days ago' }] })
  assert.deepEqual(readMessages({ content: [{ type: 'text', text: 'I think the answer is…' }] }), { ran: false, cut: false, sources: [] })
  assert.match(readMessages({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }] }).error, /max_uses_exceeded/)

  assert.deepEqual(readResponses({
    output: [
      { type: 'web_search_call', action: { sources: [{ type: 'url', url: 'https://o.example/' }] } },
      { type: 'message', content: [{ type: 'output_text', text: '…', annotations: [{ type: 'url_citation', url: 'https://o.example/', title: 'O' }, { type: 'url_citation', url: 'https://p.example/', title: 'P' }] }] },
    ],
  }).sources, [{ url: 'https://o.example/', title: 'O' }, { url: 'https://p.example/', title: 'P' }])
  assert.deepEqual(readResponses({ output: [{ type: 'message', content: [] }], citations: ['https://x.example/'] }).sources, [{ url: 'https://x.example/' }])
  assert.equal(readResponses({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'no search' }] }] }).ran, false)
  assert.equal(readResponses({ status: 'incomplete', output: [] }).cut, true)

  assert.deepEqual(readGemini({ candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'g.example' } }] } }] }).sources,
    [{ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'g.example' }])
  assert.equal(readGemini({ candidates: [{ content: {} }] }).ran, false)
  assert.equal(readGemini({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).cut, true)
})

test('declared search API responses are read by shape, skipping media links and echoed tools', () => {
  assert.deepEqual(findSources({ results: [{ title: 'O', url: 'https://ollama.example/', content: 'page text' }] }), [{ url: 'https://ollama.example/', title: 'O', snippet: 'page text' }])
  assert.deepEqual(findSources({
    images: [{ url: 'https://img.example/a.png' }],
    tools: [{ type: 'web_search', url: 'https://echo.example/' }],
    items: [{ link: 'https://l.example/', site_name: 'L', thumbnail: { url: 'https://img.example/t.png' } }],
  }), [{ url: 'https://l.example/', title: 'L' }])
  assert.deepEqual(readDeclared({ search_results: [] }), { ran: true, sources: [] })
  assert.deepEqual(readDeclared({ results: [] }), { ran: true, sources: [] })
  assert.deepEqual(readDeclared({ choices: [{ message: { content: 'see https://a.example/' } }] }), { ran: false, sources: [] })
})
