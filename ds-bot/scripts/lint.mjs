// Lint with the oxlint that the deepseek-harness checkout installs, so ds-bot needs no
// copy of its own. The checkout is DSH_HARNESS, else beside this checkout, else beside
// the main worktree (a git worktree has no deepseek-harness of its own).
// Usage: npm run lint [-- <oxlint options>]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const plugin = resolve(import.meta.dirname, '..')
const candidates = [process.env.DSH_HARNESS, join(plugin, '..', 'deepseek-harness')]
try {
  const common = execFileSync('git', ['-C', plugin, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  candidates.push(join(dirname(common), 'deepseek-harness'))
} catch {}
const bin = candidates.filter(Boolean).map(dir => join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint')).find(existsSync)
if (!bin) {
  console.error('lint: no oxlint found; install the deepseek-harness checkout or set DSH_HARNESS')
  process.exit(2)
}
const result = spawnSync(bin, ['-c', '.oxlintrc.json', ...process.argv.slice(2), 'index.js', 'web-search.js', 'src', 'dev', 'scripts', 'test'], { cwd: plugin, stdio: 'inherit' })
process.exit(result.status ?? 1)
