// Tests import web-search.js outside a dsh profile, so its @deepseek-ai peers resolve from the
// deepseek-harness checkout, as a profile would supply them: DSH_HARNESS, else the nearest
// deepseek-harness/ in a folder above ds-bot, else the same search from ds-bot's place in the
// main worktree (a git worktree has no checkout of its own).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = resolve(import.meta.dirname, '..')
const above = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'deepseek-harness'))) return join(dir, 'deepseek-harness')
    if (dirname(dir) === dir) return undefined
  }
}
const findHarness = () => {
  if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
  const near = above(dirname(plugin))
  if (near) return near
  const beside = resolve(plugin, '../deepseek-harness')
  try {
    const git = (...args) => execFileSync('git', ['-C', dirname(plugin), 'rev-parse', ...args], { encoding: 'utf8' }).trim()
    return above(join(dirname(git('--path-format=absolute', '--git-common-dir')), git('--show-prefix'))) ?? beside
  } catch {
    return beside
  }
}
const harness = findHarness()
// Tests that load other harness packages (jsdom) read the same checkout.
process.env.DSH_HARNESS = harness
const anchor = pathToFileURL(resolve(harness, 'packages/bundle/base/package.json')).href
const pluginUrl = `${pathToFileURL(plugin).href}/`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pluginUrl)) {
      return nextResolve(specifier, { ...context, parentURL: anchor })
    }
    return nextResolve(specifier, context)
  },
})
