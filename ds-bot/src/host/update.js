// Updates: compare this package's version with the newest release where it was
// installed from (the npm registry, or a GitHub tag for a versioned git install)
// and, when the user asks, reinstall it through DSH's plugin manager. A new version
// runs from the next DSH start. A linked or local checkout is never offered one.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
const MIRROR_REGISTRY = 'https://registry.npmmirror.com/'
// Every window that opens asks; within this long the last answer stands.
const CHECK_TTL_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 8000
// The first check waits until the host has settled its own start.
const STARTUP_DELAY_MS = 15_000
const VERSION = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.]+)?$/

/** A release version without its `v` and build metadata, or null. */
export const cleanVersion = value => VERSION.exec(String(value ?? '').trim())?.[1] ?? null

/** Whether version `a` is newer than `b` (semver order, prereleases before their release). */
export function newer(a, b) {
  const parse = (value) => {
    const [core, pre] = (cleanVersion(value) ?? '0.0.0').split(/-(.*)/s)
    return { nums: core.split('.').map(Number), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let index = 0; index < 3; index++) if (x.nums[index] !== y.nums[index]) return x.nums[index] > y.nums[index]
  if (x.pre === y.pre) return false
  if (x.pre === null) return true
  if (y.pre === null) return false
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0
}

/**
 * How the profile installed this package, from the plugin manager's `source` spec:
 * `registry` (name@range), `git` (with `owner`, `repo`, the version `ref` and the
 * other fragment parts when it pins a GitHub tag), `path` (link:, file: or a folder),
 * `tarball`, or `unknown`.
 */
export function sourceOf(spec) {
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (text === '') return { kind: 'unknown' }
  if (/^(link|file):/i.test(text) || /^([a-z]:[\\/]|[\\/]|~|\.)/i.test(text)) return { kind: 'path' }
  const github = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.*))?$/i.exec(text)
  const gitLike = /^(git\+|git:|git@|github:|gitlab:|bitbucket:)/i.test(text) || /\.git(#|$)/i.test(text)
  if (github && (gitLike || !text.startsWith('@'))) {
    const parts = (github[3] ?? '').split('&').filter(Boolean)
    const ref = parts.find(part => !part.includes(':')) ?? ''
    return {
      kind: 'git', owner: github[1], repo: github[2],
      ...(cleanVersion(ref) ? { ref } : {}),
      rest: parts.filter(part => part !== ref),
    }
  }
  if (gitLike) return { kind: 'git' }
  if (/^https?:/i.test(text)) return { kind: 'tarball' }
  return { kind: 'registry' }
}

const normalizeRegistry = url => `${String(url).trim().replace(/\/+$/, '')}/`
const encodeName = name => (name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name))
// The project page of the releases, for the "what's new" link.
const releasesUrl = () => {
  const repo = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(String(PKG.repository?.url ?? PKG.repository ?? ''))?.[1]
  return repo ? `https://github.com/${repo}/releases` : (PKG.homepage ?? null)
}

export function install(rt) {
  const { ctx, config } = rt
  const enabled = config.updateCheck !== false
  const manager = () => ctx.get?.('pluginManager')

  const status = {
    name: PKG.name, current: PKG.version, latest: null, source: 'unknown', notesUrl: releasesUrl(),
    checkedAt: 0, phase: 'idle', installed: null, error: null,
  }
  // Where the newest version was found, and the spec that installs it.
  let target = null
  let checking = null

  const view = () => ({
    name: status.name, current: status.current, latest: status.latest, source: status.source, notesUrl: status.notesUrl,
    checkedAt: status.checkedAt, phase: status.phase, installed: status.installed, error: status.error,
    available: status.phase !== 'installed' && target !== null && status.latest !== null && newer(status.latest, status.current),
  })

  const fetchJson = async (url, headers = {}) => {
    const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response.json()
  }

  // The registries the plugin manager installs from, in its order: its configured
  // first one (else pnpm's own), then the fallbacks, unless that first one is private.
  async function registryPlan() {
    if (typeof config.updateRegistry === 'string' && config.updateRegistry !== '') return [normalizeRegistry(config.updateRegistry)]
    const configured = await Promise.resolve(manager()?.registries?.()).catch(() => null)
    if (!configured) return [OFFICIAL_REGISTRY, MIRROR_REGISTRY]
    const fallbacks = (configured.fallbackRegistries ?? []).map(normalizeRegistry)
    const own = configured.resolved ? normalizeRegistry(configured.resolved) : null
    const first = configured.registry ? normalizeRegistry(configured.registry) : own ?? OFFICIAL_REGISTRY
    const isPublic = first === OFFICIAL_REGISTRY || fallbacks.includes(first)
    return isPublic ? [...new Set([first, ...fallbacks])] : [first]
  }

  async function newestFromRegistry() {
    for (const registry of await registryPlan()) {
      try {
        const version = cleanVersion((await fetchJson(`${registry}${encodeName(PKG.name)}/latest`)).version)
        if (version) return { version, spec: `${PKG.name}@${version}`, registry }
      } catch { /* unreachable, or no copy there yet: ask the next one */ }
    }
    return null
  }

  async function newestFromGitHub(source) {
    if (!source.ref) return null
    const release = await fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`, { 'user-agent': `${PKG.name}/${PKG.version}` })
    const version = cleanVersion(release?.tag_name)
    if (!version) return null
    const fragment = [release.tag_name, ...source.rest].join('&')
    return { version, spec: `github:${source.owner}/${source.repo}#${fragment}` }
  }

  // The plugin manager's `source` for this package; DSH releases before it reported
  // one leave the profile's own dependency entry to say the same.
  async function installSpec() {
    const bundles = await Promise.resolve(manager()?.listBundles?.()).catch(() => null)
    const own = Array.isArray(bundles) ? bundles.find(bundle => bundle.name === PKG.name) : undefined
    if (typeof own?.source === 'string') return own.source
    const dir = ctx.get?.('profileContext')?.dir
    if (typeof dir !== 'string') return undefined
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies?.[PKG.name]
    } catch { return undefined }
  }

  async function runCheck() {
    const source = sourceOf(await installSpec())
    status.source = source.kind
    let found = null
    try {
      if (source.kind === 'registry') found = await newestFromRegistry()
      else if (source.kind === 'git') found = await newestFromGitHub(source)
    } catch (error) {
      rt.warn('ds-bot: update check failed: %s', error?.message ?? error)
    }
    status.checkedAt = Date.now()
    // Nothing found now (a linked checkout, a moved tag, an unreachable registry)
    // retires the version a check before it found; offering it would install over
    // a source that never updates.
    if (found === null) {
      status.latest = null
      target = null
      return
    }
    status.latest = found.version
    target = newer(found.version, status.current) ? found : null
  }

  /** Ask where the package came from for its newest version; a fresh check ignores the last answer. */
  async function check({ fresh = false } = {}) {
    if (!enabled) return view()
    if (checking) return checking
    if (!fresh && Date.now() - status.checkedAt < CHECK_TTL_MS) return view()
    checking = runCheck().finally(() => { checking = null })
    await checking
    return view()
  }

  /** Start reinstalling the newest version; the answer comes back through `check`. */
  function start() {
    if (status.phase === 'installing') return view()
    if (target === null) throw new Error('No DS Bot update is available')
    const service = manager()
    if (typeof service?.installBundle !== 'function') throw new Error('The DSH plugin manager is not available in this profile')
    const chosen = target
    Object.assign(status, { phase: 'installing', error: null })
    void Promise.resolve(service.installBundle(chosen.spec, chosen.registry ? { registry: chosen.registry } : {}))
      .then((result) => {
        if (result?.error || !['applied', 'restart-required'].includes(result?.application)) {
          throw new Error(result?.error?.diagnostic ?? result?.error?.code ?? `install ${result?.application ?? 'failed'}`)
        }
        Object.assign(status, { phase: 'installed', installed: cleanVersion(result.version) ?? chosen.version })
      })
      .catch((error) => {
        rt.warn('ds-bot: update to %s failed: %s', chosen.spec, error?.message ?? error)
        Object.assign(status, { phase: 'failed', error: String(error?.message ?? error).slice(0, 600) })
      })
    return view()
  }

  if (enabled) {
    ctx.effect(() => {
      const timer = setTimeout(() => { void check() }, STARTUP_DELAY_MS)
      // A pending first check never keeps the process alive.
      timer.unref?.()
      return () => clearTimeout(timer)
    }, 'ds-bot: update check')
  }

  Object.assign(rt, { updateCheck: check, updateStart: start, updateView: view })
}
