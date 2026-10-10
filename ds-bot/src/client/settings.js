import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { ACCENT_INKS, INKS } from './inks.js'
import { isMainOf } from './sources.js'
import { allThemes } from './themes.js'
import { CloseIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, ConnectorIcon, PlusIcon, SlidersIcon, SETTINGS_ICONS } from './icons.js'
import { AdminStar, BotAvatar, RoomAvatar } from './mark.js'
import { openHarnessSettings } from './sidebar.js'
import { useEscape } from './overlay-hooks.js'
import { BotSettingsForm } from './bot-settings.js'
import { Segmented, useGlide } from './motion.js'
import { GroupSettingsForm, NewGroupForm } from './group-settings.js'
import { CreateBot } from './create-bot.js'
import { KeyIcon, SecretsPage } from './secret-card.js'
import { UsagePage } from './usage-page.js'
import { ConnectorsPage } from './connectors.js'
import { SchedulesPage } from './schedules.js'
import { FeedbackIcon, FeedbackPage } from './feedback.js'
import { t } from './i18n.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

// Settings dialog: a 198px page list beside the page. Bots and group chats each list
// their members, and one opens on its own settings form. Usage widens the dialog.
const SETTINGS_PAGES = [['general', 'General'], ['bots', 'Bots'], ['groups', 'Group chats'], ['connectors', 'Connectors'], ['schedules', 'Scheduled tasks'], ['usage', 'Usage'], ['secrets', 'Secrets'], ['feedback', 'Feedback']]
const PAGE_ICONS = { ...SETTINGS_ICONS, connectors: ConnectorIcon, schedules: ClockIcon, secrets: KeyIcon, feedback: FeedbackIcon }

function SetSection({ title, children }) {
  return h('section', { className: 'bt-set-section' }, h('h3', null, title), h('div', { className: 'bt-set-card' }, children))
}
function SetRow({ label, hint, children }) {
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: 'bt-set-control' }, children) : null)
}

function GeneralPage({ roster, actions, run }) {
  const prefs = roster.prefs ?? {}
  const themes = allThemes()
  const current = themes[prefs.theme] ? prefs.theme : 'deepseek'
  const [custom, setCustom] = useState(prefs.accent ?? '#4d6bfe')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const pickCustom = (value) => {
    setCustom(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => run(actions.setPrefs({ accent: value })), 350)
  }
  return [
    h(SetSection, { key: 'look', title: t('Appearance') },
      h(SetRow, { label: t('Theme'), hint: t('Colors for the whole team, on every device.') },
        h('select', { className: 'bt-select', 'aria-label': t('Theme'), value: current, onChange: event => run(actions.setPrefs({ theme: event.target.value })) },
          Object.entries(themes).map(([id, theme]) => h('option', { key: id, value: id }, t(theme.label))))),
      h(SetRow, { label: t('Accent'), hint: t('Unread marks, badges, and the brand mark.') },
        h('div', { className: 'bt-swatches' },
          h('button', { type: 'button', className: 'bt-swatch bt-swatch-default', title: t('Theme accent'), 'aria-label': t('Theme accent'), 'aria-pressed': !prefs.accent, onClick: () => run(actions.setPrefs({ accent: null })) }),
          ACCENT_INKS.map(ink => h('button', {
            key: ink, type: 'button', className: 'bt-swatch', title: t(capitalize(ink)), 'aria-label': t(capitalize(ink)), 'aria-pressed': prefs.accent === INKS[ink][0],
            style: { background: INKS[ink][0] }, onClick: () => run(actions.setPrefs({ accent: INKS[ink][0] })),
          })),
          h('label', { className: 'bt-swatch bt-swatch-custom', title: t('Custom accent'), 'data-on': Boolean(prefs.accent) && !ACCENT_INKS.some(ink => INKS[ink][0] === prefs.accent) },
            h('input', { type: 'color', value: custom, 'aria-label': t('Custom accent'), onChange: event => pickCustom(event.target.value) }))))),
    h(SetSection, { key: 'mode', title: t('Mode') },
      h(SetRow, { label: t('Classic Agent mode') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.setSurface('agent') }, t('Switch')))),
  ]
}

// The first Main Bot is the sidebar tile. Picking another Bot there hands it the role
// in one step; more Main Bots can sit beside it.
function MainBotsSection({ roster, actions, run }) {
  const mains = (roster.mainBotIds ?? []).map(id => roster.byId[id]).filter(Boolean)
  const [first, ...others] = mains
  const candidates = roster.bots.filter(bot => !isMainOf(roster, bot.id))
  return h(SetSection, { title: t('Main Bot') },
    h(SetRow, {
      label: t('Main Bot'),
      hint: first ? t('First in the sidebar. Pick another Bot to hand it the role; {name} then stops being a Main Bot.', { name: first.name }) : undefined,
    },
    h('select', {
      className: 'bt-select', 'aria-label': t('Main Bot'), value: first?.id ?? '',
      onChange: event => run(actions.setMain(event.target.value, true, first ? { replace: first.id } : {})),
    }, first ? null : h('option', { value: '' }, t('Choose a Bot…')), roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
    others.map(bot => h(SetRow, { key: bot.id, label: bot.name, hint: t('Also a Main Bot.') },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, true, { primary: true })) }, t('Move to first')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, false)) }, t('Remove Main Bot role')))),
    candidates.length > 0 ? h(SetRow, { label: t('Add a Main Bot'), hint: t('Main Bots can create and change Bots, and run every group chat.') },
      h('select', {
        className: 'bt-select', 'aria-label': t('Add a Main Bot'), value: '',
        onChange: (event) => { if (event.target.value) void run(actions.setMain(event.target.value, true)) },
      }, h('option', { value: '' }, t('Choose a Bot…')), candidates.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))) : null)
}

const MOTIONS = [['quiet', 'Quiet'], ['normal', 'Normal'], ['lively', 'Lively']]
function MotionSection({ roster, actions, run }) {
  const motion = roster.prefs?.motion === 'quiet' || roster.prefs?.motion === 'lively' ? roster.prefs.motion : 'normal'
  return h(SetSection, { title: t('Animation') },
    h(SetRow, { label: t('Bot animation') },
      h(Segmented, { label: t('Bot animation'), value: motion, className: 'bt-motion-seg' }, MOTIONS.map(([id, label]) => h('button', {
        key: id, type: 'button', 'aria-pressed': motion === id,
        onClick: () => { if (motion !== id) run(actions.setPrefs({ motion: id })) },
      }, t(label))))))
}

function BotsPage({ roster, actions, run }) {
  const [creating, setCreating] = useState(false)
  return [
    h(MainBotsSection, { key: 'main', roster, actions, run }),
    h(MotionSection, { key: 'motion', roster, actions, run }),
    creating
      ? h(CreateBot, { key: 'create', roster, actions, inline: true, onBack: () => setCreating(false), onCreated: bot => actions.openSettings('bots', bot.id) })
      : h('div', { key: 'new', className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setCreating(true) }, h(PlusIcon), t('New Bot'))),
    h(SetSection, { key: 'bots', title: t('Bots · {count}', { count: roster.bots.length }) },
      roster.bots.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('bots', bot.id) },
        h('span', { className: 'bt-set-bot' },
          h(BotAvatar, { bot, size: 28, badge: false, live: false }),
          h('span', { className: 'bt-row-title' }, bot.name),
          bot.role ? h('span', { className: 'bt-tag' }, bot.role) : null,
          isMainOf(roster, bot.id) ? h('span', { className: 'bt-tag' }, t('Main Bot')) : null,
          bot.hidden && !isMainOf(roster, bot.id) ? h('span', { className: 'bt-tag' }, t('Hidden')) : null),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))))),
  ]
}

function GroupsPage({ roster, actions, run }) {
  const [creating, setCreating] = useState(false)
  return [
    creating
      ? h(NewGroupForm, { key: 'create', roster, actions, run, onCancel: () => setCreating(false), onCreated: room => actions.openSettings('groups', room.id) })
      : h('div', { key: 'new', className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: roster.bots.length < 2, title: roster.bots.length < 2 ? t('A group chat needs at least two Bots') : undefined, onClick: () => setCreating(true) }, h(PlusIcon), t('Create group chat'))),
    h(SetSection, { key: 'groups', title: t('Group chats · {count}', { count: roster.rooms.length }) },
      roster.rooms.length === 0
        ? h(SetRow, { label: t('No group chats yet.'), hint: t('A group chat lets several Bots work on one thing with you.') })
        : roster.rooms.map((room) => {
            const admin = roster.byId[room.admin]
            return h('button', { key: room.id, type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('groups', room.id) },
              h('span', { className: 'bt-set-bot' },
                h(RoomAvatar, { room, roster, size: 28 }),
                h('span', { className: 'bt-row-title' }, room.name),
                h('span', { className: 'bt-tag' }, t('{count} members', { count: room.members.length })),
                admin ? h('span', { className: 'bt-tag bt-tag-admin' }, h(AdminStar), admin.name) : null,
                room.hidden ? h('span', { className: 'bt-tag' }, t('Hidden')) : null),
              h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))
          })),
  ]
}

// While `leaving`, the dialog plays its exit and takes no input.
export function SettingsDialog({ page, id, roster, actions, leaving = false }) {
  const [error, setError] = useState('')
  const close = useCallback(() => actions.closeSettings(), [])
  useEscape(close)
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })
  // A Bot or group deleted while its form is open leaves its page on the list.
  const bot = page === 'bots' && id ? roster.byId[id] : undefined
  const room = page === 'groups' && id ? roster.roomsById[id] : undefined
  const shown = SETTINGS_PAGES.some(([key]) => key === page) ? page : 'general'
  const usageFocus = shown === 'usage' && id ? id : null
  const label = t(SETTINGS_PAGES.find(([key]) => key === shown)[1])
  const back = bot ? t('Back to Bots') : room ? t('Back to group chats') : usageFocus ? t('All usage') : null
  const nav = useGlide(shown, { axis: 'y' })
  // A page enters from the right when it is one level in, from the left when it comes
  // back out, and from below beside it. Usage keeps its own entrance and its data
  // across its own levels, so they share one page.
  const pageKey = `${shown}:${bot?.id ?? room?.id ?? ''}`
  const depth = bot || room ? 1 : 0
  const last = useRef({ key: pageKey, depth, move: 'up' })
  if (last.current.key !== pageKey) {
    last.current = { key: pageKey, depth, move: depth > last.current.depth ? 'in' : depth < last.current.depth ? 'out' : 'up' }
  }
  // Usage stays mounted from its first visit until Settings closes: coming back to it
  // shows the same page at once instead of loading it again. Meanwhile it keeps its
  // rendered state off screen (content-visibility).
  const [usageOpened, setUsageOpened] = useState(shown === 'usage')
  if (shown === 'usage' && !usageOpened) setUsageOpened(true)
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  return h('div', { className: 'bt-settings-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-settings', role: 'dialog', 'aria-modal': true, 'aria-label': t('DS Bot settings'), 'data-wide': shown === 'usage' ? '' : undefined },
      h('nav', { ref: nav.box, className: 'bt-settings-nav', 'aria-label': t('Settings pages') },
        h('span', { ref: nav.thumb, className: 'bt-thumb', 'aria-hidden': true }),
        SETTINGS_PAGES.map(([key, text]) => h('button', {
          key, type: 'button', className: 'bt-settings-item', 'aria-current': shown === key ? 'page' : undefined, onClick: () => actions.openSettings(key),
        }, h(PAGE_ICONS[key]), t(text))),
        h('button', {
          type: 'button', className: 'bt-settings-item bt-settings-shell', title: t('Models, providers, and the rest of DeepSeek Harness'),
          onClick: () => { close(); openHarnessSettings() },
        }, h(SlidersIcon), t('Harness settings'))),
      h('div', { className: 'bt-settings-main' },
        h('div', { className: 'bt-settings-head' },
          back ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': back, title: back, onClick: () => actions.openSettings(shown) }, h(ChevronLeftIcon)) : null,
          h('h2', { key: bot?.id ?? room?.id ?? shown }, bot?.name ?? room?.name ?? label)),
        shown === 'usage' ? null : h('div', { key: pageKey, className: 'bt-settings-scroll bt-settings-page', 'data-move': last.current.move },
          errorLine,
          shown === 'general' ? h(GeneralPage, { roster, actions, run }) : null,
          bot ? h('div', { className: 'bt-settings-form' }, h(BotSettingsForm, { key: bot.id, bot, roster, actions, run })) : null,
          shown === 'bots' && !bot ? h(BotsPage, { roster, actions, run }) : null,
          room ? h('div', { className: 'bt-settings-form' }, h(GroupSettingsForm, { key: room.id, room, roster, actions, run })) : null,
          shown === 'groups' && !room ? h(GroupsPage, { roster, actions, run }) : null,
          shown === 'connectors' ? h(ConnectorsPage, { roster, actions }) : null,
          shown === 'schedules' ? h(SchedulesPage, { roster, actions, start: id ?? undefined }) : null,
          shown === 'secrets' ? h(SecretsPage, { roster, actions, run, Section: SetSection }) : null,
          shown === 'feedback' ? h(FeedbackPage, { actions, run, Section: SetSection, Row: SetRow }) : null),
        usageOpened ? h('div', { key: 'usage', className: 'bt-settings-scroll bt-settings-usage', 'data-off': shown === 'usage' ? undefined : '', 'aria-hidden': shown === 'usage' ? undefined : true },
          shown === 'usage' ? errorLine : null,
          h(UsagePage, { roster, actions, focusId: usageFocus })) : null),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: close }, h(CloseIcon))))
}
