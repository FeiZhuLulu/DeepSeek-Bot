// Run the unpackaged dsh Desktop shell on Linux for DS Bot screenshots.
// dsh's own `dev:desktop` rejects Linux targets, so this mirrors apps/desktop/scripts/dev.ts
// with a linux-x64 primary runtime and keeps every generated file outside the dsh checkout.
// Run with dsh's tsx: <dsh>/node_modules/.bin/tsx launch.mts
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') throw new Error(`desktop-linux: ${name} is required`)
  return value
}

const REPO = resolve(env('DSH_REPO'))
const HOME = resolve(env('DSH_HOME'))
const ELECTRON = resolve(env('ELECTRON_BIN'))
const CACHE = resolve(env('DSB_DESKTOP_CACHE'))
const APP_ROOT = join(REPO, 'apps', 'desktop')
const PROJECT = join(HOME, 'desktop-project')
const USER_DATA = join(HOME, 'electron-user-data')
const RUNTIME = join(CACHE, 'runtime-linux-x64')

if (!/\/\.dsh-test-[\w-]+$/.test(HOME)) throw new Error(`desktop-linux: refusing non-test home ${HOME}`)

const { DESKTOP_HOST_PROTOCOL_VERSION } = await import(join(APP_ROOT, 'src', 'host-protocol.ts'))
const { prepareDevelopmentProject } = await import(join(APP_ROOT, 'scripts', 'development-project.ts'))
const { DESKTOP_RUNTIME_FILE } = await import(join(APP_ROOT, 'src', 'runtime-tree.ts'))
const { preparePrimaryRuntime } = await import(join(REPO, 'scripts', 'primary-runtime', 'prepare.ts'))

const version = (path: string): string => (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
const desktopVersion = version(join(APP_ROOT, 'package.json'))
const release = {
  schemaVersion: 1,
  version: desktopVersion,
  hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
  nodeVersion: execFileSync(ELECTRON, ['-p', 'process.versions.node'],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim(),
  pnpmVersion: version(join(APP_ROOT, 'node_modules', 'pnpm', 'package.json')),
}

mkdirSync(HOME, { recursive: true })
// The shared helper only accepts release targets; build for win-x64, then relabel the descriptor.
prepareDevelopmentProject({
  projectDir: PROJECT,
  cliDir: join(REPO, 'apps', 'cli'),
  hostDir: join(REPO, 'apps', 'desktop-host'),
  dependencyDir: join(REPO, 'node_modules', '.pnpm', 'node_modules'),
  release,
  target: 'win-x64',
})
const descriptorPath = join(PROJECT, DESKTOP_RUNTIME_FILE)
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Record<string, unknown>
writeFileSync(descriptorPath, `${JSON.stringify({ ...descriptor, platform: process.platform, arch: process.arch }, undefined, 2)}\n`)

if (!existsSync(join(RUNTIME, 'primary-runtime', 'runtime.json'))) {
  console.log('desktop-linux: preparing linux-x64 primary runtime')
  await preparePrimaryRuntime({ target: 'linux-x64', output: RUNTIME, cache: join(CACHE, 'runtime-downloads'), version: desktopVersion })
}

const ports = {
  main: env('DSH_DESKTOP_MAIN_INSPECT_PORT', '9429'),
  renderer: env('DSH_DESKTOP_RENDERER_DEBUG_PORT', '9422'),
  host: env('DSH_DESKTOP_HOST_INSPECT_PORT', '9430'),
}
const child = spawn(ELECTRON, [
  `--inspect=127.0.0.1:${ports.main}`,
  `--remote-debugging-port=${ports.renderer}`,
  `--user-data-dir=${USER_DATA}`,
  ...(process.env.DSB_ELECTRON_ARGS ?? '').split(' ').filter(Boolean),
  APP_ROOT,
], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: HOME,
    DSH_DESKTOP_DSH_DIR: PROJECT,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(RUNTIME, 'primary-runtime'),
    DSH_DESKTOP_HOST_INSPECT_PORT: ports.host,
    DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '0',
    ELECTRON_ENABLE_LOGGING: '1',
  },
})
child.once('exit', (code, signal) => {
  console.log(`desktop-linux: electron exited with ${String(code ?? signal)}`)
  process.exitCode = code ?? 1
})
