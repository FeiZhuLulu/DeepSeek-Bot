// Connectors: outside services every Bot can use. GitHub is the first one. Its tools come
// from GitHub's MCP server through DSH's own MCP client, mounted on the plugin context,
// so every Bot and Session gets them as mcp__github__<tool>.
//
// The token is the GITHUB_TOKEN secret (secrets.js keeps it, redacts it, and offers it to
// the shell). It reaches GitHub only in the MCP request headers, built here in memory,
// never written to the DSH profile. A new token is shared with no Bot's shell: the tools
// do not need it there, and a Bot that reads a planted instruction in an issue could
// send it anywhere. The Secrets page can still share it. Signing in is `signIn` alone, so a browser login can
// take its place later without touching the mount.

export const GITHUB = 'github'
export const GITHUB_SECRET = 'GITHUB_TOKEN'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const DEFAULTS = {
  url: 'https://api.githubcopilot.com/mcp/',
  api: 'https://api.github.com',
  toolsets: 'context,repos,issues,pull_requests',
}
const CHECK_TIMEOUT_MS = 15_000
const INSECURE = 'GitHub addresses must start with https://'

// Asks GitHub who the token belongs to. Any token GitHub accepts passes.
export async function signIn(token, { api = DEFAULTS.api, fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${api.replace(/\/$/, '')}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ds-bot', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach GitHub')
  }
  if (response.status === 401) throw new Error('GitHub did not accept this token')
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const user = await response.json().catch(() => ({}))
  if (typeof user?.login !== 'string') throw new Error('GitHub did not say who this token belongs to')
  return { login: user.login }
}

export function install(rt) {
  const { ctx, state } = rt
  const options = rt.config.github === false ? null : { ...DEFAULTS, ...rt.config.github }
  const insecure = options !== null && [options.url, options.api].some(address => !/^https:\/\//i.test(String(address)))
  // `token` is what the current mount was made with, so a changed secret mounts again.
  let mount = null
  let status = { state: 'off' }
  let queue = Promise.resolve()
  let stopped = false

  const unmount = async () => {
    const fiber = mount?.fiber
    mount = null
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => {})
  }

  // The MCP client wraps the server's answer (a 401, say) as the cause.
  const reason = (error) => {
    const text = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    return rt.redactSecrets(text || 'error').slice(0, 300)
  }

  async function reconcile(force) {
    const token = options !== null && !stopped ? rt.secretValue(GITHUB_SECRET) : undefined
    if (!force && mount !== null && mount.token === token) return
    await unmount()
    if (token === undefined) {
      status = { state: 'off' }
      return
    }
    if (insecure) {
      mount = { token }
      status = { state: 'error', error: INSECURE }
      return
    }
    status = { state: 'connecting' }
    const loader = ctx.get?.('loader')
    if (typeof loader?.import !== 'function' || typeof ctx.plugin !== 'function') {
      mount = { token }
      status = { state: 'error', error: 'This DSH cannot load connectors' }
      return
    }
    try {
      const exports = await loader.import(MCP_CLIENT)
      const plugin = loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      const fiber = ctx.plugin(plugin, {
        transport: 'streamable-http',
        serverName: GITHUB,
        url: options.url,
        headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': options.toolsets },
        failOnStartupError: true,
      })
      mount = { token, fiber }
      await fiber.await()
      if (mount?.fiber !== fiber) return
      status = { state: 'ready' }
    } catch (error) {
      await unmount()
      mount = { token }
      status = { state: 'error', error: reason(error) }
      rt.warn('ds-bot: GitHub connector failed: %s', status.error)
    }
  }

  // One change at a time; `force` connects again even when the token is the same.
  const sync = (force = false) => {
    queue = queue.then(() => reconcile(force)).catch(error => { rt.warn('ds-bot: connectors: %s', reason(error)) })
    return queue
  }

  const connectorsView = () => options === null ? [] : [{
    id: GITHUB,
    name: 'GitHub',
    state: status.state,
    ...(status.error !== undefined ? { error: status.error } : {}),
    account: rt.secretValue(GITHUB_SECRET) !== undefined ? state.connectors?.[GITHUB]?.login ?? null : null,
  }]

  const known = id => {
    if (options === null || id !== GITHUB) throw new Error('No such connector')
  }

  const endpoints = {
    async 'connector-connect'(body) {
      known(body.id)
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error('Paste a token first')
      if (insecure) throw new Error(INSECURE)
      await rt.loadSecrets()
      const kept = rt.secretValue(GITHUB_SECRET) !== undefined
      const { login } = await signIn(token, { api: options.api })
      await rt.secretEndpoint('secret-set', { name: GITHUB_SECRET, value: token, purpose: 'GitHub connector', ...(kept ? {} : { scope: [] }) })
      state.connectors = { ...state.connectors, [GITHUB]: { login, connectedAt: Date.now() } }
      await rt.save()
      await sync()
      return connectorsView()
    },
    async 'connector-disconnect'(body) {
      known(body.id)
      await rt.loadSecrets()
      if (rt.secretValue(GITHUB_SECRET) !== undefined) await rt.secretEndpoint('secret-delete', { name: GITHUB_SECRET })
      if (state.connectors?.[GITHUB] !== undefined) {
        delete state.connectors[GITHUB]
        await rt.save()
      }
      await sync()
      return connectorsView()
    },
    async 'connector-retry'(body) {
      known(body.id)
      await rt.loadSecrets()
      await sync(true)
      return connectorsView()
    },
  }

  const connectorEndpoint = (endpoint, body) => endpoints[endpoint](body ?? {})

  ctx.effect(() => {
    stopped = false
    void rt.loadSecrets().then(() => sync())
    return () => {
      stopped = true
      void unmount()
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, { connectorsView, connectorEndpoint, secretsChanged: () => { void sync() } })
}
