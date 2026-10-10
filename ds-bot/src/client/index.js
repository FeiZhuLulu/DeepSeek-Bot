import { call } from './api.js'
import { isHex, inkText, paintCss } from './inks.js'
import { SHAPES, markupCache, maskOf } from './characters.js'
import { createSource, EMPTY_ROSTER, indexRoster, isAgentSession } from './sources.js'
import { themeCss, shellTokens, conversationTokens, registry, registerShape, registerTheme, allThemes } from './themes.js'
import { MENTION_ORIGIN, currentPart } from './text.js'
import { SHELL_CSS, CONVERSATION_CSS, installStyles, installCompiledStyles } from './styles.js'
import { lookOf } from './mark.js'
import { TeamSidebar, ConnectPlugins, YouAvatar, AccountLauncher, FooterAccount, BrandMark, BrandName, BotReturn, SIDEBAR_CSS, RETURN_CSS, holdShellShortcuts } from './sidebar.js'
import { HeaderPill } from './header.js'
import { ComposerPlus, ComposerVoice } from './composer.js'
import { AnsweredCell, QuestionCard, QuestionDock } from './questions.js'
import { AssistantCell, TriggerCell, TurnProcessCell, Nothing, TurnTailCell, ToolCell } from './cells.js'
import { Overlays } from './overlays.js'
import { createBotBrowsers, serveBrowserReads } from './bot-browsers.js'
import { BROWSER_CSS } from './browser-pane.js'
import { holdFlatTranscript } from './flat-transcript.js'
import { SECRET_CSS, SecretDock } from './secret-card.js'
import { MODEL_CSS, ModelChoiceDock, DeepSeekSignIn } from './model-menu.js'
import { BOT_SETTINGS_CSS } from './bot-settings.js'
import { GROUP_SETTINGS_CSS } from './group-settings.js'
import { USAGE_CSS } from './usage-page.js'
import { SCHEDULE_CSS } from './schedules.js'
import { STORAGE, migrateStorage } from './storage.js'
import { groupsFor, readMode, writeMode } from './surface.js'
import { installLocale, language } from './i18n.js'
import { noteClientError, quietly } from './diagnostics.js'
import { ErrorToast, FEEDBACK_CSS } from './feedback.js'

export const inject = ['sessions', 'uiWorkspace', 'slots', 'theme', 'layout', 'configForms']

export function apply(ctx) {
  ctx.effect(() => installLocale(ctx.get('locale')), 'ds-bot: interface copy')
  const roster = createSource(EMPTY_ROSTER)
  migrateStorage()
  const UNREAD_KEY = STORAGE.unread
  let savedUnread = {}
  try { savedUnread = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? '{}') ?? {} } catch { savedUnread = {} }
  const REACTIONS_KEY = STORAGE.reactions
  let savedReactions = {}
  try { savedReactions = JSON.parse(localStorage.getItem(REACTIONS_KEY) ?? '{}') ?? {} } catch { savedReactions = {} }
  // When each conversation was last left; a visit compares new turns against it.
  const SEEN_KEY = STORAGE.seen
  let seenAt = {}
  try { seenAt = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') ?? {} } catch { seenAt = {} }
  // `details` is the panel's subject (a Session id); `view` picks details or the
  // subject Bot's browser inside it.
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quote: null, settings: null, memory: null, toast: null, signIn: null, renameAgent: null, unread: savedUnread, reactions: savedReactions, visits: {} })
  // Bot mode paints the whole team surface; Agent mode withdraws every slot and
  // style so the shell's own interface returns. `plain` stays false until a Bot-mode
  // view hosts a plain session, which drops only the conversation replacements.
  const surface = createSource({ mode: readMode(), plain: false })
  // DSH Agent Session ids from the last pull, so a reload already knows the main
  // view is a plain Session before the team answers.
  let agentSessionCache = new Set()
  try { agentSessionCache = new Set(JSON.parse(localStorage.getItem(STORAGE.agentSessions) ?? '[]')) } catch { agentSessionCache = new Set() }
  // Sessions adopted on this window (workspace pick, fork) but not yet in the roster.
  const pendingAdopt = new Map()
  const isAgentSessionId = id => isAgentSession(roster.getSnapshot(), agentSessionCache, id) || pendingAdopt.has(id)
  const agentOfSession = id => roster.getSnapshot().agentOf[id] ?? pendingAdopt.get(id)
  // The workspace a Session lives in, for follow-up creates and switch detection.
  const workspaces = ctx.get('workspaces')
  const workspaceOf = (sessionId) => {
    const items = workspaces?.list?.getSnapshot()?.items ?? []
    return items.find(item => item.sessionIds?.includes(sessionId))?.workspaceId
  }
  // A navigation this plugin started: the surface effect trusts the id it lands on.
  let expected = null
  const setPlain = (plain) => surface.set(state => (state.plain === plain ? state : { ...state, plain }))
  // A DSH Agent Session shows the plain conversation: the Bot details and browser
  // panels would follow it and report it is not on the team, so they close.
  const dropPanels = () => ui.set(state => (state.details || state.renaming ? { ...state, details: null, view: 'details', renaming: false, tab: null } : state))
  // A Bot's chat spans several parts, so when it was last left is kept per Bot.
  const seenKey = id => roster.getSnapshot().byId?.[id]?.id ?? id
  const leaveVisits = (ids) => {
    const now = Date.now()
    for (const id of ids) seenAt[seenKey(id)] = now
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenAt)) } catch { /* storage unavailable */ }
  }
  ctx.effect(() => {
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, 'ds-bot: remember visits on page hide')
  const activity = createSource({})
  // Per Session, what its transcript has in flight (running tools, a streaming reply).
  const live = createSource({})
  // Per Session, the first visible time and the end time of each turn the transcript
  // has rendered; time separators compare one turn's end with the next turn's start.
  const turnClock = createSource({})
  let activityKey = '{}'
  // Per Bot, its latest memory change, and `seen`: when this window first saw it, or 0
  // for a change made before the window opened, which is no news.
  const memoryNews = createSource({})
  let memoryNewsKey
  const noteMemoryNews = (next) => {
    const key = JSON.stringify(next)
    if (key === memoryNewsKey) return
    const opening = memoryNewsKey === undefined
    memoryNewsKey = key
    memoryNews.set(state => Object.fromEntries(Object.entries(next).map(([id, entry]) => [id,
      state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() }])))
  }
  const PREFS_KEY = STORAGE.prefs
  let savedPrefs = {}
  try { savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {} } catch { savedPrefs = {} }
  const setUnread = (id, value) => ui.set((state) => {
    if (Boolean(state.unread[id]) === value) return state
    const unread = { ...state.unread }
    if (value) unread[id] = true
    else delete unread[id]
    try { localStorage.setItem(UNREAD_KEY, JSON.stringify(unread)) } catch { /* storage unavailable */ }
    return { ...state, unread }
  })
  const refreshed = new Set()
  // Pulls can overlap (the poll and a navigation); an older answer never wins.
  let pulls = 0
  let applied = 0
  const pull = async () => {
    const order = ++pulls
    const known = roster.getSnapshot()
    const value = await call('state', { since: known.revision, models: known.modelsKey ?? '', locale: language() })
    if (order < applied) return
    applied = order
    const nextActivity = JSON.stringify(value.activity ?? {})
    if (nextActivity !== activityKey) { activityKey = nextActivity; activity.set(value.activity ?? {}) }
    noteMemoryNews(value.memoryNews ?? {})
    const current = roster.getSnapshot()
    // Connector states change without a new revision, so they come with every answer.
    if (value.connectors !== undefined && current.ready && JSON.stringify(value.connectors) !== JSON.stringify(current.connectors ?? [])) {
      roster.set({ ...current, connectors: value.connectors })
    }
    if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) return
    // On a browser with no visit record yet, everything already there counts as seen.
    if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map(entry => entry.id))
    roster.set(indexRoster(value))
    try {
      const ids = (value.agents ?? []).flatMap(agent => agent.sessions ?? [])
      localStorage.setItem(STORAGE.agentSessions, JSON.stringify(ids))
      agentSessionCache = new Set(ids)
    } catch { /* storage unavailable */ }
    // Adopted ids are known by the roster now; ones gone from the list were archived.
    const listed = ctx.sessions.list.getSnapshot().byId ?? {}
    for (const id of pendingAdopt.keys()) {
      if (roster.getSnapshot().agentOf[id] !== undefined || listed[id] === undefined) pendingAdopt.delete(id)
    }
    for (const id of [...value.bots.map(currentPart), ...value.rooms.map(room => room.id)]) {
      if (refreshed.has(id)) continue
      refreshed.add(id)
      void Promise.resolve(ctx.sessions.refreshProjections?.(id)).catch(quietly('refresh projections'))
    }
  }

  ctx.effect(() => {
    let stopped = false
    let running = false
    let timer
    const loop = async () => {
      clearTimeout(timer)
      if (running || stopped) return
      running = true
      try { await pull() } catch (error) { if (!stopped) console.warn('[ds-bot] state', error) } finally { running = false }
      if (!stopped) timer = setTimeout(loop, document.hidden ? 10000 : 1500)
    }
    const wake = () => { if (!document.hidden) void loop() }
    document.addEventListener('visibilitychange', wake)
    void loop()
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, 'ds-bot: roster poll')

  // Plugin updates: every window that opens asks the host once (the host keeps its
  // answer for a while), again each hour, and every two seconds while installing.
  const update = createSource({ available: false, phase: 'idle' })
  let wakeUpdate = () => {}
  ctx.effect(() => {
    let stopped = false
    let timer
    const loop = async () => {
      clearTimeout(timer)
      if (stopped) return
      const value = await call('update-check', { fresh: false }).catch(() => null)
      if (stopped) return
      if (value) update.set(value)
      timer = setTimeout(loop, value?.phase === 'installing' ? 2000 : 60 * 60_000)
    }
    wakeUpdate = loop
    void loop()
    return () => { stopped = true; clearTimeout(timer); wakeUpdate = () => {} }
  }, 'ds-bot: update check')

  // Bot browsers need the Desktop shell's webview bridge, and the host serves
  // read_browser only in the Desktop profile (`browser` in the state).
  const bridge = window.dshDesktop?.protocolVersion === 1 ? window.dshDesktop.browser ?? null : null
  const browsers = bridge ? createBotBrowsers({ bridge, createSource }) : null
  if (browsers) {
    ctx.effect(() => {
      let stopReads = null
      const sync = () => {
        const snapshot = roster.getSnapshot()
        if (!snapshot.ready) return
        const on = snapshot.browser === true
        if (on && !stopReads) stopReads = serveBrowserReads({ browsers, post: call })
        if (!on && stopReads) { stopReads(); stopReads = null }
        // A Bot deleted here or in another window takes its guests and saved tabs along.
        void browsers.retain(snapshot.bots.map(bot => bot.id))
        // A panel open on the browser view without a browsable subject falls back
        // to the details view.
        ui.set(state => (state.details && state.view === 'browser' && (!on || !snapshot.byId[state.details]) ? { ...state, view: 'details' } : state))
      }
      sync()
      const offRoster = roster.subscribe(sync)
      return () => { offRoster(); stopReads?.(); browsers.dispose() }
    }, 'ds-bot: Bot browsers')
  }

  ctx.effect(() => () => { markupCache.clear() }, 'ds-bot: character markup')

  // Mentions wear each Bot's color and character silhouette (or its photo).
  const installMentions = () => {
    const style = installStyles('', 'mentions')
    let last = ''
    const render = () => {
      const next = roster.getSnapshot().bots.map((bot) => {
        const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`
        const look = lookOf(bot)
        const mark = look.image
          ? `${anchor}::before{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
          : `${anchor}::before{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`
        return `${anchor}{color:${inkText(look.color)}}${mark}`
      }).join('\n')
      if (next !== last) style.textContent = last = next
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => { offRoster(); offRegistry(); style.remove() }
  }

  // The chosen theme lives in the team state so every device shares it; the local
  // copy only avoids a flash of the default theme before the first state pull.
  const installTheme = () => {
    const style = installStyles('', 'theme')
    let key = ''
    let releaseTokens = null
    const render = () => {
      const snapshot = roster.getSnapshot()
      const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
      const themes = allThemes()
      const id = themes[prefs.theme] ? prefs.theme : 'deepseek'
      const accent = isHex(prefs.accent) ? prefs.accent : undefined
      const motion = prefs.motion === 'quiet' || prefs.motion === 'lively' ? prefs.motion : 'normal'
      document.body.dataset.btMotion = motion
      const next = `${id}|${accent ?? ''}|${motion}|${registry.getSnapshot()}`
      if (next === key) return
      key = next
      style.textContent = themeCss(themes[id], accent)
      const release = releaseTokens
      releaseTokens = ctx.theme.overrideTokens('ds-bot', shellTokens(themes[id]))
      if (typeof release === 'function') release()
      if (snapshot.ready) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: prefs.theme, accent: prefs.accent, motion: prefs.motion })) } catch { /* storage unavailable */ }
      }
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => {
      offRoster()
      offRegistry()
      if (typeof releaseTokens === 'function') releaseTokens()
      delete document.body.dataset.btMotion
      style.remove()
    }
  }

  // The user-bubble token rides with the conversation group, so a plain Session
  // keeps dsh's own bubble colors while the Bot shell stays themed.
  const installBubbleTokens = () => {
    let release = null
    let key = ''
    const render = () => {
      const snapshot = roster.getSnapshot()
      const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
      const themes = allThemes()
      const id = themes[prefs.theme] ? prefs.theme : 'deepseek'
      const next = `${id}|${registry.getSnapshot()}`
      if (next === key) return
      key = next
      const drop = release
      release = ctx.theme.overrideTokens('ds-bot: conversation', conversationTokens(themes[id]))
      if (typeof drop === 'function') drop()
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => { offRoster(); offRegistry(); if (typeof release === 'function') release() }
  }

  ctx.effect(() => {
    const hub = { registerShape, registerTheme, themes: () => Object.keys(allThemes()), shapes: () => Object.keys(SHAPES) }
    const queued = Array.isArray(window.dshBotQueue) ? window.dshBotQueue : []
    window.dshBot = hub
    window.dshBotQueue = { push: (task) => { try { task(hub) } catch (error) { console.warn('[ds-bot] registration', error); noteClientError('registration', error) } } }
    for (const task of queued) window.dshBotQueue.push(task)
    return () => {
      if (window.dshBot === hub) delete window.dshBot
      delete window.dshBotQueue
    }
  }, 'ds-bot: registry')

  ctx.inject(['shortcuts'], scope => { scope.effect(() => holdShellShortcuts(scope.shortcuts), 'ds-bot: settings shortcut') })

  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })
  // A Bot id, or any part of its chat, opens the Bot's current part.
  const partFor = (id) => {
    const bot = roster.getSnapshot().byId[id]
    return bot ? currentPart(bot) : id
  }
  // Sessions owned by an Agent, including ones adopted before the roster caught up.
  const agentSessions = (agentId) => {
    const ids = [...(roster.getSnapshot().agentsById[agentId]?.sessions ?? [])]
    for (const [id, owner] of pendingAdopt) if (owner === agentId && !ids.includes(id)) ids.push(id)
    return ids
  }
  const actions = {
    // The full-pane overlays sit above the conversation, so opening one must dismiss them
    // or the click appears to do nothing.
    isAgentSession: id => isAgentSessionId(id),
    openSession: (id) => {
      // A DSH Agent Session id lands on the plain surface, not the Bot skin.
      if (isAgentSessionId(id)) return actions.openAgentSession(id)
      ui.set(state => (state.newChat || state.exchange || state.menu || state.palette ? { ...state, newChat: null, exchange: null, menu: null, palette: null } : state))
      setPlain(false)
      const target = partFor(id)
      expected = target
      ctx.uiWorkspace.openSession(target)
    },
    // The conversation replacements withdraw for a plain Session; set the surface
    // before the navigation so the Bot skin never flashes.
    openAgentSession: (sessionId) => {
      ui.set(state => ({ ...state, newChat: null, exchange: null, menu: null, palette: null, details: null, view: 'details', renaming: false, tab: null }))
      setPlain(true)
      expected = sessionId
      ctx.uiWorkspace.openSession(sessionId)
    },
    addAgent: async () => {
      const agent = await after(call('add-agent'))
      if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0])
      return agent
    },
    openAgent: (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      const list = ctx.sessions.list.getSnapshot()
      const recent = agentSessions(agentId).sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))
      if (recent.length === 0) return actions.newAgentSession(agentId)
      actions.openAgentSession(recent[0])
    },
    newAgentSession: async (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      const list = ctx.sessions.list.getSnapshot()
      const recent = agentSessions(agentId).sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))
      // An untouched Session is already the new conversation the user wants.
      if (recent.length > 0 && list.byId[recent[0]]?.blank === true) {
        actions.openAgentSession(recent[0])
        return recent[0]
      }
      const { sessionId } = await after(call('agent-session', { agentId, workspaceId: workspaceOf(recent[0]) }))
      actions.openAgentSession(sessionId)
      return sessionId
    },
    archiveAgentSession: async (agentId, sessionId) => {
      await after(call('agent-archive', { agentId, sessionId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== sessionId) return
      const rest = roster.getSnapshot().agentsById[agentId]?.sessions ?? []
      if (rest.length > 0) actions.openAgent(agentId)
      else if (roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
    },
    renameAgentSession: (agentId, sessionId, title) => after(call('agent-rename', { agentId, sessionId, title })),
    beginAgentRename: sessionId => ui.set(state => ({ ...state, renameAgent: sessionId })),
    endAgentRename: () => ui.set(state => (state.renameAgent ? { ...state, renameAgent: null } : state)),
    // Removing the Agent archives every Session it owns; one of them may fill the
    // main view, and it must not stay there wearing the Bot surface afterwards.
    removeAgent: async (agentId) => {
      const owned = agentSessions(agentId)
      const result = await after(call('remove-agent', { agentId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== undefined && owned.includes(main) && roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
      return result
    },
    // `last` is the Bot conversation the view held before it cleared: when that part
    // was archived for a fresh one, the view goes on in the fresh one.
    landOn: async (id, last) => {
      if (last) await pull().catch(() => {})
      const bot = last ? roster.getSnapshot().byId[last.botId] : undefined
      setPlain(false)
      const target = bot && currentPart(bot) !== last.sessionId ? currentPart(bot) : partFor(id)
      expected = target
      ctx.uiWorkspace.openSession(target)
    },
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    openNewChat: (mode) => { ui.set(state => ({ ...state, newChat: mode, menu: null, palette: null })) },
    openPalette: (query = '') => { ui.set(state => ({ ...state, palette: { query, token: Date.now() }, newChat: null, menu: null })) },
    // The token keeps a late exit timer from closing a palette opened again since.
    closePalette: (token) => { ui.set(state => (state.palette && (token === undefined || state.palette.token === token) ? { ...state, palette: null } : state)) },
    openExchange: (a, b) => { if (a && b) ui.set(state => ({ ...state, exchange: [a, b] })) },
    openVoice: (id) => { if (id) ui.set(state => ({ ...state, voice: id, menu: null })) },
    closeVoice: () => { ui.set(state => (state.voice ? { ...state, voice: null } : state)) },
    toggleDetails: (id, force) => {
      ui.set((state) => {
        const details = force || state.details !== id || state.view !== 'details' ? id : null
        return { ...state, renaming: false, tab: null, details, view: 'details' }
      })
    },
    // The open panel follows the main view; a subject with no browser (a group
    // chat, an outside Session) settles on the details view.
    followPanel: (id) => {
      ui.set((state) => {
        if (!state.details || state.details === id) return state
        const view = state.view === 'browser' && roster.getSnapshot().byId[id] === undefined ? 'details' : state.view
        return { ...state, details: id, view, renaming: false, tab: null }
      })
    },
    showDetails: (id, tab = null) => { ui.set(state => ({ ...state, details: id, view: 'details', renaming: false, tab })) },
    // Opening the conversation would move focus to its composer and blur the name field.
    renameBot: (id) => { ui.set(state => ({ ...state, details: id, view: 'details', renaming: true, tab: null })) },
    // `id` opens one Bot (page 'bots') or one group chat (page 'groups').
    openSettings: (page = 'general', id = null) => { ui.set(state => ({ ...state, settings: { page, id }, menu: null, palette: null, newChat: null })) },
    closeSettings: () => { ui.set(state => (state.settings ? { ...state, settings: null } : state)) },
    openMemory: (botId) => { ui.set(state => ({ ...state, memory: botId, menu: null, palette: null })) },
    closeMemory: () => { ui.set(state => (state.memory ? { ...state, memory: null } : state)) },
    openConnectors: () => { ui.set(state => ({ ...state, settings: { page: 'connectors', id: null }, menu: null, palette: null, newChat: null })) },
    // Agent mode hands the surface back to the shell; everything open on the Bot
    // surface closes first so nothing stale reopens on the way back.
    setSurface: (mode) => {
      if (mode !== 'bot' && mode !== 'agent') return
      if (surface.getSnapshot().mode === mode) return
      if (mode === 'agent') {
        ui.set(state => ({ ...state, details: null, view: 'details', settings: null, palette: null, newChat: null, menu: null, voice: null, exchange: null, memory: null, toast: null }))
      }
      writeMode(mode)
      surface.set(state => ({ ...state, mode }))
      if (mode !== 'bot') return
      // Back in Bot mode the view must hold a team conversation; an outside
      // Session left over from Agent mode would wear the Bot skin without one.
      const home = () => {
        const snapshot = roster.getSnapshot()
        if (!snapshot.ready || !snapshot.mainBotId) return
        const list = ctx.sessions.list.getSnapshot()
        const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
        if (main !== undefined && snapshot.byId[main] === undefined && snapshot.roomsById[main] === undefined) {
          actions.openSession(snapshot.mainBotId)
        }
      }
      if (roster.getSnapshot().ready) home()
      else {
        const off = roster.subscribe(() => {
          if (!roster.getSnapshot().ready) return
          off()
          home()
        })
      }
    },
    markUnread: id => setUnread(id, true),
    beginVisit: (id) => {
      // A conversation a Bot started, never opened here, is unread from its start.
      const made = roster.getSnapshot().byId[id] ?? roster.getSnapshot().roomsById[id]
      const seen = seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null)
      ui.set(state => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }))
    },
    endVisit: (id) => {
      leaveVisits([id])
      ui.set((state) => {
        if (!(id in (state.visits ?? {}))) return state
        const visits = { ...state.visits }
        delete visits[id]
        return { ...state, visits }
      })
    },
    toggleReaction: (key, index, emoji) => ui.set((state) => {
      const entry = { ...(state.reactions?.[key] ?? {}) }
      const list = entry[index] ?? []
      entry[index] = list.includes(emoji) ? list.filter(item => item !== emoji) : [...list, emoji]
      if (entry[index].length === 0) delete entry[index]
      const reactions = { ...state.reactions }
      if (Object.keys(entry).length) reactions[key] = entry
      else delete reactions[key]
      try { localStorage.setItem(REACTIONS_KEY, JSON.stringify(reactions)) } catch { /* storage unavailable */ }
      return { ...state, reactions }
    }),
    quote: (sessionId, text) => ui.set(state => ({ ...state, quote: { sessionId, text, token: Date.now() } })),
    clearQuote: token => ui.set(state => (state.quote?.token === token ? { ...state, quote: null } : state)),
    clearUnread: id => setUnread(id, false),
    setFlags: (id, flags) => after(call('set-flags', { id, ...flags })),
    deleteRoom: id => after(call('delete-room', { id })),
    openMenu: (menu) => { ui.set(state => ({ ...state, menu })) },
    closeMenu: () => { ui.set(state => (state.menu ? { ...state, menu: null } : state)) },
    closeOverlay: () => { ui.set(state => ({ ...state, newChat: null, exchange: null, details: state.newChat || state.exchange ? state.details : null })) },
    createBot: payload => after(call('create-bot', payload)),
    createRoom: (members, options = {}) => after(call('create-room', { members, ...options })),
    updateBot: (id, patch) => after(call('update-bot', { id, ...patch })),
    refreshModels: () => after(call('models')).catch(() => {}),
    deleteBot: id => after(call('delete-bot', { id })),
    duplicateBot: id => after(call('duplicate-bot', { id })),
    setPrefs: prefs => after(call('set-prefs', prefs)),
    setMain: (id, main = true, options = {}) => after(call('set-main', { id, main, ...options })),
    updateRoom: (id, patch) => after(call('update-room', { id, ...patch })),
    send: (sessionId, text) => after(call('send', { sessionId: partFor(sessionId), text })),
    answerQuestion: (sessionId, questionId, answer) => after(call('answer-question', { sessionId: partFor(sessionId), questionId, answer })),
    dismissQuestion: sessionId => after(call('dismiss-question', { sessionId })),
    // Values go out in these requests and never come back in a response.
    secretSet: payload => after(call('secret-set', payload)),
    secretAllow: requestId => after(call('secret-allow', { requestId })),
    secretCancel: requestId => after(call('secret-cancel', { requestId })),
    secretUpdate: (name, scope) => after(call('secret-update', { name, scope })),
    secretDelete: name => after(call('secret-delete', { name })),
    connectorConnect: (id, token) => after(call('connector-connect', { id, token })),
    connectorDisconnect: id => after(call('connector-disconnect', { id })),
    connectorRetry: id => after(call('connector-retry', { id })),
    schedules: () => call('schedules'),
    scheduleCreate: task => call('schedule-create', task),
    scheduleDelete: (sessionId, id) => call('schedule-delete', { sessionId, id }),
    exchange: (a, b) => call('exchange', { a, b }).catch(() => []),
    roomProgress: roomId => call('room-progress', { roomId }).catch(() => []),
    earlier: (sessionId, cursor) => call('earlier', { sessionId, cursor: cursor ?? null }),
    // Hours come back in this browser's time zone, so days start at local midnight.
    usage: () => call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    // `summarize` starts a summary when the entries changed; `regenerate` always does.
    memoryView: (botId, flags = {}) => call('memory-view', { botId, ...flags }),
    memoryAsk: (botId, text) => call('memory-ask', { botId, text }),
    memoryForget: (botId, entry) => call('memory-forget', { botId, scope: entry.scope, topic: entry.topic, text: entry.text }),
    diagnostics: payload => call('diagnostics', payload),
    diagnosticsLog: () => call('diagnostics-log'),
    diagnosticsClear: () => call('diagnostics-clear'),
    // A failed action away from any form (a menu, the palette) shows as a toast.
    reportError: (error, where = 'action') => {
      noteClientError(where, error)
      ui.set(state => ({ ...state, toast: { text: error?.message ?? String(error), token: Date.now() } }))
    },
    dismissToast: token => ui.set(state => (state.toast && (token === undefined || state.toast.token === token) ? { ...state, toast: null } : state)),
  }
  // Without the Desktop bridge these stay undefined, and no browser control renders.
  if (browsers) {
    Object.assign(actions, {
      // The globe button: the Bot's active tab in the browser view, or a new tab.
      openBrowser: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.ensureTabs(bot.id)
        if (browsers.tabs.getSnapshot()[bot.id]?.active == null) browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
      },
      // '+' on the strip or the drawer's new-tab card: a blank tab in the browser view.
      browserNewTab: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return null
        browsers.ensureTabs(bot.id)
        const tabId = browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null }))
        return tabId
      },
      // A drawer card: its tab active, the panel on the browser view.
      browserPick: (id, tabId) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.activate(bot.id, tabId)
        ui.set(state => ({ ...state, details: id, view: 'browser' }))
      },
      browserEnsure: botId => browsers.ensureTabs(botId),
      browserCloseTab: (botId, tabId) => browsers.closeTab(botId, tabId),
      browserActivate: (botId, tabId) => browsers.activate(botId, tabId),
      browserShow: (tabId, box) => browsers.show(tabId, box),
      browserNavigate: (tabId, input) => browsers.navigate(tabId, input),
      browserCommand: (tabId, name) => browsers.command(tabId, name),
      browserFocus: (tabId) => browsers.focus(tabId),
    })
  }
  actions.setPanelView = (view) => {
    if (view !== 'details' && view !== 'browser') return
    ui.set(state => (state.details && state.view !== view ? { ...state, view } : state))
  }
  actions.closePanel = () => { ui.set(state => (state.details ? { ...state, details: null, view: 'details', renaming: false, tab: null } : state)) }
  // Whether AccountLauncher holds the shell's settings seat; FooterAccount steps aside if so.
  actions.signInEntry = () => ctx.slots.entries?.('settings.models.sign-in')?.[0] ?? null
  actions.canSignIn = () => Boolean(actions.signInEntry())
  actions.signIn = () => ui.set(state => ({ ...state, signIn: (state.signIn ?? 0) + 1 }))
  actions.closeSignIn = () => ui.set(state => ({ ...state, signIn: null }))
  actions.accountT = () => ctx.get('locale').bind('settings.account')
  actions.seatAccount = on => ui.set(state => (state.accountSeated === on ? state : { ...state, accountSeated: on }))
  // The install runs on the host; the check loop follows it every two seconds.
  actions.installUpdate = async () => {
    update.set(await call('update-install'))
    wakeUpdate()
  }
  actions.noteTurnTime = (sessionId, turn, key, time) => {
    if (sessionId === undefined || !Number.isFinite(turn) || !Number.isFinite(time)) return
    turnClock.set((state) => {
      const turns = state[sessionId] ?? {}
      const entry = turns[turn] ?? {}
      const next = key === 'first' && entry.first !== undefined ? Math.min(entry.first, time) : time
      if (entry[key] === next) return state
      return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, [key]: next } } }
    })
  }
  actions.noteTurnPeer = (sessionId, turn, peerId) => {
    if (sessionId === undefined || !Number.isFinite(turn)) return
    turnClock.set((state) => {
      const turns = state[sessionId] ?? {}
      const entry = turns[turn] ?? {}
      if (entry.peer === peerId) return state
      return { ...state, [sessionId]: { ...turns, [turn]: { ...entry, peer: peerId } } }
    })
  }
  actions.noteLive = (sessionId, id, entry) => {
    if (sessionId === undefined) return
    live.set((state) => {
      const own = state[sessionId] ?? {}
      const prev = own[id]
      if (entry === null ? prev === undefined : prev !== undefined && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...entry, at: 0 })) return state
      const next = { ...own }
      if (entry === null) delete next[id]
      else next[id] = { ...entry, at: prev?.at ?? Date.now() }
      return { ...state, [sessionId]: next }
    })
  }
  actions.clearLive = sessionId => live.set((state) => {
    if (!state[sessionId]) return state
    const next = { ...state }
    delete next[sessionId]
    return next
  })
  const browserPages = browsers?.pages ?? createSource({})
  const browserTabs = browsers?.tabs ?? createSource({})
  const face = () => ({ actions, hooks: { roster, ui, activity, memoryNews, registry, turnClock, live, browserPages, browserTabs, surface, update } })

  const shadow = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component))

  // The shell group paints the team surface around the session; the conversation
  // group re-skins the session itself. Every disposer comes from slots.inject, so a
  // surface change withdraws the whole group and the outlets re-render.
  const installShell = () => [
    installCompiledStyles(SHELL_CSS, 'shell'),
    installCompiledStyles(SIDEBAR_CSS, 'sidebar'),
    installCompiledStyles(SECRET_CSS, 'secrets'),
    installCompiledStyles(MODEL_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS, 'models'),
    installCompiledStyles(USAGE_CSS, 'usage'),
    installCompiledStyles(SCHEDULE_CSS, 'schedules'),
    installCompiledStyles(FEEDBACK_CSS, 'feedback'),
    browsers ? installCompiledStyles(BROWSER_CSS, 'browser') : null,
    installTheme(),
    shadow('sidebar.workspaces', { priority: -10, inject: face }, TeamSidebar),
    shadow('sidebar.brand.mark', { priority: -10 }, BrandMark),
    shadow('sidebar.brand.name', { priority: -10 }, BrandName),
    shadow('sidebar.footer.action', { id: 'bot-account', order: -200, inject: face }, FooterAccount),
    shadow('sidebar.footer.action', { id: 'bot-connect', order: -100, inject: face }, ConnectPlugins),
    shadow('settings.trigger', { priority: -10 }, YouAvatar),
    // ui-chat's "Transcript view" row: a lower priority on the same list id shadows it.
    shadow('settings.general.item', { id: 'transcript-view', priority: -10 }, Nothing),
    // At priority -10 the whale wins the seat over a shell account plugin's own
    // launcher (the Desktop's "··· More"), which comes back in Agent mode.
    shadow('settings.launcher', { priority: -10, inject: face }, AccountLauncher),
    shadow('shell.overlay', { id: 'bot', order: 50, inject: face }, Overlays),
    shadow('shell.overlay', { id: 'bot-signin', order: 55, inject: face }, DeepSeekSignIn),
    shadow('shell.overlay', { id: 'bot-toast', order: 60, inject: face }, ErrorToast),
  ]
  const installConversation = () => [
    installCompiledStyles(CONVERSATION_CSS, 'conversation'),
    installBubbleTokens(),
    installMentions(),
    // Bot conversations are always flat, so the work-details mode is not a choice:
    // the mode is held at `verbose` while this group is mounted.
    holdFlatTranscript(ctx.configForms.get('ui-chat')),
    shadow('conversation.session.header', { priority: -10, inject: face }, HeaderPill),
    shadow('conversation.chat.node', { key: 'assistant-step', priority: -10, locale: 'chat', inject: face }, AssistantCell),
    shadow('conversation.chat.node', { key: 'turn-trigger', priority: -10, locale: 'chat', inject: face }, TriggerCell),
    shadow('conversation.chat.node', { key: 'tool-call', priority: -10, locale: 'chat', inject: face }, ToolCell),
    shadow('conversation.chat.node', { key: 'turn-process', priority: -10, locale: 'chat', inject: face }, TurnProcessCell),
    shadow('conversation.chat.node', { key: 'turn-tail', priority: -10, locale: 'chat', inject: face }, TurnTailCell),
    // A Bot condenses its conversation without telling anyone; the chat keeps showing
    // every message.
    shadow('conversation.chat.node', { key: 'question-reply', priority: -10, locale: 'chat' }, AnsweredCell),
    shadow('conversation.chat.node', { key: 'compaction', priority: -10, locale: 'chat' }, Nothing),
    shadow('conversation.input.permission', { priority: -10 }, Nothing),
    shadow('conversation.input.plan', { priority: -10 }, Nothing),
    // The composer carries no model picker or run statistics; a Bot's model lives
    // in its details panel.
    shadow('conversation.input.model', { priority: -10 }, Nothing),
    shadow('conversation.composer.dock', { id: 'activity', order: 0, priority: -10 }, Nothing),
    shadow('conversation.composer.dock', { id: 'usage', order: 1, priority: -10 }, Nothing),
    shadow('conversation.input.left', { id: 'bot-plus', order: -100, inject: face }, ComposerPlus),
    shadow('conversation.input.right', { id: 'bot-voice', order: 100, inject: face }, ComposerVoice),
    shadow('conversation.composer', {
      priority: -10,
      select: owner => (owner.pendingInteraction?.kind === 'question' ? owner.pendingInteraction : null),
    }, QuestionCard),
    shadow('conversation.input.dock', { id: 'bot-model', order: -110, inject: face }, ModelChoiceDock),
    shadow('conversation.input.dock', { id: 'bot-question', order: -100, inject: face }, QuestionDock),
    shadow('conversation.input.dock', { id: 'bot-secret', order: -90, inject: face }, SecretDock),
  ]
  // The return button belongs to neither group: it renders only in Agent mode.
  ctx.effect(() => {
    const style = installStyles(RETURN_CSS, 'return')
    return () => style.remove()
  }, 'ds-bot: return styles')
  shadow('sidebar.footer.action', { id: 'bot-return', order: -300, inject: face }, BotReturn)

  // The main view decides `plain`: a DSH Agent Session keeps the Bot shell but
  // withdraws the conversation replacements, so the native dsh page shows. A jump
  // this plugin did not start — the hero's workspace picker or a fork — opens an
  // unowned Session; coming from a DSH Agent Session it is adopted into that Agent.
  ctx.effect(() => {
    let previous
    const sync = () => {
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      const plain = isAgentSessionId(main)
      setPlain(plain)
      if (plain) dropPanels()
      if (main === previous) return
      const before = previous
      previous = main
      const ours = expected !== null && main === expected
      expected = null
      if (ours || main === undefined) return
      // Adoption is a Bot-mode affair: in Agent mode the native sidebar owns
      // navigation, and opening an existing Session there must not pull it in.
      if (surface.getSnapshot().mode !== 'bot') return
      const agentId = before !== undefined ? agentOfSession(before) : undefined
      if (agentId === undefined) return
      const snapshot = roster.getSnapshot()
      if (snapshot.byId[main] !== undefined || snapshot.roomsById[main] !== undefined || agentOfSession(main) !== undefined) return
      // Only a Session this jump created joins the Agent: a blank one from the
      // workspace picker, or a fork of a Session the same Agent owns. An existing
      // Session the user opened from the sidebar keeps its team tools and stays out.
      const row = list.byId[main]
      // The client list maps the fork's parent to `parentId`; the raw field is
      // the fallback for shapes that skip the mapping.
      const parent = row?.parentId ?? row?.parentSessionId
      const forkedFromAgent = parent !== undefined && agentOfSession(parent) === agentId
      if (row?.blank !== true && !forkedFromAgent) return
      pendingAdopt.set(main, agentId)
      setPlain(true)
      void call('agent-adopt', { agentId, sessionId: main }).then(() => pull()).catch((error) => {
        pendingAdopt.delete(main)
        console.warn('[ds-bot] agent-adopt', error)
        // The Session never joined the Agent: the sync puts the team surface
        // back (a Map delete fires no subscription), and the user hears why.
        sync()
        actions.reportError(error, 'agent-adopt')
      })
      // The hero's workspace picker leaves the blank Session it switched away from
      // behind; in another workspace it stays empty forever, so it is archived.
      const next = workspaceOf(main)
      if (list.byId[before]?.blank === true && next !== undefined && workspaceOf(before) !== next) {
        void call('agent-archive', { agentId, sessionId: before }).then(() => pull()).catch(() => {})
      }
    }
    const offList = ctx.sessions.list.subscribe(sync)
    const offRoster = roster.subscribe(sync)
    sync()
    return () => { offList(); offRoster() }
  }, 'ds-bot: agent surface')

  ctx.effect(() => {
    const mounted = { shell: [], conversation: [] }
    const reconcile = () => {
      const wanted = groupsFor(surface.getSnapshot())
      for (const group of ['shell', 'conversation']) {
        if (wanted[group] === (mounted[group].length > 0)) continue
        if (wanted[group]) mounted[group] = (group === 'shell' ? installShell : installConversation)()
        else { for (const dispose of mounted[group]) dispose?.(); mounted[group] = [] }
      }
    }
    reconcile()
    const unsub = surface.subscribe(reconcile)
    return () => {
      unsub()
      for (const group of ['shell', 'conversation']) { for (const dispose of mounted[group]) dispose?.(); mounted[group] = [] }
    }
  }, 'ds-bot: surface')
}
