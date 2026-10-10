import { createElement as h, Fragment, useEffect, useState } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { isMainOf } from './sources.js'
import { currentPart, stripHeader } from './text.js'
import { PlusIcon, SearchIcon, PeopleIcon, CloseIcon, GearIcon } from './icons.js'
import { BotAvatar, RoomAvatar } from './mark.js'
import { useEscape } from './overlay-hooks.js'
import { QUICK_EDGES, useFlip, useGlide } from './motion.js'
import { t } from './i18n.js'

// Search is a command palette: a 560px dialog, a search header, and 49px
// rows (24px avatar, title, subtitle). Bots and groups match on name and role; past
// messages match on their text.
const PALETTE_EXIT_MS = 160
export function CommandPalette({ start, token, roster, actions, useSessions }) {
  const [query, setQuery] = useState(start ?? '')
  const [cursor, setCursor] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const wanted = query.trim().toLowerCase()
  const close = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => actions.closePalette(token), PALETTE_EXIT_MS)
  }
  useEscape(close)
  const ids = [...roster.bots.map(currentPart), ...roster.rooms.map(item => item.id)]
  const found = useSessions((list) => {
    if (wanted.length < 2) return '[]'
    const hits = []
    for (const id of ids) {
      const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
      if (!Array.isArray(outline)) continue
      const hidden = roster.exchangeTurns[id] ?? []
      for (let index = outline.length - 1; index >= 0 && hits.length < 30; index -= 1) {
        const entry = outline[index]
        if (hidden.includes(entry.turn)) continue
        for (const raw of [entry.response, entry.prompt]) {
          const text = stripHeader(raw ?? '').replace(/\s+/g, ' ').trim()
          const at = text.toLowerCase().indexOf(wanted)
          if (at < 0) continue
          const from = Math.max(0, at - 24)
          hits.push([id, entry.turn, (from > 0 ? '…' : '') + text.slice(from, at + wanted.length + 60)])
          break
        }
      }
    }
    return JSON.stringify(hits)
  })
  const matchesName = (...fields) => wanted === '' || fields.some(field => (field ?? '').toLowerCase().includes(wanted))
  const sections = []
  const people = [
    ...roster.bots.filter(bot => matchesName(bot.name, bot.role)).map(bot => ({
      key: bot.id, avatar: h(BotAvatar, { bot, size: 24, badge: false, live: false }), title: bot.name,
      subtitle: [bot.role, isMainOf(roster, bot.id) ? t('Main Bot') : ''].filter(Boolean).join(' · '), badge: bot.hidden ? t('Hidden') : undefined,
      run: async () => { if (bot.hidden) await actions.setFlags(bot.id, { hidden: false }); actions.openSession(bot.id) },
    })),
    ...roster.rooms.filter(room => matchesName(room.name)).map(room => ({
      key: room.id, avatar: h(RoomAvatar, { room, roster, size: 24 }), title: room.name, subtitle: t('{count} members', { count: room.members.length }),
      badge: room.hidden ? t('Hidden') : undefined,
      run: async () => { if (room.hidden) await actions.setFlags(room.id, { hidden: false }); actions.openSession(room.id) },
    })),
  ]
  if (people.length) sections.push([t('Bots'), people])
  const agents = (roster.agents ?? []).filter(() => matchesName('DSH Agent')).map(agent => ({
    key: agent.id, avatar: h('span', { className: 'bt-palette-agent' }, h(FishLogo, { size: 18 })), title: 'DSH Agent',
    subtitle: t('Plain dsh session'),
    run: () => actions.openAgent(agent.id),
  }))
  if (agents.length) sections.push(['DSH Agent', agents])
  const messages = JSON.parse(found).map(([id, turn, snippet]) => {
    const bot = roster.byId[id]
    const room = roster.roomsById[id]
    return {
      key: `${id}:${turn}`, title: bot?.name ?? room?.name ?? t('Bot'), subtitle: snippet,
      avatar: bot ? h(BotAvatar, { bot, size: 24, badge: false, live: false }) : h(RoomAvatar, { room, roster, size: 24 }),
      run: () => actions.openSession(id),
    }
  })
  if (messages.length) sections.push([t('Messages'), messages])
  const commands = [
    { key: 'cmd:new', icon: h(PlusIcon), title: t('New chat'), run: () => actions.openNewChat('new') },
    { key: 'cmd:bot', icon: h(PlusIcon), title: t('Create Bot'), run: () => actions.openNewChat('create') },
    { key: 'cmd:group', icon: h(PeopleIcon), title: t('Create group chat'), run: () => actions.openNewChat('group') },
    { key: 'cmd:settings', icon: h(GearIcon), title: t('Bot settings'), run: () => actions.openSettings('general') },
  ].filter(command => matchesName(command.title))
  if (commands.length) sections.push([t('Commands'), commands])
  const rows = sections.flatMap(([, items]) => items)
  const active = Math.min(cursor, Math.max(rows.length - 1, 0))
  const shown = rows.map(row => row.key).join('\n')
  const glide = useGlide(`${active}\n${shown}`, { axis: 'y', ...QUICK_EDGES })
  const listRef = glide.box
  useFlip(listRef, shown, '[data-flip]')
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }, [active, query])
  const choose = (row) => {
    if (!row || leaving) return
    void Promise.resolve(row.run()).catch(error => actions.reportError(error, 'menu'))
    close()
  }
  let index = -1
  return h('div', { className: 'bt-palette-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-backdrop', onMouseDown: close }),
    h('div', { className: 'bt-palette', role: 'dialog', 'aria-label': t('Search'), 'aria-modal': true },
      h('div', { className: 'bt-palette-head' },
        h('span', { className: 'bt-palette-glyph', 'aria-hidden': true }, h(SearchIcon)),
        h('input', {
          autoFocus: true, value: query, placeholder: t('Search Bots, chats and messages'), 'aria-label': t('Search'),
          role: 'combobox', 'aria-expanded': true, 'aria-controls': 'bt-palette-list',
          onChange: (event) => { setQuery(event.target.value); setCursor(0) },
          onKeyDown: (event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(Math.min(active + 1, rows.length - 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(Math.max(active - 1, 0)) }
            else if (event.key === 'Enter') { event.preventDefault(); choose(rows[active]) }
          },
        }),
        query ? h('button', { type: 'button', className: 'bt-palette-clear', 'aria-label': t('Clear search'), onClick: () => { setQuery(''); setCursor(0) } }, h(CloseIcon)) : null),
      h('div', { ref: listRef, id: 'bt-palette-list', className: 'bt-palette-list', role: 'listbox', 'aria-label': t('Results') },
        h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
        rows.length === 0
          ? h('div', { className: 'bt-palette-empty' },
              h('span', { className: 'bt-palette-empty-icon', 'aria-hidden': true }, h(SearchIcon)),
              h('span', { className: 'bt-palette-empty-label' }, t('No results')),
              h('span', { className: 'bt-palette-empty-hint' }, t('Try a Bot name or words from a message')))
          : sections.map(([title, items]) => h(Fragment, { key: title },
              h('div', { className: 'bt-palette-section', role: 'presentation', 'data-flip': `section:${title}` }, title),
              items.map((row) => {
                index += 1
                const at = index
                return h('button', {
                  key: row.key, type: 'button', role: 'option', className: 'bt-palette-row', 'aria-selected': at === active, 'data-flip': row.key,
                  onMouseMove: () => { if (cursor !== at) setCursor(at) }, onClick: () => choose(row),
                },
                h('span', { className: 'bt-palette-lead' }, row.avatar ?? h('span', { className: 'bt-palette-cmd' }, row.icon)),
                h('span', { className: 'bt-palette-text' },
                  h('span', { className: 'bt-palette-title' }, row.title),
                  row.subtitle ? h('span', { className: 'bt-palette-sub' }, row.subtitle) : null),
                row.badge ? h('span', { className: 'bt-palette-badge' }, row.badge) : null)
              }))))))
}
