// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SOURCE_KIND } from './constants.js'

export function install(rt) {
  const { ctx, state } = rt

  const resolveAgent = async (sessionId) => {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(resolved.error?.message ?? 'Session unavailable')
    return resolved.agent
  }

  const headerFor = (role, fromName, roomName, audience, note = 'new message') => {
    if (role === 'reply') return `[Reply from ${fromName}]`
    if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
    if (role === 'report') return `[Group chat "${roomName}" · replies to your post]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'secret') return '[Secret card]'
    if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
    return `[Message from ${fromName}]`
  }

  // `sessionId` defaults to the recipient's own chat; group turns name its group Session.
  async function deliver({ fromId, toId, sessionId, text, role, hop = 0, replyTo, roomId, audience, note, exchangeId = randomUUID() }) {
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw new Error(`Unknown Bot ${toId}`)
    const fromName = from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      senderName: fromName,
      hop,
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
    }
    if (role === 'request' || role === 'reply') {
      state.exchanges.push({ id: exchangeId, from: fromId, to: toId, text, role, time: Date.now(), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}) })
      void rt.save()
    }
    const agent = await resolveAgent(sessionId ?? rt.chatOf(toId))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note)}\n${text}` }],
      source,
    }))
    await ctx.sessions.flush(agent.session)
    return exchangeId
  }

  Object.assign(rt, { resolveAgent, deliver })
}
