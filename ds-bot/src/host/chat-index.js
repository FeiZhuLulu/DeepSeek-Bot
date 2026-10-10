// Reading a Bot's own chat: Session history pages, the SQLite FTS5 index, and the
// search, latest, and around reads behind read_own_chat.
//
// Chat index. read_own_chat searches a SQLite FTS5 table of every part of a Bot's own
// chat, ranked by BM25. The trigram tokenizer matches any run of three or more
// characters, so Chinese needs no word splitting; shorter words fall back to LIKE.
// The index is derived from the Session logs: a part catches up when it is read, an
// ended part is sealed once it is complete, and deleting the file only costs a
// rebuild. Without SQLite, read_own_chat scans the logs as before.
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ANCHOR_LINE_MAX, HISTORY_PAGE, HISTORY_PAGES_MAX, HISTORY_TIMEOUT_MS, OWN_CHAT_BRIEF, OWN_CHAT_LINE_MAX, OWN_CHAT_READ, OWN_CHAT_SEARCH } from './constants.js'
import { excerpt } from './text.js'

const INDEX_VERSION = 3
const AROUND_LINES = 6
const SEARCH_TERMS_MAX = 6
const ANY_TERM_HITS = 50
const INDEX_TIMEOUT_MS = 120_000
// A part still gets a few events (a title, a late reply) just after it ends.
const SEAL_AFTER_MS = 60_000

const likeOf = term => `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`
// Each term is a quoted FTS5 phrase when trigrams can match it, else a LIKE filter.
export function termQuery(terms, sessions, limit, hidden) {
  const long = terms.filter(term => [...term].length >= 3)
  const short = terms.filter(term => [...term].length < 3)
  const where = ['session IN (SELECT value FROM json_each(?))']
  const args = [JSON.stringify(sessions)]
  if (hidden !== undefined) {
    where.push('NOT (session = ? AND seq >= ?)')
    args.push(hidden.session, hidden.from)
  }
  if (long.length > 0) {
    where.unshift('lines MATCH ?')
    args.unshift(long.map(term => `"${term.replace(/"/g, '""')}"`).join(' '))
  }
  for (const term of short) {
    where.push("text LIKE ? ESCAPE '\\'")
    args.push(likeOf(term))
  }
  return { sql: `SELECT text, session, seq, time, who FROM lines WHERE ${where.join(' AND ')} ORDER BY ${long.length > 0 ? 'rank' : 'time DESC'} LIMIT ${limit}`, args }
}

export function install(rt) {
  const { ctx, home } = rt

  const indexPath = join(home, 'chat-index.sqlite')
  let chatIndex
  let indexOpening

  // A Session's events from newest to oldest, also for an archived part.
  async function* eventsBackwards(sessionId, signal, maxPages = HISTORY_PAGES_MAX) {
    const agent = await rt.resolveAgent(sessionId)
    const throughSeq = Number(agent.session.seq) - 1
    let beforeSeq
    for (let pages = 0; throughSeq >= 0 && pages < maxPages; pages += 1) {
      const page = await ctx.sessionController.page({
        address: { kind: 'session', sessionId },
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: HISTORY_PAGE,
      }, signal)
      const events = page.records.map(record => record.event)
      for (let index = events.length - 1; index >= 0; index -= 1) yield events[index]
      if (!page.hasMore || events.length === 0) return
      beforeSeq = events[0].seq
    }
  }

  function openIndex() {
    if (chatIndex !== undefined) return Promise.resolve(chatIndex)
    const opening = indexOpening ??= (async () => {
      let DatabaseSync
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        await mkdir(home, { recursive: true })
      } catch (error) {
        rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
        return null
      }
      // A damaged file is rebuilt from the logs once.
      for (const fresh of [false, true]) {
        try {
          if (fresh) await unlink(indexPath).catch(() => {})
          return createIndex(new DatabaseSync(indexPath))
        } catch (error) {
          if (fresh) rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
        }
      }
      return null
    })().then((index) => {
      // The plugin may have been disposed while the file opened.
      if (indexOpening !== opening) {
        index?.db.close()
        return null
      }
      return chatIndex = index
    })
    return opening
  }

  function createIndex(db) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      if (db.prepare('PRAGMA user_version').get().user_version !== INDEX_VERSION) {
        db.exec(`
          DROP TABLE IF EXISTS lines;
          DROP TABLE IF EXISTS marks;
          CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, tokenize = 'trigram');
          CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL);
          PRAGMA user_version = ${INDEX_VERSION};`)
      }
      return {
        db,
        mark: db.prepare('SELECT through, keep, sealed, turn FROM marks WHERE session = ?'),
        setMark: db.prepare('INSERT OR REPLACE INTO marks (session, through, keep, sealed, turn) VALUES (?, ?, ?, ?, ?)'),
        insert: db.prepare('INSERT INTO lines (text, session, seq, time, who) VALUES (?, ?, ?, ?, ?)'),
        before: db.prepare('SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
        from: db.prepare('SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq >= ? ORDER BY seq LIMIT ?'),
      }
    } catch (error) {
      db.close()
      throw error
    }
  }
  ctx.effect(() => () => {
    chatIndex?.db.close()
    chatIndex = undefined
    indexOpening = undefined
  }, 'ds-bot: chat index')

  // Adds what a part said since its mark. Reads of one part wait for each other, so no
  // line is added twice.
  const catchingUp = new Map()
  function catchUp(index, part) {
    const running = catchingUp.get(part.sessionId)
    if (running) return running
    const job = (async () => {
      const mark = index.mark.get(part.sessionId)
      if (mark?.sealed) return
      const through = mark?.through ?? -1
      const events = []
      for await (const event of eventsBackwards(part.sessionId, AbortSignal.timeout(INDEX_TIMEOUT_MS), Infinity)) {
        if (event.seq <= through) break
        events.push(event)
      }
      if (events.length > 0 && events.at(-1).seq !== through + 1) throw new Error(`the history of ${part.sessionId} came back with a gap`)
      events.reverse()
      if (index !== chatIndex) return
      let keep = mark ? mark.keep === 1 : false
      let turn = mark?.turn ?? -1
      const seal = part.endedAt !== undefined && Date.now() - part.endedAt > SEAL_AFTER_MS
      index.db.exec('BEGIN')
      try {
        let last = through
        for (const event of events) {
          last = event.seq
          if (event.type === 'turn/start') turn = event.seq
          const entry = rt.historyEntry(event, false)
          if (entry === undefined) continue
          if (entry.answer) {
            if (keep) index.insert.run(entry.text, part.sessionId, event.seq, event.time ?? 0, 'you')
            continue
          }
          keep = entry.keepAnswers
          if (entry.text !== '') index.insert.run(entry.text, part.sessionId, event.seq, event.time ?? 0, entry.who)
        }
        index.setMark.run(part.sessionId, last, keep ? 1 : 0, seal ? 1 : 0, turn)
        index.db.exec('COMMIT')
      } catch (error) {
        index.db.exec('ROLLBACK')
        throw error
      }
    })().finally(() => catchingUp.delete(part.sessionId))
    catchingUp.set(part.sessionId, job)
    return job
  }

  // A message's anchor: its part (once there are several) and its seq in that part.
  const anchorOf = (parts, row) => {
    const part = parts.find(item => item.sessionId === row.session)
    return `${parts.length > 1 ? `part ${part?.number ?? '?'} ` : ''}#${row.seq}`
  }
  const rowLine = (parts, row, terms = [], max = OWN_CHAT_LINE_MAX) => {
    const lower = row.text.toLowerCase()
    const wanted = terms.find(term => lower.includes(term)) ?? ''
    const text = row.who === 'user' ? `User: ${row.text}` : row.who === 'you' ? `You: ${row.text}` : row.text
    return `[${anchorOf(parts, row)} · ${rt.clock(row.time)}] ${excerpt(text, wanted, max)}`
  }

  // Every part, caught up. Asked from the current part, the turn that asks is left out
  // (`hidden`): it is in context, and its own question would match.
  async function indexedParts(botId, askingId) {
    const index = await openIndex()
    if (index === null) return { index }
    const parts = rt.partsOf(botId)
    // A part that cannot be read now is searched as far as it was indexed.
    for (const part of parts) await catchUp(index, part).catch(error => rt.warn('ds-bot: indexing %s failed: %s', part.sessionId, error))
    const turn = askingId !== undefined && askingId === parts.at(-1)?.sessionId ? index.mark.get(askingId)?.turn : undefined
    return { index, parts, hidden: turn === undefined || turn < 0 ? undefined : { session: askingId, from: turn } }
  }

  // Messages with all the words, best first; with none of them having all, those with
  // the most of them. Shown oldest first.
  async function searchOwnChat(botId, query, { askingId, limit = OWN_CHAT_SEARCH } = {}) {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS_MAX)
    const { index, parts, hidden } = await indexedParts(botId, askingId)
    if (index === null) return { lines: await scanOwnChat(botId, query, limit), every: true }
    const sessions = parts.map(part => part.sessionId)
    const run = (wanted, max) => {
      const { sql, args } = termQuery(wanted, sessions, max, hidden)
      return index.db.prepare(sql).all(...args)
    }
    const byTime = (a, b) => (a.time - b.time) || (sessions.indexOf(a.session) - sessions.indexOf(b.session)) || (a.seq - b.seq)
    let rows = run(terms, limit)
    let every = true
    if (rows.length === 0 && terms.length > 1) {
      every = false
      const found = new Map()
      for (const term of terms) {
        for (const row of run([term], ANY_TERM_HITS)) {
          const key = `${row.session}#${row.seq}`
          const hit = found.get(key) ?? { row, count: 0 }
          hit.count += 1
          found.set(key, hit)
        }
      }
      rows = [...found.values()].sort((a, b) => (b.count - a.count) || (b.row.time - a.row.time)).slice(0, limit).map(hit => hit.row)
    }
    return { lines: rows.sort(byTime).map(row => rowLine(parts, row, terms)), every }
  }

  // The latest messages across all parts, oldest first.
  async function latestOwnChat(botId, { askingId, limit = OWN_CHAT_READ } = {}) {
    const { index, parts, hidden } = await indexedParts(botId, askingId)
    if (index === null) return scanOwnChat(botId, '', limit)
    const rows = []
    for (const part of [...parts].reverse()) {
      const below = hidden?.session === part.sessionId ? hidden.from : Number.MAX_SAFE_INTEGER
      rows.push(...index.before.all(part.sessionId, below, limit - rows.length))
      if (rows.length >= limit) break
    }
    return rows.reverse().map(row => rowLine(parts, row))
  }

  // The messages around an anchor, in its part.
  async function aroundOwnChat(botId, anchor) {
    const { index, parts } = await indexedParts(botId)
    if (index === null) return { error: 'Anchors need the chat index, which is unavailable here. Search with words instead.' }
    const found = /(?:part\s*)?(\d+)?\s*#\s*(\d+)/i.exec(anchor)
    if (found === null) return { error: `"${anchor}" is not an anchor. Anchors look like "part 2 #1234", or "#1234" in the current part.` }
    const number = found[1] === undefined ? parts.length : Number(found[1])
    const part = parts[number - 1]
    if (part === undefined) return { error: `Your own chat has no part ${number}.` }
    const seq = Number(found[2])
    const rows = [...index.before.all(part.sessionId, seq, AROUND_LINES).reverse(), ...index.from.all(part.sessionId, seq, AROUND_LINES + 1)]
    return { part, exact: rows.some(row => row.seq === seq), lines: rows.map(row => rowLine(parts, row, [], row.seq === seq ? ANCHOR_LINE_MAX : OWN_CHAT_LINE_MAX)) }
  }

  // Without the index: what the user, other Bots, and the Bot itself said, across all
  // parts, oldest first, by reading the logs.
  async function scanOwnChat(botId, query, limit) {
    const wanted = query.toLowerCase()
    const parts = rt.partsOf(botId)
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const lines = []
    for (const part of [...parts].reverse()) {
      for await (const line of rt.partLines(part.sessionId, signal)) {
        if (wanted !== '' && !line.text.toLowerCase().includes(wanted)) continue
        lines.push(`[${parts.length > 1 ? `part ${part.number} · ` : ''}${rt.clock(line.time)}] ${excerpt(line.text, wanted)}`)
        if (lines.length >= limit) break
      }
      if (lines.length >= limit) break
    }
    return lines.reverse()
  }

  // The parts of a Bot's own chat, for the model: when each ran.
  const partIndex = parts => parts.map(part => `part ${part.number} (${rt.clock(part.startedAt)} – ${part.endedAt === undefined ? 'now' : rt.clock(part.endedAt)})`).join(', ')

  async function ownChatBrief(member) {
    let lines = []
    try { lines = await latestOwnChat(member.id, { limit: OWN_CHAT_BRIEF }) } catch (error) { rt.warn('ds-bot: brief for %s failed: %s', member.name, error) }
    return [
      'Your own chat with the user so far (latest messages, oldest first; private, so share only what the group needs):',
      lines.length > 0 ? lines.join('\n') : 'Nothing yet.',
      'This brief does not change. Call read_own_chat when you need something newer or older from your own chat.',
    ].join('\n')
  }

  Object.assign(rt, { eventsBackwards, searchOwnChat, latestOwnChat, aroundOwnChat, partIndex, ownChatBrief })
}
