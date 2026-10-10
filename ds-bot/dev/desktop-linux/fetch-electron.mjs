// Download the Electron build that dsh Desktop pins, for running the unpackaged shell on Linux.
// Usage: node fetch-electron.mjs <dsh-repo> <cache-dir>
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [repo, cache] = process.argv.slice(2).map(value => resolve(value))
if (!repo || !cache) throw new Error('usage: node fetch-electron.mjs <dsh-repo> <cache-dir>')
const desktop = join(repo, 'apps', 'desktop')
const require = createRequire(join(desktop, 'package.json'))
const { version } = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8'))
const target = join(cache, `electron-${version}-linux-x64`)
if (existsSync(join(target, 'electron'))) {
  console.log(target)
  process.exit(0)
}
const { downloadArtifact } = require('@electron/get')
const extract = require('extract-zip')
mkdirSync(cache, { recursive: true })
const zip = await downloadArtifact({ version, artifactName: 'electron', platform: 'linux', arch: 'x64', cacheRoot: join(cache, 'downloads') })
await extract(zip, { dir: target })
console.log(target)
