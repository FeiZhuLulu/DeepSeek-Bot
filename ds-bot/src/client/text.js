// -------------------------------------------------------------------------
// Text helpers
import { dateLocale, t } from './i18n.js'

export const MENTION_ORIGIN = 'https://bots.local/'

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Only "@Name" is a mention, the same rule the group host reads (mentionsIn): a bare
// name is ordinary text, so a Bot called "测试" leaves the word "测试" alone.
export function linkMentions(text, bots, selfId) {
  if (!text || bots.length === 0 || text.includes('```') || !text.includes('@')) return text
  // The speaker's own name takes part so that, longest first, it is never read as a
  // shorter name inside it ("@新 Bot" in "@新 Bot 2"); it then stays plain text.
  const names = bots.filter(bot => bot.name).sort((a, b) => b.name.length - a.name.length)
  if (!names.some(bot => bot.id !== selfId)) return text
  const byName = new Map(names.map(bot => [bot.name.toLowerCase(), bot]))
  // A letter, digit, "_" or "." before "@" is an address ("a@b"); a letter, digit, "_"
  // or "-" after the name means a longer word ("@Mi" in "@MiniMax").
  const pattern = new RegExp(`(\\[[^\\]]*\\]\\([^)]*\\)|\`[^\`]*\`)|(?<![A-Za-z0-9_.])@(${names.map(bot => escapeRegExp(bot.name)).join('|')})(?![A-Za-z0-9_-])`, 'gi')
  return text.replace(pattern, (match, skip, name) => {
    if (skip) return skip
    const bot = byName.get(name.toLowerCase())
    return bot && bot.id !== selfId ? `[${name}](${MENTION_ORIGIN}${bot.id})` : match
  })
}

export function mentionTarget(event) {
  const anchor = event.target instanceof Element ? event.target.closest(`a[href^="${MENTION_ORIGIN}"]`) : null
  return anchor ? anchor.getAttribute('href').slice(MENTION_ORIGIN.length) : null
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })
}
export function dayLabel(ms) {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay ? t('Today {time}', { time: clock(ms) }) : `${date.toLocaleDateString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric' })} ${clock(ms)}`
}

// A short relative stamp for list rows: "just now", "5 min", "3 h", "2 d", then a date.
export function relativeShort(ms) {
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 60_000) return t('just now')
  if (diff < 3_600_000) return t('{n} min', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('{n} h', { n: Math.floor(diff / 3_600_000) })
  if (diff < 30 * 86_400_000) return t('{n} d', { n: Math.floor(diff / 86_400_000) })
  return new Date(ms).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' })
}

export const contentText = content => (content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
export const HEADER = /^\[(Message from|Reply from|Group chat|Group post from|Bot team setup|Handoff · part|Secret card)[^\]]*\]\n?/
export const currentPart = bot => bot.sessionId ?? bot.id
// The prompts in a due scheduled task's message. DSH frames it for the model: one
// task as `reminder_prompt_json: "…"`, several as `reminders_json: [{reminder_prompt}]`.
export function reminderPrompts(text) {
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    const prompts = [...(one ? [JSON.parse(one[1])] : []), ...(batch ? JSON.parse(batch[1]).map(entry => entry.reminder_prompt) : [])]
    return prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  } catch {
    // An unreadable framing shows as the plain "Routine started" line.
    return []
  }
}
export const stripHeader = text => text.replace(HEADER, '')

// Of the Bots in a conversation, the one whose memory changed last, by the host's
// clock: changes reaching one window in the same poll share a `seen` time.
export function latestMemoryChange(news, ids) {
  const at = id => (news?.[id]?.seen ? news[id].at ?? 0 : 0)
  return ids.reduce((best, id) => (at(id) > at(best) ? id : best), ids[0] ?? null)
}

// A memory summary is "## Heading" lines, each over one paragraph; stray Markdown
// marks and list bullets are dropped.
export function summaryBlocks(text) {
  const blocks = []
  let paragraph = []
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/\*\*|__/g, '')
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'h', text: heading[1].trim() })
    } else if (line === '') {
      flush()
    } else {
      paragraph.push(line.replace(/^[-*•]\s+/, ''))
    }
  }
  flush()
  return blocks
}

export function isHiddenTurn(roster, sessionId, turn) {
  if (sessionId === undefined || turn === undefined) return false
  return (roster.exchangeTurns[sessionId] ?? []).includes(turn)
}

export const toolName = root => root.name || root.call?.name

export function toolArgs(root) {
  if (typeof root.args?.text === 'function') {
    return { text: key => root.args.text(key) ?? undefined, value: key => (typeof root.args.value === 'function' ? root.args.value(key) : undefined) }
  }
  let parsed
  const object = () => {
    if (parsed === undefined) {
      try { parsed = JSON.parse(root.argsRaw ?? root.call?.argsRaw ?? '') } catch { parsed = null }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) parsed = null
    }
    return parsed
  }
  return {
    text: (key) => { const value = object()?.[key]; return typeof value === 'string' ? value : undefined },
    value: key => object()?.[key],
  }
}

// Back-to-back Bot-to-Bot messages fold into one "N messages with" line. A
// hidden exchange turn holds a request and its reply; a visible one (a reply, or a
// request answered to the user) adds only its trigger and ends the run. Group turns
// never show in a one-to-one chat, so they do not break a run.
// `order` lists the Session's turns; `peers` maps each relayed turn to its sender's id.
// Returns null (unknown), 'folded', or { count, peerIds } for the run's first line.
export function commRunOf(order, peers, turn, hiddenTurns = []) {
  const turns = []
  for (const entry of order) {
    const peer = peers[entry]
    const hidden = hiddenTurns.includes(entry)
    if (hidden && peer === undefined) continue
    turns.push({ turn: entry, peer, hidden })
  }
  const at = turns.findIndex(entry => entry.turn === turn)
  if (at === -1 || turns[at].peer === undefined) return null
  const previous = turns[at - 1]
  if (previous?.peer !== undefined && previous.hidden) return 'folded'
  let count = 0
  const peerIds = []
  for (let index = at; index < turns.length; index += 1) {
    const entry = turns[index]
    if (entry.peer === undefined || (index > at && !turns[index - 1].hidden)) break
    count += entry.hidden ? 2 : 1
    if (!peerIds.includes(entry.peer)) peerIds.push(entry.peer)
  }
  return { count, peerIds }
}

// Latest visible line for a sidebar row; Bot-to-Bot exchange turns stay out of it.
export function previewOf(list, id, hiddenTurns = []) {
  const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
  if (!Array.isArray(outline)) return ''
  for (let index = outline.length - 1; index >= 0; index -= 1) {
    const entry = outline[index]
    if (hiddenTurns.includes(entry.turn)) continue
    const text = entry.response || entry.prompt || ''
    if (text !== '') return stripHeader(text).replace(/\s+/g, ' ').trim()
  }
  return ''
}

const formatTokens = count => (count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}K` : String(count))

// Same buckets as the shell's usage pill: every prompt-side billing bucket plus output.
export function usageOf(list, ids) {
  let input = 0
  let cacheRead = 0
  let output = 0
  for (const id of ids) {
    const usage = list.projectionsBySession?.[id]?.values?.tokenUsage
    if (!usage) continue
    input += (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    cacheRead += usage.cacheReadTokens ?? 0
    output += usage.outputTokens ?? 0
  }
  if (input + output === 0) return ''
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  return t('{tokens} tok · Cache hit {hit}%', { tokens: formatTokens(input + output), hit })
}
