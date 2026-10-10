// Store: the saved team (state.json), its migrations, the lock that keeps a second dsh
// host on the same data from writing it, and the indexes that map a Session to the Bot
// or group chat it belongs to.
import { mkdirSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_THEMES, MAX_EXCHANGES, ROOM_MODES } from './constants.js'
import { homeLock } from './home-lock.js'
import { currentColor, normalize, unquote } from './text.js'

export function install(rt) {
  const { ctx, home, statePath } = rt

  /** @type {{version:1, workspaceId?:string, mainBotIds:string[], bots:Record<string,any>, rooms:Record<string,any>, agents:Record<string,any>, exchanges:any[], exchangeTurns:Record<string,number[]>, revision:number}} */
  const state = { version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 }
  let loaded = null
  let writing = Promise.resolve()
  const { warn } = rt

  const EMPTY = JSON.stringify(state)
  // The other dsh host that holds state.lock while this one only reads (see home-lock.js);
  // undefined while this host may write.
  let holder
  let lockBroken = false
  let warnedReadOnly = false
  // mtime and size of the state.json this host last read or wrote.
  let seen = ''
  const stamp = () => {
    try {
      const { mtimeMs, size } = statSync(statePath)
      return `${mtimeMs}:${size}`
    } catch {
      return ''
    }
  }
  const lock = homeLock(join(home, 'state.lock'))
  const claimLock = () => {
    if (lockBroken) return
    try {
      mkdirSync(home, { recursive: true })
      holder = lock.claim()
    } catch (error) {
      // An unusable lock (a read-only or odd file system) must not stop the team.
      lockBroken = true
      holder = undefined
      warn('ds-bot: cannot lock %s, so another dsh on the same data could undo changes: %s', home, error)
    }
  }
  const readOnly = () => {
    if (holder === undefined) return undefined
    const where = holder.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'unknown process'
    return `The Bot team in ${home} is open in another dsh (Web or Desktop, ${where}). This window shows the team but cannot change it; close the other one and reload.`
  }

  const readFileState = async () => {
    try {
      seen = stamp()
      const parsed = JSON.parse(await readFile(statePath, 'utf8'))
      return parsed?.version === 1 ? parsed : undefined
    } catch (error) {
      if (error?.code !== 'ENOENT') warn('ds-bot: unreadable state %s: %s', statePath, error)
      return undefined
    }
  }

  // Fill `state` from the saved file and bring an older team up to date. Returns the
  // groups whose Session titles still need the new name.
  const adopt = (parsed) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, JSON.parse(EMPTY), parsed ?? {})
    state.prefs ??= {}
    // Teams saved before the DSH Agent existed carry no `agents`; corrupt values reset.
    if (state.agents === null || typeof state.agents !== 'object' || Array.isArray(state.agents)) state.agents = {}
    let migrated = false
    for (const bot of Object.values(state.bots)) {
      if (bot.color !== currentColor(bot.color)) {
        bot.color = currentColor(bot.color)
        migrated = true
      }
      // LEGACY: Bots saved with a lab ran on that lab's default model; the model they
      // last ran on becomes their own, so dropping the lab changes nothing for them.
      if ('lab' in bot) {
        if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel
        delete bot.lab
        migrated = true
      }
    }
    // A team from before several Main Bots were allowed names a single one.
    if (!Array.isArray(state.mainBotIds)) state.mainBotIds = []
    if ('mainBotId' in state) {
      if (state.mainBotId && !state.mainBotIds.includes(state.mainBotId)) state.mainBotIds.unshift(state.mainBotId)
      delete state.mainBotId
      migrated = true
    }
    state.mainBotIds = state.mainBotIds.filter(id => state.bots[id])
    // Teams from before the whale was stored at setup: their first Bot, while still a
    // Main Bot, gets it once wherever it has no look of its own. After that the whale is
    // an ordinary look the user can change, and it never passes to another Bot.
    if (state.whaleStored !== true) {
      const first = Object.values(state.bots).reduce((best, bot) => (best === undefined || (bot.createdAt ?? 0) < (best.createdAt ?? 0) ? bot : best), undefined)
      if (first !== undefined && state.mainBotIds.includes(first.id)) {
        if (!first.avatar?.shape && !first.avatar?.image) first.avatar = { ...first.avatar, shape: 'whale' }
        if (!first.color) first.color = 'deepseek'
      }
      state.whaleStored = true
      if (first !== undefined) migrated = true
    }
    if (Object.hasOwn(LEGACY_THEMES, state.prefs.theme ?? '')) {
      state.prefs.theme = LEGACY_THEMES[state.prefs.theme]
      migrated = true
    }
    // Groups from before group settings existed reply in turn, led by a Main Bot member.
    for (const room of Object.values(state.rooms)) {
      if (room.admin !== undefined && ROOM_MODES.includes(room.mode)) continue
      if (room.admin === undefined) room.admin = room.members.find(id => state.mainBotIds.includes(id)) ?? null
      if (!ROOM_MODES.includes(room.mode)) room.mode = 'everyone'
      room.notice ??= ''
      migrated = true
    }
    // Unnamed groups from before names followed their members may still list old names.
    const stale = Object.values(state.rooms).filter(room => !room.named && room.name !== rt.autoRoomName(room.members))
    for (const room of stale) room.name = rt.autoRoomName(room.members)
    indexSessions()
    return { migrated: migrated || stale.length > 0, stale }
  }

  const load = () => loaded ??= (async () => {
    claimLock()
    if (holder !== undefined) warn('ds-bot: %s', readOnly())
    const { migrated, stale } = adopt(await readFileState())
    if (holder !== undefined) return
    if (migrated) await save()
    // Not awaited: renaming a session must not hold up the first roster read.
    for (const room of stale) void rt.retitleRoom(room)
  })()

  // A reading host follows the file and takes over once the other host has gone.
  const refresh = async () => {
    await load()
    if (holder === undefined) return
    claimLock()
    if (holder === undefined) {
      warn('ds-bot: the other dsh has closed; this one now saves the Bot team')
      warnedReadOnly = false
      adopt(await readFileState())
      return
    }
    if (stamp() !== seen) adopt(await readFileState())
  }

  const writable = () => {
    if (lockBroken) return true
    if (holder === undefined && lock.owns()) return true
    // Lost the lock: retake it when nobody else holds it (its file was deleted), else
    // another host took it over and this one stops writing.
    if (holder === undefined) {
      claimLock()
      if (holder === undefined) return true
    }
    if (!warnedReadOnly) {
      warnedReadOnly = true
      warn('ds-bot: not saving the Bot team: %s', readOnly())
    }
    return false
  }

  const save = () => {
    indexSessions()
    // A reading host keeps the file's revision, so its window does not skip the next change.
    if (!writable()) return writing
    state.revision += 1
    state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
    const snapshot = JSON.stringify(state, null, 2)
    writing = writing.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${statePath}.${process.pid}.tmp`
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, statePath)
      seen = stamp()
    }).catch(error => { warn('ds-bot: state write failed: %s', error) })
    return writing
  }

  ctx.effect(() => () => lock.release(), 'ds-bot: state lock')

  const botOf = id => (id === undefined ? undefined : state.bots[id])
  const roomOf = id => (id === undefined ? undefined : state.rooms[id])
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)

  // Group Sessions. A member speaks in each group from a hidden Session of its own,
  // `room.sessions[botId]`, that renders the same system prompt and tools as its own
  // chat: the provider's prefix cache is shared, and a group turn never re-reads the
  // member's private context. Created on the member's first turn in the group.
  //
  // Segments. A long conversation moves to a fresh Session at a context line (see
  // parts.js). A Bot's id is the Session id of its first own-chat segment and
  // never changes; `bot.sessionId` is the current one. Earlier segments, of the own
  // chat (`bot.segments`) and of each group Session (`room.segments[botId]`), are
  // archived and stay readable.
  /** @type {Map<string, string>} */
  const chatOwners = new Map()
  /** @type {Map<string, {botId:string, roomId:string}>} */
  const groupOwners = new Map()
  /** @type {Map<string, {botId:string, roomId?:string}>} */
  const pastOwners = new Map()
  const chatOf = botId => botOf(botId)?.sessionId ?? botId
  const indexSessions = () => {
    chatOwners.clear()
    groupOwners.clear()
    pastOwners.clear()
    for (const bot of Object.values(state.bots)) {
      for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id })
      chatOwners.set(chatOf(bot.id), bot.id)
    }
    for (const room of Object.values(state.rooms)) {
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) pastOwners.set(segment.sessionId, { botId, roomId: room.id })
      }
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) groupOwners.set(sessionId, { botId, roomId: room.id })
    }
    // The agents module owns the DSH Agent session index; it installs after this.
    rt.indexAgents?.()
  }
  // The Bot a Session speaks for: its own chat, one of its group Sessions, or an
  // earlier segment of either.
  const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
  // A Session where the Bot speaks now, as opposed to an archived segment.
  const isBotSession = id => chatOwners.has(id) || groupOwners.has(id)
  const groupSessionsOf = botId => Object.values(state.rooms).map(room => room.sessions?.[botId]).filter(Boolean)
  const dropGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    if (room.segments !== undefined) delete room.segments[botId]
    groupOwners.delete(sessionId)
    void ctx.workspaceRegistry.archiveSession(sessionId).catch(() => {})
  }
  const findBot = (ref) => {
    if (ref === undefined) return undefined
    if (state.bots[ref]) return state.bots[ref]
    const wanted = normalize(ref).replace(/^@/, '')
    return Object.values(state.bots).find(bot => normalize(bot.name) === wanted)
  }
  // Every group chat whose id or name matches; callers refuse an ambiguous name.
  const findRooms = (ref) => {
    if (ref === undefined || ref === null) return []
    if (state.rooms[ref]) return [state.rooms[ref]]
    const wanted = normalize(unquote(ref))
    return Object.values(state.rooms).filter(room => normalize(room.name) === wanted)
  }
  const isAdminOf = (room, id) => id !== undefined && room.admin === id

  Object.assign(rt, {
    state, load, save, refresh, readOnly,
    botOf, roomOf, isMain, chatOf, selfOf, isBotSession,
    chatOwners, groupOwners, pastOwners,
    groupSessionsOf, dropGroupSession, findBot, findRooms, isAdminOf,
  })
}
