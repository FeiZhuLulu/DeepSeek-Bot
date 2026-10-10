// Turns: what each Bot Session is doing now (for its mascot), which turns another Bot
// triggered, the waiters and inboxes of group rounds, and routing a finished turn's reply.
//
// Turn tracking: which turns were triggered by another Bot, and what they said.
import { REPLY_KIND, SOURCE_KIND } from './constants.js'
import { textOf } from './text.js'
import { reminderText } from './schedules.js'

// A failed turn's `LlmFailure`, kept to what can be shown and logged. Like DSH's own
// error row, an AUTH failure loses its message: providers may echo part of the key.
export function turnFailure(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN'
  const message = code === 'AUTH' || typeof error?.message !== 'string' ? '' : error.message.trim().slice(0, 500)
  return {
    code,
    message,
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
    ...(typeof error?.requestId === 'string' ? { requestId: error.requestId } : {}),
  }
}

export const failureLine = failure => `${failure.code}${failure.status ? ` ${failure.status}` : ''}${failure.message ? `: ${failure.message.slice(0, 200)}` : ''}`

export function install(rt) {
  const { ctx, state } = rt

  /** @type {Map<string, {turn?:number, pending?:any, info?:any, texts:string[]}>} */
  const live = new Map()
  /** @type {Map<string, {resolve:(text:string)=>void}>} member turn waiters keyed by exchange id */
  const roomWaiters = new Map()
  /** @type {Map<string, {roomId:string, replies:any[], members:string[], speaking:string|null}>} */
  const roomProgress = new Map()
  /** @type {Map<string, {text:string, botId?:string, name?:string, reportBack?:boolean, hop?:number, kickoff?:boolean}[]>} messages a room's next relay posts */
  const roomInbox = new Map()
  const queueRoomMessage = (roomId, item) => roomInbox.set(roomId, [...(roomInbox.get(roomId) ?? []), item])

  const liveOf = id => {
    let entry = live.get(id)
    if (entry === undefined) live.set(id, entry = { texts: [] })
    return entry
  }

  // What each running Bot is doing right now, for its mascot. Process-local: it is
  // rebuilt from live events and never saved.
  /** @type {Record<string, string>} */
  let activity = {}
  const activityOf = (tool) => {
    if (/^(message_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(tool)) return 'sending'
    if (tool === 'group_relay') return 'orbit'
    if (/search|fetch|browse|browser|read|grep|glob|list/i.test(tool)) return 'searching'
    return 'working'
  }
  const setActivity = (id, value) => {
    if (activity[id] === value) return
    const next = { ...activity }
    if (value === undefined) delete next[id]
    else next[id] = value
    activity = next
  }

  const markExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ??= []
    if (!turns.includes(turn)) {
      turns.push(turn)
      if (turns.length > 400) turns.splice(0, turns.length - 400)
      void rt.save()
    }
  }
  const unmarkExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ?? []
    if (!turns.includes(turn)) return
    state.exchangeTurns[sessionId] = turns.filter(other => other !== turn)
    void rt.save()
  }

  // A request whose audience is the user is answered in the recipient's own chat: that
  // turn stays visible there and its reply is not routed back to the sender.
  const answersUser = info => info.role === 'request' && info.audience === 'user'

  // A group Session is hidden as a whole, so its turns need no marking. A handoff
  // package that only opens a part is acknowledged with a fixed line, also hidden.
  const claimTrigger = (sessionId, entry, info) => {
    entry.info = info
    if (rt.groupOwners.has(sessionId)) return
    if ((info.role === 'request' && !answersUser(info)) || info.role === 'room' || (info.role === 'handoff' && info.resume !== true)) {
      markExchangeTurn(sessionId, entry.turn)
    }
  }

  // Activity is tracked per Session; a Bot's mascot shows its own chat's, else a group's.
  const activityView = () => {
    const merged = {}
    for (const [id, value] of Object.entries(activity)) {
      if (!rt.groupOwners.has(id)) merged[rt.chatOwners.get(id) ?? id] = value
    }
    for (const [id, value] of Object.entries(activity)) {
      const owner = rt.groupOwners.get(id)
      if (owner !== undefined) merged[owner.botId] ??= value
    }
    // A Bot writing its handoff note is thinking.
    for (const job of rt.switchJobs()) {
      if (job.roomId === undefined) merged[job.botId] = 'thinking'
      else merged[job.botId] ??= 'thinking'
    }
    return merged
  }

  // Where a Session speaks, for the diagnostics log.
  const placeOf = (id) => {
    const room = rt.roomOf(rt.groupOwners.get(id)?.roomId) ?? rt.roomOf(id)
    return room ? `group "${room.name}"` : 'own chat'
  }
  const noteTurnFailure = (id, failure) => {
    rt.noteFailure({
      source: 'turn',
      text: failure.message || 'the model call failed',
      code: failure.code,
      status: failure.status,
      requestId: failure.requestId,
      bot: rt.botOf(rt.selfOf(id))?.name ?? (rt.roomOf(id) ? undefined : 'unknown Bot'),
      where: placeOf(id),
      sessionId: id,
    })
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (!rt.isBotSession(id) && !rt.roomOf(id)) return
    const entry = liveOf(id)
    switch (event.type) {
      case 'tool/call':
        setActivity(id, event.data?.name === 'ask_user' ? undefined : activityOf(String(event.data?.name ?? '')))
        break
      case 'tool/result':
        if (entry.turn !== undefined) setActivity(id, 'thinking')
        break
      case 'turn/start':
        setActivity(id, 'thinking')
        entry.turn = event.data.turn
        entry.texts = []
        entry.info = undefined
        // A turn turned away before its first step may end without a turn/end.
        entry.switched = false
        entry.answers = false
        if (entry.pending !== undefined) {
          claimTrigger(id, entry, entry.pending)
          entry.pending = undefined
        }
        break
      case 'user/message': {
        const source = event.data?.source
        // A message that shares a step with a bare handoff package is what the turn
        // answers, so the turn is not a hidden acknowledgement.
        const bare = info => info?.handoff === true && info.resume !== true
        if (entry.turn !== undefined && (source?.kind === 'user' || source?.kind === REPLY_KIND || source?.kind === SOURCE_KIND)) {
          if (bare(source)) {
            if (entry.answers) break
          } else {
            entry.answers = true
            if (bare(entry.info)) {
              unmarkExchangeTurn(id, entry.turn)
              entry.info = undefined
            }
          }
        }
        if (source?.kind === SOURCE_KIND && source.role === 'post' && rt.roomOf(id)) {
          queueRoomMessage(id, {
            text: textOf(event.data.content).replace(/^\[Group post from [^\]]*\]\n?/, ''),
            botId: source.senderSessionId,
            name: source.senderName,
            reportBack: source.reportBack === true,
            hop: source.hop ?? 0,
          })
        } else if (source?.kind === SOURCE_KIND && source.role === 'kickoff' && rt.roomOf(id)) {
          queueRoomMessage(id, { text: '', kickoff: true })
        } else if (source?.kind === SOURCE_KIND) {
          if (entry.turn !== undefined && entry.info === undefined) claimTrigger(id, entry, source)
          else entry.pending = source
        } else if (source?.kind === 'schedule' && rt.roomOf(id)) {
          // A group's scheduled task reaches the group as the user's message.
          queueRoomMessage(id, { text: reminderText(textOf(event.data.content)) })
        } else if (source?.kind === 'user' || source?.kind === REPLY_KIND) {
          if (rt.roomOf(id) && source.kind === 'user') {
            const images = (Array.isArray(event.data.content) ? event.data.content : [])
              .filter(block => block?.type === 'image' && !block.offloaded).map(block => block.attachment)
            queueRoomMessage(id, { text: textOf(event.data.content), ...(images.length > 0 ? { images } : {}) })
          }
          const own = rt.chatOwners.get(id)
          if (own !== undefined) rt.dropKickoff(own)
          // Any user message answers or supersedes the open question card.
          if (state.questions[id] !== undefined) {
            delete state.questions[id]
            void rt.save()
          }
        }
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data?.message?.content)
        if (text !== '') entry.texts.push(text)
        break
      }
      case 'turn/end': {
        setActivity(id, undefined)
        const info = entry.info
        const reply = entry.texts.join('\n\n').trim()
        // A turn stopped for a switch goes on in the next part, which answers instead.
        const switched = entry.switched === true
        entry.turn = undefined
        entry.info = undefined
        entry.texts = []
        entry.switched = false
        const reason = event.data?.reason
        const failure = reason?.kind === 'error' && !switched ? turnFailure(reason.error) : undefined
        if (failure !== undefined) noteTurnFailure(id, failure)
        if (info === undefined || switched) break
        if (info.role === 'room') {
          const waiter = roomWaiters.get(info.exchangeId)
          roomWaiters.delete(info.exchangeId)
          if (failure !== undefined) waiter?.fail(failure)
          else waiter?.resolve(reason?.kind === 'aborted' ? null : reply)
        } else if (info.role === 'request' && !answersUser(info) && failure !== undefined) {
          // The sender was told a reply comes later; without this it would wait forever.
          const name = rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot'
          void rt.deliver({
            fromId: rt.selfOf(id),
            toId: info.senderSessionId,
            text: `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`,
            role: 'reply',
            hop: (info.hop ?? 0) + 1,
            replyTo: info.exchangeId,
          }).catch(error => rt.warn('ds-bot: failure notice delivery failed: %s', error))
        } else if (info.role === 'request' && !answersUser(info) && reply !== '') {
          void rt.deliver({
            fromId: rt.selfOf(id),
            toId: info.senderSessionId,
            text: reply,
            role: 'reply',
            hop: (info.hop ?? 0) + 1,
            replyTo: info.exchangeId,
          }).catch(error => rt.warn('ds-bot: reply delivery failed: %s', error))
        }
        break
      }
    }
  })

  Object.assign(rt, { live, liveOf, roomWaiters, roomProgress, roomInbox, activityView })
}
