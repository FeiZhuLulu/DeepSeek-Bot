import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { inkText } from './inks.js'
import { linkMentions, mentionTarget, dayLabel, contentText, stripHeader, isHiddenTurn, commRunOf, toolName, toolArgs, reminderPrompts } from './text.js'
import { SmileIcon, ReplyIcon, DotsIcon, CheckIcon, DownloadIcon, CopyIcon, MemoryIcon } from './icons.js'
import { colorOf, toolState, BotMark, RoomAvatar } from './mark.js'
import { AnsweredCell, SettledQuestion, PendingQuestion } from './questions.js'
import { SecretToolCell } from './secret-card.js'
import { dateLocale, t } from './i18n.js'
import { failureLabel } from './diagnostics.js'

// -------------------------------------------------------------------------
// Chat cells

const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

// `lead` (a sender avatar in group chats) sits beside the last bubble, in the same
// row, so it lines up with the bubble whether or not reactions hang below it.
export function Bubbles({ texts, roster, selfId, actions, streaming, sessionId, msgKey, useUi, lead }) {
  const onClick = (event) => {
    const target = mentionTarget(event)
    if (target === null) return
    event.preventDefault()
    event.stopPropagation()
    actions.openSession(target)
  }
  const reactions = useUi ? useUi(state => (msgKey ? state.reactions?.[msgKey] ?? null : null)) : null
  return h('div', { className: 'bt-astack', 'data-lead': lead ? '' : undefined, onClickCapture: onClick },
    texts.map((text, index) => {
      const key = msgKey ? `${msgKey}:${index}` : undefined
      const picked = key ? reactions?.[index] ?? [] : []
      const last = index === texts.length - 1
      const live = streaming && last
      return h('div', { key: index, className: 'bt-msg' },
        h('div', { className: 'bt-msg-line' },
          lead && last ? lead : null,
          h('div', { className: 'bt-bubble' },
            h(MarkdownText, { text: linkMentions(text, roster.bots, selfId), streaming: live, labels: mdLabels(), variant: 'compact' })),
          live ? null : h(MessageTools, { text, name: roster.byId[selfId]?.name ?? t('Bot'), sessionId, react: key ? emoji => actions.toggleReaction(msgKey, index, emoji) : undefined, actions })),
        picked.length ? h('div', { className: 'bt-reacts' }, picked.map(emoji => h('button', {
          key: emoji, type: 'button', className: 'bt-react', 'aria-label': t('Remove reaction {emoji}', { emoji }), onClick: () => actions.toggleReaction(msgKey, index, emoji),
        }, emoji))) : null)
    }))
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

// Closes a popover on a press outside the given elements or on Escape.
function useDismiss(open, close, refs) {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (refs.some(ref => ref.current?.contains(event.target))) return
      close()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
}

// The hover toolbar beside a reply bubble: Add reaction, Reply, More.
function MessageTools({ text, name, sessionId, react, actions }) {
  const [panel, setPanel] = useState(null)
  const [place, setPlace] = useState(null)
  const [copied, setCopied] = useState(false)
  const tools = useRef(null)
  const pop = useRef(null)
  const close = () => setPanel(null)
  useDismiss(panel !== null, close, [tools, pop])
  const open = (kind, event) => {
    if (panel === kind) { close(); return }
    const rect = event.currentTarget.getBoundingClientRect()
    const below = rect.bottom + 220 < window.innerHeight
    setPlace(kind === 'react'
      ? { left: rect.left + rect.width / 2, top: rect.top - 6, '--bt-origin': 'bottom center' }
      : { left: Math.min(rect.left, window.innerWidth - 208), ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4, '--bt-origin': 'bottom left' }) })
    setPanel(kind)
  }
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) })
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${name}-message.md` })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const item = (label, Icon, run) => h('button', { key: label, type: 'button', role: 'menuitem', onClick: () => { close(); run() } }, h(Icon), label)
  return h('div', { ref: tools, className: 'bt-tools', 'data-open': panel !== null || undefined },
    react ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Add reaction'), title: t('Add reaction'), 'aria-expanded': panel === 'react', onClick: event => open('react', event) }, h(SmileIcon)) : null,
    sessionId ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Reply'), title: t('Reply'), onClick: () => actions.quote(sessionId, text) }, h(ReplyIcon)) : null,
    h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('More message actions'), title: t('More'), 'aria-haspopup': 'menu', 'aria-expanded': panel === 'more', onClick: event => open('more', event) }, copied ? h(CheckIcon) : h(DotsIcon)),
    panel === 'react' ? createPortal(h('div', { ref: pop, className: 'bt-react-strip', role: 'menu', 'aria-label': t('Reactions'), style: place },
      REACTIONS.map(emoji => h('button', { key: emoji, type: 'button', role: 'menuitem', 'aria-label': emoji, onClick: () => { close(); react(emoji) } }, emoji))), document.body) : null,
    panel === 'more' ? createPortal(h('div', { ref: pop, className: 'bt-menu', role: 'menu', 'aria-label': t('Message actions'), style: place },
      item(t('Copy'), CopyIcon, copy), item(t('Download'), DownloadIcon, download)), document.body) : null)
}

// Live reasoning shows only as the activity row's phrase.
function ThinkingRow({ text, running }) {
  if (running || !text) return null
  return h('details', { className: 'bt-think' },
    h('summary', null, t('Thought it through')),
    h('div', { className: 'bt-think-text' }, text))
}

export function AssistantCell({ node, groupPart, sessionId, useRoster, useUi, actions }) {
  const roster = useRoster(value => value)
  const data = node.data
  const hidden = Boolean(roster.roomsById[sessionId]) || isHiddenTurn(roster, sessionId, data.turn)
  const texts = groupPart === 'reasoning' ? [] : data.blocks.filter(block => block.kind === 'text' && block.text.trim() !== '').map(block => block.text)
  const running = data.status === 'running'
  // A streaming reply stands in for the activity row.
  useLiveNote(actions, sessionId, `text:${node.key ?? data.seq}`, !hidden && running && texts.length > 0 ? { text: true } : null)
  if (hidden) return null
  const reasoning = groupPart === 'response' ? '' : data.blocks.filter(block => block.kind === 'reasoning').map(block => block.text).join('\n').trim()
  const thinkingLive = running && texts.length === 0 && data.blocks.some(block => block.kind === 'reasoning')
  if (texts.length === 0 && !reasoning) return null
  return h(Fragment, null,
    reasoning ? h(ThinkingRow, { text: reasoning, running: thinkingLive }) : null,
    texts.length ? h(Bubbles, { texts, roster, selfId: roster.byId[sessionId]?.id ?? sessionId, actions, streaming: running, sessionId, msgKey: `${sessionId}:${data.turn}:${node.key ?? data.seq ?? ''}`, useUi }) : null)
}

function EventLine({ prefix, bots, joiner = t('and'), onOpen }) {
  const parts = []
  parts.push(h('span', { key: 'p' }, prefix))
  bots.forEach((bot, index) => {
    if (index > 0) parts.push(h('span', { key: `j${index}` }, joiner))
    parts.push(h('button', { key: bot.id ?? index, type: 'button', onClick: () => onOpen?.(bot) },
      h(BotMark, { bot, size: 16 }), bot.name))
  })
  return h('div', { className: 'bt-event' }, parts)
}

// One Bot message inside a group chat: avatar, name (with its group role), bubble.
function GroupMessage({ bot, text, room, roster, actions, msgKey, useUi }) {
  const lead = h('button', { type: 'button', className: 'bt-lead', 'aria-label': t("Open {name}'s chat", { name: bot.name }), onClick: () => actions.openSession(bot.id) },
    h(BotMark, { bot, size: 22 }))
  return h('div', { className: 'bt-group-msg' },
    h('span', { className: 'bt-group-name', style: { color: inkText(colorOf(bot)) } }, bot.name,
      room?.admin === bot.id ? h('span', { className: 'bt-group-role' }, t('Admin')) : null),
    h(Bubbles, { texts: [text], roster, selfId: bot.id, actions, sessionId: room?.id, msgKey, useUi, lead }))
}

// A centered event line that names a group chat and opens it.
function GroupEvent({ prefix, room, name, roster, actions }) {
  return h('div', { className: 'bt-event' },
    h('span', null, prefix),
    room ? h('button', { type: 'button', onClick: () => actions.openSession(room.id) }, h(RoomAvatar, { room, roster, size: 16 }), room.name)
      : name ? h('span', null, name) : null)
}

// A change remember or forget made, which opens the memory it changed. Refusals and
// entries already saved changed nothing and show no line.
function MemoryEvent({ sessionId, scope, result, roster, actions, findBot }) {
  if (!/^(Saved to|Updated in|Removed from) /.test(result)) return null
  const self = roster.byId[sessionId]
  const team = /^(team|团队|共享)$/i.test(String(scope ?? '').trim())
  const other = team || !scope ? undefined : findBot(scope)
  const target = other && other.id !== self?.id ? other : self
  if (!target) return null
  const label = team ? t('Team memory updated') : target === self ? t('Memory updated') : t("Updated {name}'s memory", { name: target.name })
  return h('div', { className: 'bt-event' },
    h('button', { type: 'button', title: result, onClick: () => actions.openMemory(target.id) }, h(MemoryIcon), label))
}

function PartLine({ time }) {
  return h('div', { className: 'bt-part-line', role: 'separator' }, Number.isFinite(time) ? h('span', null, dayLabel(time)) : null)
}

const scrollParent = (node) => {
  for (let at = node.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at
  }
  return null
}

// The earlier parts of a Bot's own chat, above its current part as one conversation.
// Pages load from the host as the user scrolls up; a thin line marks where each
// part begins, the last one where the current part begins.
function EarlierParts({ sessionId, roster, actions }) {
  const [view, setView] = useState({ items: [], cursor: undefined, loading: true, failed: false, startedAt: null })
  const top = useRef(null)
  const busy = useRef(false)
  const alive = useRef(true)
  const restore = useRef(null)
  const load = (cursor) => {
    if (busy.current) return
    busy.current = true
    setView(current => ({ ...current, loading: true, failed: false }))
    actions.earlier(sessionId, cursor).then((page) => {
      busy.current = false
      if (!alive.current) return
      // The chat's scroller does not anchor content prepended above the viewport,
      // so the page keeps its distance from the end by hand.
      const scroller = top.current && scrollParent(top.current)
      if (scroller) restore.current = { scroller, fromEnd: scroller.scrollHeight - scroller.scrollTop }
      setView(current => ({ items: [...page.items, ...current.items], cursor: page.cursor, loading: false, failed: false, startedAt: page.startedAt ?? current.startedAt }))
    }, () => {
      busy.current = false
      if (alive.current) setView(current => ({ ...current, loading: false, failed: true }))
    })
  }
  useEffect(() => {
    alive.current = true
    load(undefined)
    return () => { alive.current = false }
  }, [sessionId])
  useLayoutEffect(() => {
    const pending = restore.current
    restore.current = null
    if (pending) pending.scroller.scrollTop = pending.scroller.scrollHeight - pending.fromEnd
  }, [view.items])
  useEffect(() => {
    const node = top.current
    if (!node || view.loading || view.failed || !view.cursor || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) load(view.cursor)
    }, { root: scrollParent(node), rootMargin: '600px 0px 0px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [view.cursor, view.loading, view.failed])
  const selfId = roster.byId[sessionId]?.id
  const rows = []
  for (const item of view.items) {
    const last = rows.at(-1)
    if (item.kind === 'bot' && last?.kind === 'bot') last.texts.push(item.text)
    else rows.push(item.kind === 'bot' ? { kind: 'bot', texts: [item.text] } : item)
  }
  return h('div', { className: 'bt-earlier', role: 'feed', 'aria-label': t('Earlier messages'), 'aria-busy': view.loading },
    h('div', { ref: top, className: 'bt-earlier-top' },
      view.loading ? h(Shimmer, null, t('Loading earlier messages…'))
        : view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Couldn’t load earlier messages · Retry'))
          : view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Load earlier')) : null),
    rows.map((row, index) => {
      // Pages are prepended, so a row keeps its distance from the end.
      const key = rows.length - index
      switch (row.kind) {
        case 'divider': return h(PartLine, { key, time: row.time })
        case 'user': return h('div', { key, className: 'bt-urow' }, h('div', { className: 'bt-ububble' },
          row.text ? h(MarkdownText, { text: row.text, labels: mdLabels(), variant: 'compact' }) : null,
          row.images ? h('span', { className: 'bt-uimages' }, row.images === 1 ? t('1 image') : t('{count} images', { count: row.images })) : null))
        case 'answer': return h(AnsweredCell, { key, node: { data: row } })
        case 'bot': return h(Bubbles, { key, texts: row.texts, roster, selfId, actions })
        case 'event': {
          if (row.role === 'report') return h(GroupEvent, { key, prefix: t('Replies from'), room: roster.roomsById[row.roomId], name: t('a group chat'), roster, actions })
          const other = roster.byId[row.botId] ?? { id: row.botId, name: row.name ?? t('a Bot'), color: 'gray' }
          return h(EventLine, { key, prefix: row.role === 'reply' ? t('Reply from') : t('Message from'), bots: [other], onOpen: () => { if (selfId && other.id) actions.openExchange(selfId, other.id) } })
        }
        default: return null
      }
    }),
    h(PartLine, { time: view.startedAt }))
}

export function TriggerCell({ node, sessionId, useRoster, useSessions, useTurnClock, useUi, actions }) {
  const roster = useRoster(value => value)
  const data = node.data
  const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
  // Team state (exchanges) is keyed by the Bot id; Session state by the part shown.
  const selfId = roster.byId[sessionId]?.id ?? sessionId
  // A resumed handoff keeps the relayed message's source, but it opens a part, not a run.
  const relayed = source.kind === 'bot' && source.handoff !== true && (source.role === 'request' || source.role === 'reply') && typeof source.senderSessionId === 'string'
  const turn = node.location?.turn?.turn ?? data.turn
  // Noted before paint so a folded line never flashes in before its run's first line.
  useLayoutEffect(() => {
    if (relayed) actions.noteTurnPeer(sessionId, turn, source.senderSessionId)
  }, [relayed, sessionId, turn, source.senderSessionId])
  const order = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.map(entry => entry.turn).join(',') : ''
  })
  const peers = useTurnClock((state) => {
    if (!relayed) return ''
    const turns = state[sessionId] ?? {}
    return Object.keys(turns).filter(key => turns[key].peer !== undefined).map(key => `${key}:${turns[key].peer}`).join(',')
  })
  // A conversation opened for the first time since it began starts under the
  // unread divider, with its opening time below it.
  const visit = useUi(state => state.visits?.[sessionId])
  const hiddenTurns = roster.exchangeTurns[sessionId]
  const unreadOpening = useTurnClock((state) => {
    const first = openingTurn(state[sessionId], order, hiddenTurns)
    return first?.turn === turn && unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  const body = triggerBody()
  return unreadOpening
    ? h(Fragment, null, h('div', { className: 'bt-open-new' }, h(NewDivider), h('div', { className: 'bt-time-sep', role: 'separator' }, unreadOpening)), body)
    : body

  function triggerBody() {
    if (source.kind === 'bot') {
      // A part opens with its handoff package, so the earlier parts go right above it.
      if (source.handoff === true) return roster.roomsById[sessionId] ? null : h(EarlierParts, { sessionId, roster, actions })
      // Group turns belong to the group chat; the member's own chat stays one-to-one.
      if (source.role === 'kickoff' || source.role === 'room') return null
      // The secret card itself shows what the user did; the note to the Bot stays out.
      if (source.role === 'secret') return null
      if (source.role === 'post') {
        const room = roster.roomsById[sessionId]
        const poster = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
        return h(GroupMessage, { bot: poster, text: stripHeader(contentText(data.content)), room, roster, actions, msgKey: `${sessionId}:${data.turn}:post`, useUi })
      }
      if (source.role === 'report') {
        return h(GroupEvent, { prefix: t('Replies from'), room: roster.roomsById[source.roomId], name: t('a group chat'), roster, actions })
      }
      const run = relayed ? commRunOf(
        order.split(',').filter(Boolean).map(Number),
        Object.fromEntries(peers.split(',').filter(Boolean).map(pair => [Number(pair.slice(0, pair.indexOf(':'))), pair.slice(pair.indexOf(':') + 1)])),
        turn,
        hiddenTurns,
      ) : null
      if (run === 'folded') return null
      const sender = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
      const count = run?.count ?? (isHiddenTurn(roster, sessionId, turn) ? 2 : 1)
      // Peers may be named by any part of their chat, so they are matched by Bot.
      const bots = [sender]
      for (const peer of (run?.peerIds ?? []).map(id => roster.byId[id]).filter(Boolean)) {
        if (!bots.some(bot => bot.id === peer.id)) bots.push(peer)
      }
      return h(EventLine, {
        prefix: count > 1 ? t('{count} messages with', { count }) : t('Message from'),
        bots,
        onOpen: bot => actions.openExchange(selfId, bot.id),
      })
    }
    if (source.kind === 'schedule') {
      const prompts = reminderPrompts(contentText(data.content))
      return h('div', { className: 'bt-event' }, prompts.length > 0 ? t('Scheduled task: {text}', { text: prompts.join(' · ').slice(0, 80) }) : t('Routine started'))
    }
    if (source.kind === 'user-question-reply') return null
    return h('div', { className: 'bt-event' }, contentText(data.content).slice(0, 80) || t('Update'))
  }
}

function NewDivider() {
  return h('div', { className: 'bt-new-sep', role: 'separator', 'aria-label': t('New messages') }, h('span', null, t('New')))
}

export function TurnProcessCell({ node, sessionId, turnProcess, useRoster, useUi, useTurnClock, actions }) {
  const open = turnProcess === undefined || !turnProcess.foldable || turnProcess.open
  useEffect(() => {
    if (!open) turnProcess.setOpen(true)
  }, [open, turnProcess])
  const turn = node?.location?.turn?.turn ?? node?.data?.turn
  const start = node?.location?.turn?.start?.time
  const hidden = useRoster(roster => isHiddenTurn(roster, sessionId, turn))
  // Exchange turns hide their replies but still show their trigger chip, so their start
  // counts for separators too.
  useEffect(() => {
    actions.noteTurnTime(sessionId, turn, 'first', start)
  }, [sessionId, turn, start])
  // The reply to a turn the user saw begin arrived while the user was away.
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    const own = state[sessionId]?.[turn]
    return !hidden && typeof visit?.seen === 'number' && own?.first !== undefined && own.first <= visit.seen
      && own.end !== undefined && own.end > visit.seen && own.end <= visit.entered
  })
  return fresh ? h(NewDivider) : null
}

export function Nothing() { return null }

// The time separator: "Today 1:12 AM", "Yesterday 9:03 PM", "Thu, Sep 3 4:20 PM".
const SEPARATOR_GAP_MS = 30 * 60 * 1000
export function clockLabel(time, now = Date.now()) {
  const date = new Date(time)
  const midnight = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((midnight(new Date(now)) - midnight(date)) / 86400000)
  const clock = date.toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return t('Today {time}', { time: clock })
  if (days === 1) return t('Yesterday {time}', { time: clock })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return `${date.toLocaleDateString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })} ${clock}`
}
function nextTurnStart(turns, turn) {
  let next
  for (const key in turns) {
    const candidate = Number(key)
    if (candidate > turn && turns[key].first !== undefined && (next === undefined || candidate < next)) next = candidate
  }
  return next === undefined ? undefined : turns[next].first
}
// The first turn the transcript shows: the earliest rendered start, with only hidden
// exchange turns before it. `firstTurns` lists the outline's first turns.
export function openingTurn(turns, firstTurns, hiddenTurns) {
  if (!turns || !firstTurns) return null
  const start = nextTurnStart(turns, -Infinity)
  if (start === undefined) return null
  const turn = Number(Object.keys(turns).filter(key => turns[key].first === start)[0])
  const listed = firstTurns.split(',').map(Number)
  const earlier = listed.filter(entry => entry < turn)
  return listed.includes(turn) && earlier.every(entry => hiddenTurns?.includes(entry)) ? { turn, start } : null
}
// Began after the user last left the conversation and before this visit opened it.
export const unseenSince = (visit, time) => typeof visit?.seen === 'number' && time > visit.seen && time <= visit.entered

// A turn's tail sits right before the next turn's first row, so the separator for a
// pause between turns renders here.
export function TurnTailCell({ node, sessionId, useTurnClock, useUi, actions }) {
  const data = node.data
  useEffect(() => { actions.noteTurnTime(sessionId, data.turn, 'end', data.time) }, [sessionId, data.turn, data.time])
  const label = useTurnClock((state) => {
    const start = nextTurnStart(state[sessionId] ?? {}, data.turn)
    return start !== undefined && start - data.time >= SEPARATOR_GAP_MS ? clockLabel(start) : ''
  })
  // The unread divider sits before the first turn that began after the last visit;
  // turns that begin while the conversation is open were watched live.
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number' || data.time > visit.seen) return false
    const start = nextTurnStart(state[sessionId] ?? {}, data.turn)
    return start !== undefined && start > visit.seen && start <= visit.entered
  })
  if (!label && !fresh) return null
  return h(Fragment, null,
    label ? h('div', { className: 'bt-time-sep', role: 'separator' }, label) : null,
    fresh ? h(NewDivider) : null)
}

export function Shimmer({ children }) {
  return h('span', { className: 'bt-shimmer' }, children)
}

// Status phrases. A running tool names what it does; otherwise one
// phrase is drawn from the pool each time the activity changes.
export const PHRASES = {
  thinking: ['Thinking about it', 'Weighing the options', 'Working out a plan', 'Sorting out the details'],
  working: ['On it', 'Busy with it', 'Moving ahead', 'Taking care of it', 'Making headway'],
}
const TOOL_PHRASES = [
  [/web_?search|search_?web/i, 'Searching online'],
  [/fetch|browse|browser|web/i, 'Reading a page'],
  [/shell|bash|exec|command|terminal/i, 'Running shell commands'],
  [/^(read|view|cat)\b|read_/i, 'Opening a file'],
  [/grep|glob|list_dir|^ls$|find|search/i, 'Looking through files'],
  [/write|edit|patch|apply|replace/i, 'Writing changes'],
  [/image|photo|draw/i, 'Working on an image'],
]
const GROUP_PHRASES = { create_group: 'Creating a group', update_group: 'Updating the group', delete_group: 'Deleting the group', post_to_group: 'Posting in the group' }
function toolActivity(name, arg, findBot) {
  switch (name) {
    case 'ask_user': return null
    case 'request_secret': return null
    case 'list_secrets': return { label: t('Checking the keys'), state: 'searching' }
    case 'ask_user_question': return { label: t('Waiting for your answer'), state: 'alert' }
    case 'group_relay': return { relay: true, state: 'orbit' }
    case 'message_bot': {
      const target = findBot(arg('to'))
      return { label: target ? t('Asking {name}', { name: target.name }) : t('Asking another Bot'), state: 'sending' }
    }
    case 'create_bot': return { label: t('Creating {name}', { name: arg('name') ?? t('a Bot') }), state: 'sending' }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot'))
      return { label: t('Updating {name}', { name: target?.name ?? t('a Bot') }), state: 'sending' }
    }
    case 'list_bots': return { label: t('Checking the team'), state: 'searching' }
    case 'read_group_chat': return { label: t('Reading {name}', { name: arg('group') ?? t('a group chat') }), state: 'searching' }
    case 'read_own_chat': return { label: t('Looking back through the chat'), state: 'searching' }
    case 'remember': return { label: t('Saving to memory'), state: 'working' }
    case 'forget': return { label: t('Updating memory'), state: 'working' }
    case 'recall': return { label: t('Checking memory'), state: 'searching' }
    default:
      if (GROUP_PHRASES[name]) return { label: t(GROUP_PHRASES[name]), state: 'sending' }
      const phrase = TOOL_PHRASES.find(([pattern]) => pattern.test(name))?.[1]
      return { label: phrase ? t(phrase) : null, state: toolState(name) }
  }
}

// Transcript rows report what is in flight to the one activity row at the tail.
function useLiveNote(actions, sessionId, id, entry) {
  const key = entry ? JSON.stringify(entry) : ''
  useEffect(() => {
    if (!key) return undefined
    actions.noteLive(sessionId, id, JSON.parse(key))
    return () => actions.noteLive(sessionId, id, null)
  }, [sessionId, id, key])
}

function GroupReplies({ sessionId, callId, done, content, roster, actions, useUi }) {
  const [live, setLive] = useState({ replies: [], speaking: null })
  useEffect(() => {
    if (done) return undefined
    let stop = false
    let timer
    let seen = ''
    const tick = async () => {
      const result = await actions.roomProgress(sessionId)
      if (stop) return
      const entry = (result ?? []).find(item => item.callId === callId) ?? (result ?? [])[0]
      const key = entry ? JSON.stringify([entry.replies, entry.speaking]) : ''
      if (entry && key !== seen) { seen = key; setLive({ replies: entry.replies ?? [], speaking: entry.speaking ?? null }) }
      timer = setTimeout(tick, document.hidden ? 5000 : 1000)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [done, sessionId, callId])
  let replies = live.replies
  if (done) {
    try { replies = JSON.parse(contentText(content)).replies ?? [] } catch { replies = [] }
  }
  // Members speak one at a time, so only the current speaker is typing.
  const pending = done || !live.speaking ? [] : [live.speaking]
  if (replies.length === 0 && pending.length === 0) return null
  const room = roster.roomsById[sessionId]
  return h('div', { className: 'bt-group-replies' },
    replies.map((reply, index) => {
      const bot = roster.byId[reply.botId] ?? { id: reply.botId, name: reply.name, color: reply.color ?? 'gray' }
      if (reply.kind === 'failed') {
        return h('div', { key: `${reply.botId}-${index}`, className: 'bt-event bt-event-error', role: 'status', title: [reply.code, reply.status, reply.text].filter(Boolean).join(' · ') },
          t('{name} could not answer: {reason}', { name: bot.name, reason: failureLabel(reply.code, reply.text) }))
      }
      if (reply.kind === 'lookup') {
        return h('div', { key: `${reply.botId}-${index}`, className: 'bt-event' },
          reply.text ? t('{name} looked up its own chat for “{text}”', { name: bot.name, text: reply.text }) : t('{name} looked up its own chat', { name: bot.name }))
      }
      return h(GroupMessage, { key: `${reply.botId}-${index}`, bot, text: reply.text, room, roster, actions, msgKey: callId ? `${sessionId}:${callId}:${index}` : undefined, useUi })
    }),
    pending.map((id) => {
      const bot = roster.byId[id]
      if (!bot) return null
      return h('div', { key: `pending-${id}`, className: 'bt-activity' },
        h(BotMark, { bot: bot, size: 22, state: 'thinking' }),
        h(Shimmer, null, t('{name} is typing…', { name: bot.name })))
    }))
}

export function ToolCell({ node, sessionId, useRoster, useUi, actions }) {
  const roster = useRoster(value => value)
  const root = node.data.root
  const done = root.kind === 'tool-result'
  const turn = node.location?.turn?.turn ?? root.turn
  const hidden = isHiddenTurn(roster, sessionId, turn)
  const tool = toolName(root)
  const { text: arg, value: argValue } = toolArgs(root)
  const findBot = nameOrId => roster.byId[nameOrId] ?? roster.bots.find(bot => bot.name.toLowerCase() === String(nameOrId ?? '').toLowerCase())
  // A running tool shows only as the activity row's phrase.
  useLiveNote(actions, sessionId, `tool:${root.callId ?? node.key}`, done || hidden ? null : toolActivity(tool, arg, findBot))
  if (hidden) return null
  switch (tool) {
    case 'message_bot': {
      const target = findBot(arg('to')) ?? { name: arg('to') ?? '…', color: 'gray' }
      if (done && root.isError) return h('div', { className: 'bt-event' }, t("Couldn't message {name}", { name: target.name }))
      return h(EventLine, { prefix: t('Messaged'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id) })
    }
    case 'create_bot': {
      const created = findBot(arg('name'))
      if (!done || created === undefined) return null
      return h(EventLine, { prefix: t('Created'), bots: [created], onOpen: bot => actions.openSession(bot.id) })
    }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot'))
      return done && target ? h(EventLine, { prefix: t('Updated'), bots: [target], onOpen: bot => actions.openSession(bot.id) }) : null
    }
    case 'group_relay':
      return h(GroupReplies, { sessionId, callId: root.callId, done, content: root.content, roster, actions, useUi })
    case 'create_group':
    case 'update_group':
    case 'delete_group':
    case 'post_to_group': {
      const verbs = {
        create_group: ['Created group', "Couldn't create the group"],
        update_group: ['Updated group', "Couldn't update the group"],
        delete_group: ['Deleted group', "Couldn't delete the group"],
        post_to_group: ['Posted in', "Couldn't post in the group"],
      }[tool]
      if (!done) return null
      // Tool results quote the group's name; anything else is a refusal.
      const result = contentText(root.content)
      const named = /^(Created group|Updated|Nothing changed in|Deleted|Posted in) "([^"]+)"/.exec(result)
      if (root.isError || !named) return h('div', { className: 'bt-event', title: result }, t(verbs[1]))
      const name = named[2]
      const room = roster.rooms.find(entry => entry.name === name)
      return h(GroupEvent, { prefix: t(verbs[0]), room: tool === 'delete_group' ? undefined : room, name, roster, actions })
    }
    case 'ask_user': {
      const question = roster.questions?.[sessionId]
      // Answered or closed: the card leaves no gap where it was.
      if (!question || question.callId !== root.callId) return h('span', { className: 'bt-q-gone', hidden: true })
      return h(PendingQuestion, { sessionId, question, actions, inline: true })
    }
    case 'request_secret':
      return h(SecretToolCell, { sessionId, callId: root.callId, name: arg('name'), done, content: root.content, roster, actions })
    case 'ask_user_question': {
      if (!done) return null
      let parsed = null
      try { parsed = JSON.parse(contentText(root.content)) } catch { parsed = null }
      const answer = parsed?.answers?.[0]
      const question = argValue('questions')?.[0]
      if (!answer) return null
      return h('div', { className: 'bt-q-inline' }, h(SettledQuestion, { question, answer }))
    }
    case 'read_group_chat': {
      if (!done) return null
      const room = roster.rooms.find(entry => entry.name === arg('group'))
      return room ? h(GroupEvent, { prefix: t('Read'), room, roster, actions }) : null
    }
    case 'remember':
    case 'forget':
      return done && !root.isError ? h(MemoryEvent, { sessionId, scope: arg('scope'), result: contentText(root.content), roster, actions, findBot }) : null
    default:
      return null
  }
}
