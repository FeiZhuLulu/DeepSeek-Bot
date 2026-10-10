// Team tools: the roster, bot-to-bot messages, group chat settings and posts, and the
// question card. Group rounds and reading chats are in groups.js.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { COLORS, EXTRA_COLORS, MAX_HOPS, ROOM_BOT_ROUNDS, ROOM_MODES, SOURCE_KIND } from './constants.js'
import { unquote } from './text.js'

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
export const GROUP_REF = { type: 'string', required: true, description: 'Exact group chat name from list_bots' }
const MODE_PARAM = {
  type: 'string',
  enum: ROOM_MODES,
  description: '"everyone": every member answers a plain message in turn, admin first. "admin" (the default): a plain message goes to the admin, who calls others with @Name. @mentions always choose who answers.',
}

export function install(rt) {
  const { ctx, state } = rt

  const callerBot = (exec) => rt.botOf(rt.selfOf(exec.agent?.id))

  const roomLine = (room, self) => {
    const members = room.members.map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${bot.id === room.admin ? ' (admin)' : ''}${bot.id === self ? ' (you)' : ''}`)
    const parts = [
      `members: ${members.join(', ')}`,
      room.mode === 'admin' && room.admin ? 'plain messages go to the admin first' : 'every member replies in turn',
      room.notice ? `notice: ${room.notice.split('\n')[0].slice(0, 100)}` : '',
    ].filter(Boolean)
    return `- "${room.name}" — ${parts.join('; ')}`
  }
  // Main Bots see every group; other Bots see the groups they are in.
  const visibleRooms = self => Object.values(state.rooms).filter(room => rt.isMain(self) || room.members.includes(self))

  ctx.tools.register(defineTool({
    name: 'list_bots',
    description: 'List every Bot on the user\'s team with its role and what it does, and the group chats you can see.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const lines = Object.values(state.bots).map(bot => {
        const model = bot.appliedModel ?? bot.model
        const tags = [bot.role, model ? `model ${model}` : '', rt.isMain(bot.id) ? 'Main Bot' : '', bot.id === self ? 'you' : ''].filter(Boolean).join(', ')
        const job = bot.instructions ? ` — ${bot.instructions.split('\n')[0].slice(0, 120)}` : ''
        return `- ${bot.name}${tags ? ` (${tags})` : ''}${job}`
      })
      if (lines.length === 0) return 'No Bots yet.'
      const rooms = visibleRooms(self)
      return [
        'Bots:',
        ...lines,
        '',
        rooms.length === 0 ? 'Group chats: none you can see.' : 'Group chats:',
        ...rooms.map(room => roomLine(room, self)),
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'message_bot',
    description: 'Send an asynchronous message to another Bot on the team. By default its reply arrives later as a new message to you; with reply_to "user" it answers the user in its own chat instead.',
    parameters: {
      to: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      message: { type: 'string', required: true, description: 'Self-contained message; the other Bot cannot see this conversation' },
      reply_to: {
        type: 'string',
        enum: ['me', 'user'],
        description: '"me" (default): the reply comes back to you and the user does not see it. "user": the Bot answers the user in its own chat, where the user reads it, and nothing comes back to you. Use "user" whenever the user wants to hear from that Bot directly or asks Bots to say something in their own chats.',
      },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use message_bot.'
      const target = rt.findBot(args.to)
      if (target === undefined) return `No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`
      if (target.id === sender.id) return 'You cannot message yourself.'
      const hop = (rt.live.get(exec.agent?.id)?.info?.hop ?? 0)
      if (hop >= MAX_HOPS) return 'This chain of Bot messages is already long. Stop here and report to the user instead.'
      const toUser = args.reply_to === 'user'
      await rt.deliver({ fromId: sender.id, toId: target.id, text: args.message, role: 'request', hop, ...(toUser ? { audience: 'user' } : {}) })
      return toUser
        ? `Delivered to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
        : `Delivered to ${target.name}. Its reply will arrive later as a new message; do not wait for it.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_bot',
    description: 'Main Bot only. Create a new Bot on the user\'s team. It appears in the sidebar and greets the user.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name, e.g. "Researcher" or "Editor"' },
      role: { type: 'string', required: true, description: 'Two-to-four character role label shown under the name' },
      instructions: { type: 'string', required: true, description: 'What this Bot is responsible for and how it should work' },
      brief: { type: 'string', description: 'Why the user wants it, passed to the new Bot as its first context' },
      model: { type: 'string', description: 'Model the Bot runs on, as provider/model or a model id. Only when the user names one; otherwise the DSH default model.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!rt.isMain(rt.selfOf(exec.agent?.id))) return 'Only the Main Bot can create Bots. Ask the Main Bot instead.'
      try {
        const bot = await rt.createBot({ ...args, createdBy: rt.selfOf(exec.agent.id) })
        return `Created ${bot.name}. It is greeting the user now.`
      } catch (error) {
        return `Could not create the Bot: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_bot',
    description: 'Main Bot only. Rename a Bot or change its role, color, model, or instructions.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Current Bot name' },
      name: { type: 'string', description: 'New name' },
      role: { type: 'string', description: 'New role label' },
      instructions: { type: 'string', description: 'Replacement instructions' },
      color: { type: 'string', description: `One of ${[...COLORS, ...EXTRA_COLORS].join(', ')}` },
      model: { type: 'string', description: 'Move the Bot to another model, as provider/model or a model id' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!rt.isMain(rt.selfOf(exec.agent?.id))) return 'Only the Main Bot can update Bots.'
      const bot = rt.findBot(args.bot)
      if (bot === undefined) return `No Bot named ${args.bot}.`
      try {
        const { name: newName, role, instructions, color, model } = args
        const next = await rt.updateBot(bot.id, { name: newName, role, instructions, color, ...(model ? { model } : {}) })
        return `Updated ${next.name}.`
      } catch (error) {
        return `Could not update the Bot: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_models',
    description: 'List the models a Bot can run on, as provider/model refs for create_bot and update_bot.',
    parameters: {},
    output,
    async execute() {
      const models = await rt.catalog()
      if (models.length === 0) return 'No models are configured. Ask the user to add one in Settings → Models.'
      const fallback = rt.defaultRef()
      return models.map(entry => `- ${entry.ref}${entry.name !== entry.id ? ` (${entry.name})` : ''}${entry.input?.includes('image') ? ', reads images' : ''}${entry.ref === fallback ? ', default' : ''}`).join('\n')
    },
  }))

  // Group tools take Bot names as an array, or as one comma-separated string from
  // models that flatten it.
  const nameList = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : [])
    .map(item => String(item ?? '').trim()).filter(Boolean)
  const resolveBots = (refs) => {
    const bots = []
    const unknown = []
    for (const ref of nameList(refs)) {
      const bot = rt.findBot(ref)
      if (bot === undefined) unknown.push(ref)
      else if (!bots.includes(bot)) bots.push(bot)
    }
    return { bots, unknown }
  }
  const teamNames = () => Object.values(state.bots).map(bot => bot.name).join(', ')
  const groupNames = self => visibleRooms(self).map(room => `"${room.name}"`).join(', ') || 'none'
  const pickRoom = (ref, self) => {
    const matches = rt.findRooms(ref).filter(room => visibleRooms(self).includes(room))
    if (matches.length === 1) return { room: matches[0] }
    if (matches.length > 1) return { error: `Several group chats are called "${unquote(ref)}". Rename one first.` }
    return { error: `No group chat called "${unquote(ref)}" that you can see. Groups: ${groupNames(self)}.` }
  }

  ctx.tools.register(defineTool({
    name: 'create_group',
    description: 'Main Bot only. Create a group chat with the user and some Bots. You join it as its admin unless you name another member.',
    parameters: {
      members: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact names of the other Bots to add; you are added automatically' },
      name: { type: 'string', description: 'Group name; defaults to the member names' },
      notice: { type: 'string', description: 'Shared instructions every member reads before speaking in this group' },
      admin: { type: 'string', description: 'Member who leads the group; defaults to you' },
      mode: MODE_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can create group chats. Ask a Main Bot instead.'
      const { bots, unknown } = resolveBots(args.members)
      if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
      const admin = args.admin ? rt.findBot(args.admin) : rt.botOf(self)
      if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
      const members = [...new Set([self, ...bots.map(bot => bot.id), admin.id])]
      try {
        const room = await rt.createRoom({ members, name: args.name, notice: args.notice, mode: args.mode, admin: admin.id, createdBy: self })
        return `Created group "${room.name}" with ${room.members.map(id => rt.botOf(id).name).join(', ')}. ${admin.id === self ? 'You are' : `${admin.name} is`} its admin. It is in the user's sidebar; use post_to_group to start a discussion there.`
      } catch (error) {
        return `Could not create the group: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_group',
    description: 'Change a group chat: rename it, set its notice, add or remove members, change its admin or reply mode. Main Bots may change any group; a group\'s admin may change its own group.',
    parameters: {
      group: GROUP_REF,
      name: { type: 'string', description: 'New group name; an empty string names it after its members again' },
      notice: { type: 'string', description: 'Replacement notice, the shared instructions every member reads; an empty string clears it' },
      add_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to add' },
      remove_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to remove' },
      admin: { type: 'string', description: 'Member to make the admin; "none" leaves the group without one (Main Bots only)' },
      mode: MODE_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use update_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      const add = resolveBots(args.add_members)
      const remove = resolveBots(args.remove_members)
      const unknown = [...add.unknown, ...remove.unknown]
      if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
      let admin
      if (args.admin !== undefined && args.admin !== '') {
        if (/^(none|nobody|null|无|没有)$/i.test(String(args.admin).trim())) admin = null
        else {
          admin = rt.findBot(args.admin)?.id
          if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
        }
      }
      try {
        const { room: next, changes } = await rt.updateRoom(room.id, {
          name: args.name,
          notice: args.notice,
          mode: args.mode,
          admin,
          add: add.bots.map(bot => bot.id),
          remove: remove.bots.map(bot => bot.id),
        }, self)
        return changes.length === 0 ? `Nothing changed in "${next.name}".` : `Updated "${next.name}": ${changes.join('; ')}.`
      } catch (failure) {
        return `Could not update "${room.name}": ${failure.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delete_group',
    description: 'Main Bot only. Delete a group chat; its history is archived. Only when the user asks.',
    parameters: { group: GROUP_REF },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can delete group chats.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      if (rt.roomBusy(room.id)) return `"${room.name}" is in the middle of a round. Delete it after the round ends.`
      await rt.deleteRoom(room.id)
      return `Deleted "${room.name}". Its history is archived.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'post_to_group',
    description: 'Post a message into a group chat as yourself. It starts a round: members reply in the group, where the user reads them. Main Bots may post into any group; an admin into its own group.',
    parameters: {
      group: GROUP_REF,
      message: { type: 'string', required: true, description: 'What to say; write "@Name" to choose who answers' },
      report_back: { type: 'boolean', description: 'Also send the members\' replies back to you as a new message when the round ends' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const sender = rt.botOf(self)
      if (sender === undefined) return 'Only Bots on the team can use post_to_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      if (!rt.isMain(self) && !rt.isAdminOf(room, self)) return `Only a Main Bot or the admin of "${room.name}" can post there. Use message_bot to reach its members.`
      const info = rt.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      if ((info?.hop ?? 0) >= MAX_HOPS) return 'This chain of Bot messages is already long. Stop here and report to the user instead.'
      const text = String(args.message ?? '').trim()
      if (text === '') return 'Write a message to post.'
      if ((room.botRounds ?? 0) >= ROOM_BOT_ROUNDS) return `Bots already started ${ROOM_BOT_ROUNDS} rounds in "${room.name}" since the user last spoke there. Wait for the user.`
      room.botRounds = (room.botRounds ?? 0) + 1
      await rt.save()
      const reportBack = args.report_back === true
      try {
        const agent = await rt.resolveAgent(room.id)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: `[Group post from ${sender.name}]\n${text}` }],
          source: {
            kind: SOURCE_KIND,
            form: 'relay',
            role: 'post',
            exchangeId: randomUUID(),
            senderName: sender.name,
            senderSessionId: sender.id,
            roomId: room.id,
            hop: info?.hop ?? 0,
            ...(reportBack ? { reportBack: true } : {}),
          },
        }))
        await ctx.sessions.flush(agent.session)
      } catch (failure) {
        return `Could not post in "${room.name}": ${failure.message}`
      }
      return `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? '; their replies also come back to you as a new message when the round ends' : ', and nothing comes back to you'}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ask_user',
    description: 'Show the user a short multiple-choice question card in the chat (the user can also type their own answer). Calling it ends your turn; the chosen answer arrives later as the user\'s next message.',
    parameters: {
      question: { type: 'string', required: true, description: 'One short question' },
      options: {
        type: 'array',
        required: true,
        description: 'Two to four answers',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'Short answer shown on the option' },
            description: { type: 'string', description: 'Optional one-line explanation under the label' },
          },
        },
      },
      detail: { type: 'string', description: 'Optional one-line context shown under the question' },
      multiSelect: { type: 'boolean', description: 'Allow choosing several options' },
      allowCustom: { type: 'boolean', description: 'Also offer a field for an answer in the user\'s own words' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.groupOwners.has(id)) return 'Question cards only work in your own chat. In a group, ask in your message instead.'
      if (!rt.chatOwners.has(id)) return 'Only Bots on the team can use ask_user.'
      const options = (Array.isArray(args.options) ? args.options : [])
        .map(option => (typeof option === 'string' ? { label: option } : option ?? {}))
        .map(option => ({
          label: String(option.label ?? '').trim(),
          ...(option.description ? { description: String(option.description).trim() } : {}),
        }))
        .filter(option => option.label !== '')
        .slice(0, 6)
      if (options.length === 0) return 'Give at least one option.'
      state.questions[id] = {
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        question: String(args.question ?? '').trim(),
        ...(args.detail ? { detail: String(args.detail).trim() } : {}),
        options,
        multiSelect: args.multiSelect === true,
        ...(args.allowCustom === true ? { allowCustom: true } : {}),
        askedAt: Date.now(),
      }
      await rt.save()
      exec.concludeTurn?.()
      return 'The card is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  Object.assign(rt, { pickRoom })
}
