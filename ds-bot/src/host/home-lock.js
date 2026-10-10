// One writer per plugin home. dsh Web and dsh Desktop share ~/.dsh, and each host keeps
// the team in memory and writes state.json whole, so two hosts at once would undo each
// other's changes. The first host to load takes `state.lock`; a second one only reads.
//
// The lock is a small JSON file (pid, host, a random token) whose mtime the holder bumps
// on a timer. It counts as gone when its process has exited (same host) or when it has
// not been bumped for `staleMs`, which also covers a reused pid after a crash. On another
// host only the age can tell, so a lock on shared storage waits out `staleMs`. The token,
// not the pid, decides ownership: a holder that finds another token has lost the lock.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

export function homeLock(path, { staleMs = 60_000, beatMs = 15_000, host = hostname(), pid = process.pid, isAlive = pidAlive, now = Date.now } = {}) {
  const token = randomUUID()
  let timer

  // undefined: no lock file; null: a file that does not parse (being written right now).
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return error?.code === 'ENOENT' ? undefined : null
    }
  }
  const age = () => {
    try { return now() - statSync(path).mtimeMs } catch { return Infinity }
  }
  const live = (holder) => {
    if (holder === undefined) return false
    if (age() >= staleMs) return false
    if (holder === null) return true
    if (holder.host !== host) return true
    // A lock this same process left (a plugin reload whose dispose never ran) is no rival.
    return holder.pid !== pid && isAlive(holder.pid)
  }
  const owns = () => read()?.token === token

  const beat = () => {
    if (!owns()) {
      stop()
      return
    }
    const time = new Date(now())
    try { utimesSync(path, time, time) } catch {}
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  // Take the lock if it is free or its holder is gone. Returns undefined when this
  // process holds it, else what the lock file says about the holder.
  function claim() {
    if (owns()) return undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(path, JSON.stringify({ pid, host, token, since: now() }), { flag: 'wx' })
        stop()
        timer = setInterval(beat, beatMs)
        timer.unref?.()
        return undefined
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const holder = read()
      if (live(holder)) return holder ?? {}
      try { unlinkSync(path) } catch {}
    }
    return read() ?? {}
  }

  function release() {
    stop()
    if (owns()) {
      try { unlinkSync(path) } catch {}
    }
  }

  return { claim, owns, release, read }
}
