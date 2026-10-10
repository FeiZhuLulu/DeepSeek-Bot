// Group chats: the room log, members' group Sessions, rounds and @mentions, round
// reports, and the group tools (group_relay, read_own_chat, read_group_chat).
//
// Group chat rounds. A group chat is one shared, ordered conversation, so members
// speak one at a time: a turn starts only after the previous speaker has posted or
// passed, and it shows everything that arrived since that member last looked, plus
// the speaking order and the member's place in it. Nobody answers a room that has
// moved on, and nobody has to count lines to know who went before. A plain message
// goes to every member in roster order, admin first, or to the admin alone in admin
// mode; "@Name" picks members. A reply that @mentions a member calls that member
// next, bounded per member and per round; the admin's calls reach further.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROOM_REPLY_TIMEOUT_MS, SOURCE_KIND } from './constants.js'
import { escapeRegExp, splitRef } from './text.js'
import { GROUP_REF, output } from './tools.js'
import { failureLine } from './turns.js'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8
const ROOM_EXTRA_TURNS = 4
const ROOM_ADMIN_EXTRA_TURNS = 4
const ROOM_TURNS_EACH = 2
const ROOM_ADMIN_TURNS_EACH = 4

// Logs written before rooms were versioned get sequence numbers in place.
const ensureRoomLog = (room) => {
  if (typeof room.seq !== 'number') {
    room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
    room.seq = room.log.length
  }
  room.seen ??= {}
}

const appendRoom = (room, line) => {
  room.seq += 1
  room.log = [...room.log, { ...line, seq: room.seq }].slice(-ROOM_LOG_MAX)
}

// A member's own lines are already in its Session, so only the others' are news.
const unseenLines = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) return room.log.slice(-ROOM_FIRST_LOOK)
  return room.log.filter(line => line.seq > since && line.botId !== memberId).slice(-ROOM_DELTA_MAX)
}

const lineText = line => (line.kind === 'lookup'
  ? `[${line.who} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  : `${line.who}: ${line.text}`)
const transcript = lines => lines.map(lineText).join('\n')

// Models often echo the transcript format ("Name: …") despite the instruction.
export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
export const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

// "@Name" mentions in order of appearance. Longest names match first so "@Mx" never
// reads as "@M"; only ASCII letters and digits continue a name, so "@K你好" is K.
const ROOM_ALL = ['all', 'everyone', '所有人', '全体']
const NAME_GOES_ON = /^[a-z0-9_-]/i
export const mentionsIn = (text, members) => {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length)
  const found = []
  let all = false
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && /[a-z0-9_.]/i.test(text[at - 1])) continue
    const rest = text.slice(at + 1)
    const starts = word => rest.toLowerCase().startsWith(word.toLowerCase()) && !NAME_GOES_ON.test(rest.slice(word.length))
    if (ROOM_ALL.some(starts)) all = true
    const hit = byLength.find(member => starts(member.name))
    if (hit && !found.includes(hit)) found.push(hit)
  }
  return { all, found }
}

const ROOM_REPLY = 'Reply with your message for the group: one or two short messages, no name prefix. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'

const slotLabel = (slot) => {
  if (slot.status === 'speaking') return `${slot.name} (you, now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

const adminNote = room => [
  'You are this group\'s admin.',
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  'Writing "@Name" calls that member to speak right after you, and "@all" calls every member. When the user asks, change the group with update_group.',
].filter(Boolean).join(' ')

// The opening turn of a group the user just made without a first message.
const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

const ROOM_READ_MAX = 30

export function install(rt) {
  const { ctx } = rt

  // A member's group Session, created on its first turn there. A new one starts with
  // a fresh look at the log and a brief of the member's own chat; the brief is the
  // first message, so it stays fixed and the prefix stays cacheable.
  async function groupSessionFor(room, member) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) return { id: known, brief: undefined }
    const id = await rt.createSession(`${member.name} · ${room.name}`)
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
    delete room.seen[member.id]
    const ref = await rt.desiredModel(member)
    if (ref !== undefined) {
      await rt.selectSessionModel(id, splitRef(ref))
        .catch(error => rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error))
    }
    await rt.save()
    return { id, brief: await rt.ownChatBrief(member) }
  }

  // Lines from before the round's opening message are kept apart from this round, so
  // an earlier round (an old count-off, say) never reads as part of the current one.
  function roomPrompt(room, member, round) {
    const peers = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${rt.isAdminOf(room, bot.id) ? ' (admin)' : ''}`)
    const leads = rt.isAdminOf(room, member.id)
    const lines = unseenLines(room, member.id)
    const earlier = lines.filter(line => line.seq < round.startSeq).slice(-ROOM_EARLIER_MAX)
    const current = lines.filter(line => line.seq >= round.startSeq)
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const index = round.slots.findIndex(slot => slot.status === 'speaking')
    const before = index
    const after = round.slots.length - index - 1
    const members = `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. Members speak one at a time; each message is posted before the next speaker starts.`
    const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : ''
    if (round.kickoff) return [members, notice, leads ? adminNote(room) : '', roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\n\n')
    return [
      members,
      notice,
      leads ? adminNote(room) : '',
      earlier.length ? `Earlier in the group, before this round (context only):\n${transcript(earlier)}` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current)}`
        : 'Nothing new in this round since your last message.',
      `Speaking order for this round: ${round.slots.map(slotLabel).join(' → ')}.`,
      `You are number ${index + 1} of ${round.slots.length}. ${before === 0 ? 'Nobody spoke before you' : `${before} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`,
      ROOM_REPLY,
    ].filter(Boolean).join('\n\n')
  }

  // One member turn inside the room; resolves to its final text, `{ failure }` when its
  // model call failed, or null when it did not answer in time or the round was stopped.
  async function roomTurn(room, member, sessionId, text, note, signal) {
    if (signal.aborted) return null
    const exchangeId = randomUUID()
    room.seen[member.id] = room.seq
    const done = new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer)
        rt.roomWaiters.delete(exchangeId)
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), ROOM_REPLY_TIMEOUT_MS)
      rt.roomWaiters.set(exchangeId, { resolve: finish, fail: failure => finish({ failure }) })
      signal.addEventListener('abort', () => finish(null), { once: true })
    })
    try {
      await rt.deliver({ fromId: undefined, toId: member.id, sessionId, role: 'room', roomId: room.id, exchangeId, note, text })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      rt.roomWaiters.get(exchangeId)?.resolve(null)
    }
    const reply = await done
    if (reply === null || reply?.failure !== undefined) return reply
    return stripOwnName(member.name, String(reply ?? '').trim())
  }

  async function runRound(room, round, signal) {
    const limit = round.slots.length + ROOM_EXTRA_TURNS + (room.admin ? ROOM_ADMIN_EXTRA_TURNS : 0)
    const turns = new Map()
    for (let index = 0; index < round.slots.length && round.turns < limit; index += 1) {
      if (signal.aborted) break
      const slot = round.slots[index]
      const member = rt.botOf(slot.id)
      // Settings may change mid-round, for example when the admin removes someone.
      if (member === undefined || !room.members.includes(slot.id)) {
        slot.status = 'left'
        continue
      }
      slot.status = 'speaking'
      round.speaking = member.id
      round.turns += 1
      turns.set(member.id, (turns.get(member.id) ?? 0) + 1)
      let session
      try {
        session = await groupSessionFor(room, member)
      } catch (error) {
        rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
        round.speaking = null
        slot.status = 'failed'
        round.failed.push(member.name)
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code: 'SESSION', text: String(error?.message ?? error).slice(0, 300), time: Date.now() })
        continue
      }
      const prompt = roomPrompt(room, member, round)
      const text = session.brief === undefined ? prompt : `${session.brief}\n\n${prompt}`
      const reply = await roomTurn(room, member, session.id, text, slot.note ?? 'your turn', signal)
      round.speaking = null
      if (reply?.failure !== undefined) {
        // Not a pass: the user sees why the member is silent, and the round goes on.
        slot.status = 'failed'
        round.failed.push(member.name)
        const { code, status, message } = reply.failure
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
        continue
      }
      if (reply === null || isPass(reply)) {
        slot.status = reply === null ? 'missed' : 'passed'
        round.passed.push(member.name)
        continue
      }
      slot.status = 'posted'
      appendRoom(room, { who: member.name, botId: member.id, text: reply })
      round.replies.push({ botId: member.id, name: member.name, color: member.color, text: reply, time: Date.now() })
      void rt.save()
      // A called member moves up if it is still waiting, or gets one more turn if it
      // already spoke; either way it goes right after this speaker. Only the admin's
      // "@all" calls everyone, so a member cannot set off a storm.
      const leads = rt.isAdminOf(room, member.id)
      const others = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      const { all, found } = mentionsIn(reply, others)
      const callees = leads && all ? [...found, ...others.filter(other => !found.includes(other))] : found
      let next = index + 1
      for (const peer of callees) {
        if ((turns.get(peer.id) ?? 0) >= (leads ? ROOM_ADMIN_TURNS_EACH : ROOM_TURNS_EACH)) continue
        const waiting = round.slots.findIndex((other, at) => at > index && other.id === peer.id && other.status === 'waiting')
        const called = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots.splice(waiting, 1)[0]
        called.note = `${member.name} mentioned you`
        round.slots.splice(next, 0, called)
        next += 1
      }
    }
  }

  ctx.tools.register(defineTool({
    name: 'group_relay',
    description: 'Group chat relay only. Deliver the latest user message to the Bots in this group chat, one at a time, and collect their replies.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await rt.load()
      const room = rt.roomOf(exec.agent?.id)
      if (room === undefined) return JSON.stringify({ error: 'Not a group chat' })
      ensureRoomLog(room)
      // Everything queued since the last relay is posted in order, so messages that the
      // Session folds into one turn are not lost; the newest one picks the speakers.
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      const posts = queued.length > 0 ? queued : [{ text: '' }]
      const startSeq = room.seq + 1
      // The opening greeting is a cue for the admin, not a line of the group.
      for (const post of posts.filter(item => !item.kickoff)) {
        // Image readings go into the log only; `@` names are picked from what the user typed.
        const text = post.images === undefined ? post.text : [post.text, ...await rt.imagesForGroup(post.images, room.id)].filter(Boolean).join('\n')
        appendRoom(room, post.botId
          ? { who: rt.botOf(post.botId)?.name ?? post.name ?? 'Bot', botId: post.botId, text }
          : { who: 'User', text })
      }
      if (posts.some(post => !post.botId && !post.kickoff)) room.botRounds = 0
      await rt.save()
      const opener = posts.at(-1)
      const round = {
        roomId: room.id,
        members: room.members,
        startSeq,
        ...(opener.kickoff ? { kickoff: true } : {}),
        slots: openingSpeakers(room, opener).map(member => ({ id: member.id, name: member.name, status: 'waiting', ...(opener.kickoff ? { note: 'the group was just created' } : {}) })),
        speaking: null,
        turns: 0,
        replies: [],
        passed: [],
        failed: [],
      }
      rt.roomProgress.set(exec.callId, round)
      try {
        await runRound(room, round, exec.signal)
      } catch (error) {
        rt.warn('ds-bot: group round in %s stopped: %s', room.name, error)
      } finally {
        rt.roomProgress.delete(exec.callId)
      }
      await rt.save()
      for (const post of posts) {
        if (post.reportBack && rt.botOf(post.botId)) void reportRound(room, post, round)
      }
      exec.concludeTurn?.()
      return JSON.stringify({ replies: round.replies, passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) })
    },
  }))

  // Private context enters a group only through this tool, and the group sees each use.
  ctx.tools.register(defineTool({
    name: 'read_own_chat',
    description: 'Read or search your own chat with the user, across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a group chat the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined) return 'Only Bots on the team can use read_own_chat.'
      const member = rt.botOf(botId)
      const room = rt.roomOf(owner?.roomId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const parts = rt.partsOf(botId)
      const number = Number.isInteger(args.part) ? args.part : undefined
      if (room !== undefined && member !== undefined) {
        ensureRoomLog(room)
        const text = query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        appendRoom(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        for (const round of rt.roomProgress.values()) {
          if (round.roomId === room.id) round.replies.push({ kind: 'lookup', botId: member.id, name: member.name, color: member.color, text, time: Date.now() })
        }
        void rt.save()
      }
      const partsNote = parts.length > 1 ? `\n\nYour own chat has ${parts.length} parts: ${rt.partIndex(parts)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(botId, around)
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `Your own chat ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = parts[number - 1]
        if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`
        if (part.endedAt === undefined) return `Part ${number} is the current one; it is in your context.${partsNote}`
        return `Part ${number} of your own chat (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${rt.noteText(part) ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(botId, { askingId: id })
        return lines.length === 0 ? `Your own chat is empty.${partsNote}` : `Your own chat (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(botId, query, { askingId: id })
      if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `Your own chat, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_group_chat',
    description: 'Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.',
    parameters: { group: GROUP_REF },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can read group chats.'
      const { room, error } = rt.pickRoom(args.group, self)
      if (error) return error
      ensureRoomLog(room)
      const lines = room.log.slice(-ROOM_READ_MAX)
      return lines.length === 0 ? `"${room.name}" has no messages yet.` : `Latest in "${room.name}" (oldest first):\n${transcript(lines)}`
    },
  }))

  // A Bot that posts never answers its own post. @mentions choose the speakers; else
  // the admin answers alone in admin mode, or first of everyone.
  function openingSpeakers(room, opener) {
    const members = room.members.map(rt.botOf).filter(bot => bot && bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    if (opener.kickoff) return admin ? [admin] : []
    const { all, found } = mentionsIn(opener.text, members)
    if (found.length > 0 && !all) return found
    if (!all && room.mode === 'admin' && admin) return [admin]
    return admin ? [admin, ...members.filter(bot => bot !== admin)] : members
  }

  // A group the user just made opens with its admin asking what the group is for.
  async function greetRoom(roomId) {
    const room = rt.roomOf(roomId)
    if (!room?.admin) return
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '[Group chat created]' }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'kickoff', exchangeId: randomUUID(), senderName: 'You', hop: 0, roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.greetRoom = greetRoom

  async function reportRound(room, post, round) {
    const lines = round.replies.filter(reply => reply.kind === undefined).map(reply => `${reply.name}: ${reply.text}`)
    const text = [
      lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : 'Nobody replied to your post.',
      round.passed.length > 0 ? `Stayed silent: ${round.passed.join(', ')}.` : '',
      round.failed.length > 0 ? `Could not answer because their model call failed: ${round.replies.filter(reply => reply.kind === 'failed').map(reply => `${reply.name} (${failureLine({ code: reply.code, status: reply.status, message: reply.text })})`).join(', ')}.` : '',
    ].filter(Boolean).join('\n\n')
    await rt.deliver({ toId: post.botId, role: 'report', roomId: room.id, text, hop: (post.hop ?? 0) + 1 })
      .catch(error => rt.warn('ds-bot: group report to %s failed: %s', post.name, error))
  }

  // A group chat's own Session never consults the model: models drift from "only call
  // group_relay" (they message one member directly when the user names it), so the
  // relay step is synthesized here. Auxiliary calls such as titles still reach the model.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined) return next()
    return (async function* relayOrPass() {
      await rt.load()
      if (rt.roomOf(options.sessionId) === undefined) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a Bot's post after the last model or
      // tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff')))
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_relay', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_relay', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  })
}
