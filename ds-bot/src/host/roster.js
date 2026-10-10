// Roster: creating, changing, and deleting Bots and group chats, the Main Bot role, and
// the first Main Bot of a new team.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_AVATAR_IMAGE, ROOM_MAX_MEMBERS, ROOM_MODES, ROOM_NAME_MAX, ROOM_NOTICE_MAX } from './constants.js'
import { currentColor, isColor, unquote } from './text.js'

export function install(rt) {
  const { ctx, config, home, defaults, state } = rt

  let bootstrapping = null

  async function ensureWorkspace() {
    if (state.workspaceId && ctx.workspaceRegistry.get(state.workspaceId)) return state.workspaceId
    const path = config.workspace ?? join(home, 'workspace')
    await mkdir(path, { recursive: true })
    const workspace = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path, 'DS Bot')
    state.workspaceId = workspace.id
    await rt.save()
    return workspace.id
  }

  async function createSession(title) {
    // A Bot's tools run here too; while another dsh holds the team, a new Session would
    // belong to no saved Bot.
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const workspaceId = await ensureWorkspace()
    const { sessionId } = await ctx.sessionController.create({ workspaceId })
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent.session, title)
    return sessionId
  }

  function cleanAvatar(input) {
    if (input === null || typeof input !== 'object') return undefined
    const avatar = {}
    if (typeof input.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(input.shape)) avatar.shape = input.shape
    if (typeof input.image === 'string') {
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw new Error('Avatar images must be PNG, JPEG, WebP, or GIF')
      if (input.image.length > MAX_AVATAR_IMAGE) throw new Error('Avatar image is too large')
      avatar.image = input.image
    }
    return Object.keys(avatar).length > 0 ? avatar : undefined
  }

  const freshName = (base) => {
    const stem = base.slice(0, 34)
    if (!rt.findBot(stem)) return stem
    let index = 2
    while (rt.findBot(`${stem} ${index}`)) index += 1
    return `${stem} ${index}`
  }

  // `pickModel` leaves the model to the user: the chat opens on a model card, and the
  // greeting waits until a model is chosen. So does a Bot made when no model is served.
  async function createBot({ name: botName, role = '', instructions = '', color, brief = '', createdBy, main = false, avatar, model, copyOf, pickModel = false }) {
    const cleanName = String(botName ?? '').trim().slice(0, 40)
    if (cleanName === '') throw new Error('A Bot needs a name')
    if (rt.findBot(cleanName)) throw new Error(`A Bot named ${cleanName} already exists`)
    const cleanAvatarValue = cleanAvatar(avatar)
    // The model is fixed at creation, so a later change of the DSH default leaves it alone.
    const modelRef = model ? await rt.resolveModel(model) : pickModel ? undefined : await rt.defaultModel()
    const id = await createSession(cleanName)
    state.bots[id] = {
      id,
      name: cleanName,
      role: String(role).trim().slice(0, 24),
      // A color is only stored when the user picks one; otherwise the id picks it.
      ...(isColor(currentColor(color)) ? { color: currentColor(color) } : {}),
      ...(cleanAvatarValue ? { avatar: cleanAvatarValue } : {}),
      ...(modelRef ? { model: modelRef } : {}),
      instructions: String(instructions).trim(),
      createdAt: Date.now(),
      createdBy: createdBy ?? null,
    }
    if (main) state.mainBotIds.push(id)
    const creator = rt.botOf(createdBy)
    const original = rt.botOf(copyOf)
    const language = rt.uiLanguage?.()
    const kickoff = main
      ? `You were just set up as the user's Main Bot. Greet the user in one or two short messages: say you will run their Bot team and that they can come to you for anything that needs a decision. Then use ask_user to ask what they want the team to help with first (3-4 short options). Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`
      : original
        ? `The user just made you as a copy of ${original.name}: same job, fresh memory. Greet the user in one short message, then use ask_user to ask what this copy should focus on (3-4 short options).`
        : creator
          ? `${creator.name} just created you for the user.${brief ? ` Why you exist: ${brief}` : ''}\nGreet the user in one short message, then use ask_user to ask where to start (3-4 short options relevant to your role, with allowCustom). Keep it brief.`
          : brief
            ? `The user just created you and sent this first message:\n\n${brief}\n\nIntroduce yourself in one short line, then help with it.`
            : 'The user just created you. Greet the user in one short message, then use ask_user to ask what you should focus on (3-4 short options, with allowCustom).'
    const text = !main && language ? `${kickoff}\nWrite in ${language}.` : kickoff
    const bot = state.bots[id]
    if (modelRef === undefined) {
      bot.kickoff = { text, from: createdBy ?? null, ...(main ? { main: true } : {}) }
      await rt.save()
      return bot
    }
    await rt.save()
    // The greeting runs on the Bot's own model, once its provider is registered.
    void rt.waitForModel(bot)
      .then(() => rt.applyModel(bot).catch(error => rt.warn('ds-bot: model for %s not applied: %s', cleanName, error)))
      .then(() => sendKickoff(bot, { text, from: createdBy }))
    return bot
  }

  function sendKickoff(bot, { text, from }) {
    void rt.deliver({ fromId: from ?? undefined, toId: bot.id, text, role: 'kickoff' })
      .catch(error => rt.warn('ds-bot: kickoff failed: %s', error))
  }

  // The user wrote first, so the held greeting would only interrupt.
  function dropKickoff(botId) {
    const bot = rt.botOf(botId)
    if (bot?.kickoff === undefined) return
    delete bot.kickoff
    void rt.save()
  }

  async function duplicateBot(id) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    const served = (await rt.catalog()).some(entry => entry.ref === bot.model)
    return createBot({
      name: freshName(`${bot.name} copy`),
      role: bot.role,
      instructions: bot.instructions,
      color: bot.color,
      avatar: bot.avatar,
      model: served ? bot.model : undefined,
      copyOf: bot.id,
    })
  }

  async function updateBot(id, patch) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (patch.name !== undefined) {
      const next = String(patch.name).trim().slice(0, 40)
      const clash = rt.findBot(next)
      if (next === '' || (clash && clash.id !== id)) throw new Error(`Name ${next} is not available`)
      bot.name = next
      const agent = await rt.resolveAgent(rt.chatOf(id))
      await ctx.sessionTitle.rename(agent.session, next)
      await followMemberNames(Object.values(state.rooms).filter(room => room.members.includes(id)))
    }
    if (patch.role !== undefined) bot.role = String(patch.role).trim().slice(0, 24)
    if (patch.instructions !== undefined) bot.instructions = String(patch.instructions).trim()
    let modelChanged = false
    if (patch.color !== undefined) {
      if (patch.color === null) delete bot.color
      else if (isColor(currentColor(patch.color))) bot.color = currentColor(patch.color)
    }
    if (patch.avatar !== undefined) {
      const avatar = cleanAvatar(patch.avatar)
      if (avatar) bot.avatar = avatar
      else delete bot.avatar
    }
    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === '') delete bot.model
      else bot.model = await rt.resolveModel(patch.model)
      modelChanged = true
    }
    await rt.save()
    if (modelChanged) await rt.applyModel(bot, { force: true })
    if (bot.model && bot.kickoff !== undefined) {
      const held = bot.kickoff
      delete bot.kickoff
      await rt.save()
      sendKickoff(bot, held)
    }
    return bot
  }

  async function setFlags(id, { pinned, hidden }) {
    const entry = rt.botOf(id) ?? rt.roomOf(id) ?? state.agents[id]
    if (entry === undefined) throw new Error('Unknown conversation')
    if (typeof pinned === 'boolean') entry.pinned = pinned
    if (typeof hidden === 'boolean') entry.hidden = hidden
    await rt.save()
    return entry
  }

  // ---------------------------------------------------------------------------
  // Group chat settings. The user and every Main Bot may change any group; a group's
  // admin may change its own group but not delete it. Only a member can be admin.

  const roomBusy = id => [...rt.roomProgress.values()].some(round => round.roomId === id)
  const autoRoomName = members => ['You', ...members.map(id => rt.botOf(id)?.name).filter(Boolean)].join(', ')
  const cleanNotice = text => String(text ?? '').trim().slice(0, ROOM_NOTICE_MAX)

  function cleanRoomName(text, selfId) {
    const next = unquote(text).replace(/\s+/g, ' ').slice(0, ROOM_NAME_MAX)
    if (next !== '' && rt.findRooms(next).some(room => room.id !== selfId)) throw new Error(`Another group chat is already called "${next}"`)
    return next
  }

  async function retitleRoom(room) {
    try {
      const agent = await rt.resolveAgent(room.id)
      await ctx.sessionTitle.rename(agent.session, room.name)
    } catch (error) {
      rt.warn('ds-bot: group title for %s not updated: %s', room.name, error)
    }
  }

  // Groups without a chosen name are named after their members, so they follow renames.
  async function followMemberNames(rooms = Object.values(state.rooms)) {
    for (const room of rooms) {
      if (room.named) continue
      const next = autoRoomName(room.members)
      if (next === room.name) continue
      room.name = next
      await retitleRoom(room)
    }
  }

  function checkMembers(members) {
    if (members.length < 2) throw new Error('A group chat needs at least two Bots')
    if (members.length > ROOM_MAX_MEMBERS) throw new Error(`A group chat holds at most ${ROOM_MAX_MEMBERS} Bots`)
  }

  async function createRoom({ members: memberIds = [], name: roomName, notice, mode, admin, createdBy } = {}) {
    const members = [...new Set(memberIds)].filter(id => rt.botOf(id))
    checkMembers(members)
    const custom = cleanRoomName(roomName ?? '')
    // A Main Bot leads the groups it makes; a group the user makes is led by a Main
    // Bot member when it has one.
    const adminId = admin !== undefined ? admin : (members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null)
    if (adminId !== null && !members.includes(adminId)) throw new Error('The admin must be a member of the group')
    if (mode !== undefined && !ROOM_MODES.includes(mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    const title = custom || autoRoomName(members)
    const id = await createSession(title)
    state.rooms[id] = {
      id,
      name: title,
      ...(custom ? { named: true } : {}),
      members,
      admin: adminId,
      mode: mode ?? 'admin',
      notice: cleanNotice(notice),
      createdAt: Date.now(),
      createdBy: createdBy ?? null,
    }
    await rt.save()
    return state.rooms[id]
  }

  // `actorId` is the Bot asking, or undefined for the user. Returns what changed, in words.
  async function updateRoom(id, patch, actorId) {
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    const byMain = actorId === undefined || rt.isMain(actorId)
    const byAdmin = !byMain && rt.isAdminOf(room, actorId)
    if (!byMain && !byAdmin) throw new Error(`Only the user, a Main Bot, or the admin of "${room.name}" can change it`)
    let members = Array.isArray(patch.members) ? [...new Set(patch.members)] : [...room.members]
    for (const member of patch.add ?? []) if (!members.includes(member)) members.push(member)
    members = members.filter(member => !(patch.remove ?? []).includes(member) && rt.botOf(member))
    checkMembers(members)
    let admin = room.admin ?? null
    if (patch.admin !== undefined) {
      admin = patch.admin || null
      if (admin === null && byAdmin) throw new Error('Hand the admin role to another member instead of leaving the group without one')
      if (admin !== null && !members.includes(admin)) throw new Error(`${rt.botOf(admin)?.name ?? 'That Bot'} must be a member to be the admin`)
    }
    if (admin !== null && !members.includes(admin)) {
      if (byAdmin && admin === actorId) throw new Error('Hand the admin role to another member before leaving the group')
      admin = null
    }
    if (patch.mode !== undefined && !ROOM_MODES.includes(patch.mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    const name = patch.name === undefined ? undefined : cleanRoomName(patch.name, room.id)
    const notice = patch.notice === undefined ? undefined : cleanNotice(patch.notice)

    const changes = []
    const names = ids => ids.map(member => rt.botOf(member)?.name).filter(Boolean).join(', ')
    const added = members.filter(member => !room.members.includes(member))
    const removed = room.members.filter(member => !members.includes(member))
    if (added.length > 0) changes.push(`added ${names(added)}`)
    if (removed.length > 0) changes.push(`removed ${names(removed)}`)
    // A member who leaves and comes back starts from a fresh look at the log.
    for (const member of removed) {
      if (room.seen) delete room.seen[member]
      rt.dropGroupSession(room, member)
    }
    room.members = members
    if (admin !== (room.admin ?? null)) changes.push(admin ? `made ${rt.botOf(admin).name} the admin` : 'removed the admin')
    room.admin = admin
    if (patch.mode !== undefined && patch.mode !== room.mode) {
      room.mode = patch.mode
      changes.push(patch.mode === 'admin' ? 'plain messages now go to the admin first' : 'every member now replies in turn')
    }
    if (notice !== undefined && notice !== (room.notice ?? '')) {
      room.notice = notice
      changes.push(notice ? 'updated the notice' : 'cleared the notice')
    }
    const before = room.name
    if (name !== undefined) {
      if (name !== '') {
        room.named = true
        room.name = name
      } else {
        delete room.named
      }
    }
    if (!room.named) room.name = autoRoomName(room.members)
    if (room.name !== before) {
      changes.push(`renamed it "${room.name}"`)
      await retitleRoom(room)
    }
    await rt.save()
    return { room, changes }
  }

  async function deleteRoom(id) {
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    for (const botId of Object.keys(room.sessions ?? {})) rt.dropGroupSession(room, botId)
    delete state.rooms[id]
    rt.roomInbox.delete(id)
    await rt.save()
    await ctx.workspaceRegistry.archiveSession(id).catch(() => {})
  }

  // The first Main Bot is the sidebar tile. `replace` gives a Main Bot's place to
  // another Bot in one step, so the team never has none; `primary` moves a Bot to the
  // front and keeps the others.
  async function setMain(id, main, { primary = false, replace } = {}) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    const others = state.mainBotIds.filter(other => other !== id)
    let next
    if (!main) {
      if (!rt.isMain(id)) return
      if (others.length === 0) throw new Error('The team needs at least one Main Bot')
      next = others
    } else if (replace !== undefined && replace !== id) {
      const at = others.indexOf(replace)
      if (at === -1) throw new Error('Only a Main Bot can be replaced')
      next = others.with(at, id)
    } else if (primary) {
      next = [id, ...others]
    } else {
      next = rt.isMain(id) ? state.mainBotIds : [...others, id]
    }
    // The sidebar shows every Main Bot, so a hidden Bot would vanish again once demoted.
    if (main) delete bot.hidden
    // A held setup greeting says "you are the Main Bot"; it must not go out after demotion.
    for (const other of state.mainBotIds.filter(other => !next.includes(other))) {
      if (rt.botOf(other)?.kickoff?.main) delete rt.botOf(other).kickoff
    }
    state.mainBotIds = next
    await rt.save()
  }

  async function deleteBot(id) {
    if (rt.botOf(id) === undefined) throw new Error('Unknown Bot')
    if (rt.isMain(id)) throw new Error('A Main Bot cannot be deleted; remove its Main Bot role first')
    // Before the Bot and its group Sessions leave the state, which the archive reads.
    const archived = rt.archiveBotMemory(id)
    const current = rt.chatOf(id)
    // Questions and exchange turns are kept per Session, so every part of the chat is cleared.
    const parts = new Set([id, current, ...(rt.botOf(id).segments ?? []).map(segment => segment.sessionId)])
    delete state.bots[id]
    for (const part of parts) {
      delete state.questions[part]
      delete state.exchangeTurns[part]
    }
    const touched = []
    for (const room of Object.values(state.rooms)) {
      if (!room.members.includes(id)) continue
      room.members = room.members.filter(member => member !== id)
      if (room.admin === id) room.admin = null
      rt.dropGroupSession(room, id)
      touched.push(room)
    }
    await followMemberNames(touched)
    await rt.forgetBotSecrets(id)
    await archived
    await rt.save()
    await ctx.workspaceRegistry.archiveSession(current).catch(() => {})
  }

  async function bootstrap() {
    await rt.load()
    void rt.syncModels()
    if (state.mainBotIds.some(id => rt.botOf(id))) return
    // Only the team's first Main Bot is stored as the DeepSeek whale; other Bots get a
    // look from their id, and a Bot made Main Bot later keeps its own.
    bootstrapping ??= createBot({ name: defaults.mainName, role: defaults.mainRole, main: true, color: 'deepseek', avatar: { shape: 'whale' }, pickModel: true })
      .finally(() => { bootstrapping = null })
    await bootstrapping
  }

  Object.assign(rt, {
    ensureWorkspace, createSession, createBot, duplicateBot, updateBot, setFlags,
    roomBusy, autoRoomName, retitleRoom, createRoom, updateRoom, deleteRoom,
    setMain, deleteBot, bootstrap, dropKickoff,
  })
}
