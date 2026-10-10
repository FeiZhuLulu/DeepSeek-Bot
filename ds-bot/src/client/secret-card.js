// Secret cards: a Bot's request_secret shows a card where the user types a key the
// Bot never sees, or lets the Bot use a key that is already saved. The settings page
// lists the saved keys and who may use them. Values only ever travel from these
// inputs to the host; nothing here reads one back.
import { createElement as h, useEffect, useId, useState } from 'react'
import { CheckIcon, CloseIcon, TrashIcon } from './icons.js'
import { BotAvatar, BotMark } from './mark.js'
import { contentText, currentPart } from './text.js'
import { dateLocale, t } from './i18n.js'
import { SPRING_POP, SPRING_SHAPE, spring } from './motion.js'

const MIN_VALUE = 4

export const KeyIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M7 9.5a3.5 3.5 0 1 1 0 .01z' }), h('path', { d: 'M10.4 10.6L17 10.6M14.5 10.6v2.4M16.6 10.6v1.8' }))
const LockIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M6.5 9V7a3.5 3.5 0 0 1 7 0v2' }), h('rect', { x: 4.5, y: 9, width: 11, height: 8, rx: 2 }))
const WarnIcon = () => h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M10 3.5l7 12.5H3z' }), h('path', { d: 'M10 8.5v3.5M10 14.2h.01' }))

// Password managers ignore a text field masked by CSS, so it never offers to save the
// key; browsers without that CSS fall back to a new-password field.
const MASK_BY_CSS = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')

const insecure = () => typeof location !== 'undefined' && location.protocol === 'http:'
  && !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(location.hostname)

const scopeLabel = (scope, roster) => {
  if (scope === 'all') return t('All Bots')
  const names = (scope ?? []).map(id => roster.byId[id]?.name).filter(Boolean)
  return names.length === 0 ? t('No Bot') : names.join(t(' and '))
}
const when = time => (Number.isFinite(time) ? new Date(time).toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

export function MaskedInput({ value, onChange, onEnter, label, autoFocus = false }) {
  return h('input', {
    className: 'bt-secret-input',
    type: MASK_BY_CSS ? 'text' : 'password',
    'data-masked': MASK_BY_CSS ? '' : undefined,
    value,
    autoFocus,
    autoComplete: MASK_BY_CSS ? 'off' : 'new-password',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    spellCheck: false,
    'data-1p-ignore': '',
    'data-lpignore': 'true',
    'data-bwignore': '',
    'data-form-type': 'other',
    'aria-label': label,
    placeholder: t('Paste or type the key'),
    onChange: event => onChange(event.target.value),
    onKeyDown: (event) => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
      event.preventDefault()
      onEnter?.()
    },
  })
}

function ScopeSwitch({ value, onChange, bot }) {
  const options = [['all', t('All Bots')], ['bot', t('Only {name}', { name: bot.name })]]
  return h('div', { className: 'bt-secret-scope', role: 'radiogroup', 'aria-label': t('Who may use it') },
    h('span', { className: 'bt-secret-glide', 'data-at': value === 'all' ? 0 : 1, 'aria-hidden': true }),
    options.map(([id, text]) => h('button', {
      key: id, type: 'button', role: 'radio', 'aria-checked': value === id, className: 'bt-secret-seg', onClick: () => onChange(id),
    }, text)))
}

function SecretHead({ bot, title, detail, name, onClose }) {
  return h('div', { className: 'bt-q-head bt-secret-head' },
    h('span', { className: 'bt-secret-who' }, h(BotMark, { bot, size: 28 }), h('span', { className: 'bt-secret-lock' }, h(LockIcon))),
    h('div', { className: 'bt-q-text' },
      h('p', { className: 'bt-q-title' }, title),
      h('div', { className: 'bt-q-detail' }, h('code', { className: 'bt-secret-name' }, name), detail ? ` · ${detail}` : '')),
    onClose ? h('button', { type: 'button', className: 'bt-q-x', 'aria-label': t('Cancel the request'), title: t('Cancel'), onClick: onClose }, h(CloseIcon)) : null)
}

export function SecretCard({ bot, request, roster, actions }) {
  const [value, setValue] = useState('')
  const [scope, setScope] = useState('all')
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const noteId = useId()
  const secret = (roster.secrets ?? []).find(entry => entry.name === request.name)
  const run = (promise) => {
    setBusy(true)
    setError('')
    return Promise.resolve(promise).then(() => setValue(''), failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const cancel = () => run(actions.secretCancel(request.id))
  const long = value.trim().length >= MIN_VALUE
  const save = () => { if (long && !busy) void run(actions.secretSet({ requestId: request.id, value, scope })) }
  const allow = () => { if (!busy) void run(actions.secretAllow(request.id)) }
  const filling = request.kind === 'fill' || replacing
  const warn = insecure() ? h('div', { className: 'bt-secret-warn', role: 'note' }, h(WarnIcon), t('This page is not on HTTPS: the key crosses the network unencrypted.')) : null
  return h('div', { className: 'bt-q bt-secret', role: 'group', 'aria-describedby': noteId, 'data-kind': request.kind },
    h(SecretHead, {
      bot,
      title: request.kind === 'allow' ? t('Let {bot} use {name}?', { bot: bot.name, name: request.name }) : t('{name} needs a key', { name: bot.name }),
      detail: request.purpose,
      name: request.name,
      onClose: busy ? undefined : cancel,
    }),
    request.kind === 'allow' ? h('div', { className: 'bt-secret-saved' }, h(KeyIcon), t('Saved for {scope}', { scope: scopeLabel(secret?.scope, roster) })) : null,
    filling ? h('div', { className: 'bt-secret-body' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: setValue, onEnter: save, label: t('Value of {name}', { name: request.name }), autoFocus: replacing })),
      request.kind === 'fill' ? h(ScopeSwitch, { value: scope, onChange: setScope, bot }) : null) : null,
    h('div', { className: 'bt-secret-note', id: noteId },
      t("{bot} never sees the value. It reaches {bot}'s shell as ", { bot: bot.name }), h('code', null, `$DSH_SECRET_${request.name}`), '.',
      filling && value !== '' && !long ? t(' At least {count} characters.', { count: MIN_VALUE }) : ''),
    warn,
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      request.kind === 'allow' && !replacing ? h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => setReplacing(true) }, t('Replace value')) : null,
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: cancel }, t('Cancel')),
      filling
        ? h('button', { type: 'button', className: 'bt-q-submit', disabled: !long || busy, onClick: save }, busy ? t('Saving…') : t('Save'))
        : h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: allow }, busy ? t('Allowing…') : t('Allow'))))
}

function SettledSecret({ bot, request, roster }) {
  const canceled = request.status === 'canceled'
  const text = canceled ? t('{bot} asked for {name}', { bot: bot.name, name: request.name })
    : request.status === 'allowed' ? t('Allowed {bot} to use {name}', { bot: bot.name, name: request.name })
      : t('Saved {name}', { name: request.name })
  return h('div', { className: 'bt-q bt-q-settled bt-secret bt-secret-done', role: 'group', 'aria-label': text, 'data-status': request.status },
    h('div', { className: 'bt-q-head' },
      h('span', { className: 'bt-secret-who' }, h(BotMark, { bot, size: 22 })),
      h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, text,
        canceled ? null : h('span', { className: 'bt-secret-scope-tag' }, ` · ${scopeLabel(request.scope, roster)}`))),
      canceled ? h('span', { className: 'bt-q-badge' }, t('Canceled')) : h('span', { className: 'bt-q-check bt-secret-check', title: t('Done') }, h(CheckIcon))))
}

function RequestView({ bot, request, roster, actions }) {
  return request.status === 'pending'
    ? h(SecretCard, { key: `${request.id}:${request.kind}`, bot, request, roster, actions })
    : h(SettledSecret, { bot, request, roster })
}

// The card at its request_secret call; a key that was already there gets one line.
export function SecretToolCell({ sessionId, callId, name, done, content, roster, actions }) {
  const bot = roster.byId[sessionId]
  if (!bot) return null
  const request = (roster.secretRequests?.[bot.id] ?? []).find(entry => entry.callId === callId)
  if (request) return h('div', { className: 'bt-q-inline' }, h(RequestView, { bot, request, roster, actions }))
  if (done && /already saved/.test(contentText(content))) {
    return h('div', { className: 'bt-event' }, h('span', { className: 'bt-secret-event' }, h(KeyIcon), t('{bot} is using {name}', { bot: bot.name, name: name ?? t('a saved key') })))
  }
  return null
}

// A card asked in an earlier part of the chat has no call in the part shown now, so
// it waits above the composer instead.
export function SecretDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = roster.byId[sessionId]
  if (!bot || currentPart(bot) !== sessionId) return null
  const waiting = (roster.secretRequests?.[bot.id] ?? []).filter(entry => entry.status === 'pending' && (!entry.callId || entry.sessionId !== sessionId))
  if (waiting.length === 0) return null
  return h('div', { className: 'bt-q-dock bt-secret-dock' }, waiting.map(request => h(SecretCard, { key: `${request.id}:${request.kind}`, bot, request, roster, actions })))
}

// -------------------------------------------------------------------------
// Settings page

function ScopeEditor({ secret, roster, onSave }) {
  const [mode, setMode] = useState(secret.scope === 'all' ? 'all' : 'some')
  const [picked, setPicked] = useState(secret.scope === 'all' ? [] : secret.scope)
  const toggle = id => setPicked(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  const same = mode === 'all' ? secret.scope === 'all' : secret.scope !== 'all' && [...picked].sort().join() === [...secret.scope].sort().join()
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, t('Who may use it')),
    h('div', { className: 'bt-secret-radios', role: 'radiogroup', 'aria-label': t('Who may use {name}', { name: secret.name }) },
      [['all', t('All Bots')], ['some', t('Chosen Bots')]].map(([id, text]) => h('label', { key: id, className: 'bt-secret-radio' },
        h('input', { type: 'radio', name: `scope-${secret.name}`, checked: mode === id, onChange: () => setMode(id) }), text))),
    mode === 'some' ? h('div', { className: 'bt-secret-bots' }, roster.bots.map(bot => h('button', {
      key: bot.id, type: 'button', className: 'bt-secret-bot', 'aria-pressed': picked.includes(bot.id), onClick: () => toggle(bot.id),
    }, h(BotAvatar, { bot, size: 20, badge: false, live: false }), bot.name, picked.includes(bot.id) ? h(CheckIcon) : null))) : null,
    h('div', { className: 'bt-secret-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: same, onClick: () => onSave(mode === 'all' ? 'all' : picked) }, t('Save access'))))
}

function ValueEditor({ secret, onSave }) {
  const [value, setValue] = useState('')
  const [replaced, setReplaced] = useState(false)
  const long = value.trim().length >= MIN_VALUE
  const save = () => {
    if (!long) return
    void Promise.resolve(onSave(value)).then(ok => { if (ok) { setValue(''); setReplaced(true) } })
  }
  const edit = next => { setValue(next); setReplaced(false) }
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, t('Replace the value')),
    h('div', { className: 'bt-secret-inline' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: edit, onEnter: save, label: t('New value of {name}', { name: secret.name }) })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !long, onClick: save }, t('Replace'))),
    value !== '' && !long ? h('div', { className: 'bt-set-hint' }, t('At least {count} characters.', { count: MIN_VALUE }))
      : replaced ? h('div', { className: 'bt-set-hint bt-secret-ok', role: 'status' }, h(CheckIcon), t('Replaced. Bots get the new value from their next command.')) : null)
}

function SecretRow({ secret, roster, actions, run, open, onToggle }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { if (!open) setConfirm(false) }, [open])
  const asker = secret.requestedBy ? roster.byId[secret.requestedBy]?.name ?? t('a deleted Bot') : t('you')
  const allowed = secret.scope === 'all' ? [] : secret.scope.map(id => roster.byId[id]).filter(Boolean)
  const meta = [t('Asked by {name}', { name: asker }), t('added {time}', { time: when(secret.createdAt) }), secret.lastUsedAt ? t('last used {time}', { time: when(secret.lastUsedAt) }) : t('not used yet')].join(' · ')
  return h('div', { className: 'bt-secret-item', 'data-open': open ? '' : undefined },
    h('button', { type: 'button', className: 'bt-set-row bt-secret-summary', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-secret-title' }, h(KeyIcon), h('code', { className: 'bt-secret-name' }, secret.name), secret.purpose ? h('span', { className: 'bt-secret-purpose' }, secret.purpose) : null),
        h('span', { className: 'bt-set-hint' }, meta)),
      h('span', { className: 'bt-set-control' },
        secret.scope === 'all' ? h('span', { className: 'bt-tag' }, t('All Bots'))
          : allowed.length === 0 ? h('span', { className: 'bt-tag' }, t('No Bot'))
            : h('span', { className: 'bt-secret-faces', title: allowed.map(bot => bot.name).join(', ') }, allowed.slice(0, 5).map(bot => h(BotAvatar, { key: bot.id, bot, size: 20, badge: false, live: false }))))),
    open ? h('div', { className: 'bt-secret-edit' },
      h(ScopeEditor, { key: JSON.stringify(secret.scope), secret, roster, onSave: scope => run(actions.secretUpdate(secret.name, scope)) }),
      h(ValueEditor, { secret, onSave: value => run(actions.secretSet({ name: secret.name, value })) }),
      h('div', { className: 'bt-secret-row-actions' },
        confirm
          ? [
              h('span', { key: 'q', className: 'bt-set-hint' }, t('Delete {name}? Bots lose it at once.', { name: secret.name })),
              h('button', { key: 'no', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(false) }, t('Keep')),
              h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => run(actions.secretDelete(secret.name)) }, t('Delete')),
            ]
          : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => setConfirm(true) }, h(TrashIcon), t('Delete')))) : null)
}

function AddSecret({ actions, run, onDone }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [value, setValue] = useState('')
  const ready = /^[A-Za-z][\w-]{0,63}$/.test(name.trim()) && value.trim().length >= MIN_VALUE
  const save = () => {
    if (!ready) return
    void run(actions.secretSet({ name, purpose, value, scope: 'all' })).then(ok => { if (ok) { setValue(''); onDone() } })
  }
  return h('div', { className: 'bt-set-row bt-set-paste bt-secret-add' },
    h('input', { className: 'bt-input', 'aria-label': t('Key name'), placeholder: t('NAME, e.g. GITHUB_TOKEN'), value: name, spellCheck: false, autoComplete: 'off', autoFocus: true, onChange: event => setName(event.target.value.toUpperCase()) }),
    h('input', { className: 'bt-input', 'aria-label': t('What it is for'), placeholder: t('What it is for'), value: purpose, autoComplete: 'off', onChange: event => setPurpose(event.target.value) }),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: setValue, onEnter: save, label: t('Value') })),
    h('div', { className: 'bt-secret-row-actions' },
      h('span', { className: 'bt-set-hint' }, t('New keys are for all Bots; narrow it down afterwards.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !ready, onClick: save }, t('Save key'))))
}

export function SecretsPage({ roster, actions, run, Section }) {
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  const secrets = roster.secrets ?? []
  return [
    h('p', { key: 'about', className: 'bt-secret-about' },
      t('Keys your Bots asked for. Bots never see the values: they use them as '), h('code', null, '$DSH_SECRET_NAME'),
      t(' in their shell, and every value is replaced by '), h('code', null, '[secret:NAME]'), t(' before anything goes to a model.')),
    h(Section, { key: 'list', title: t('Secrets · {count}', { count: secrets.length }) },
      secrets.length === 0 && !adding ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No keys yet. When a Bot needs one, it shows a card in its chat.'))) : null,
      secrets.map(secret => h(SecretRow, { key: secret.name, secret, roster, actions, run, open: open === secret.name, onToggle: () => setOpen(open === secret.name ? null : secret.name) })),
      adding ? h(AddSecret, { actions, run, onDone: () => setAdding(false) }) : null),
    adding ? null : h('div', { key: 'add', className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setAdding(true) }, t('Add a key'))),
  ]
}

export const SECRET_CSS = `
.bt-secret-head{align-items:center;gap:10px}
.bt-secret-who{position:relative;flex:none;display:inline-flex}
.bt-secret-lock{position:absolute;right:-5px;bottom:-4px;width:16px;height:16px;border-radius:50%;background:var(--bt-main);color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px var(--bt-bubble)}
.bt-secret-lock svg{width:11px;height:11px}
.bt-secret-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:16px;padding:1px 6px;border-radius:5px;background:var(--bt-hover);color:var(--bt-ink)}
.bt-secret-body{display:flex;flex-direction:column;gap:8px}
.bt-secret-field{align-items:center;min-height:36px}
.bt-secret-input{flex:1;width:100%;min-width:0;margin:0;padding:0;border:0;outline:none;background:transparent;color:var(--bt-ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;line-height:20px;letter-spacing:.04em}
.bt-secret-input[data-masked]{-webkit-text-security:disc}
.bt-secret-input::placeholder{color:var(--bt-ink-3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;letter-spacing:0}
.bt-secret-scope{position:relative;display:inline-grid;grid-template-columns:1fr 1fr;align-self:flex-start;padding:2px;border-radius:999px;background:var(--bt-hover)}
.bt-secret-glide{position:absolute;top:2px;bottom:2px;left:2px;width:calc(50% - 2px);border-radius:999px;background:var(--bt-main);box-shadow:0 1px 3px rgba(20,20,20,.08),inset 0 0 0 .5px color-mix(in srgb,var(--bt-ink) 6%,transparent);transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-secret-glide[data-at="1"]{transform:translateX(100%)}
.bt-secret-seg{position:relative;z-index:1;height:28px;padding:0 14px;border:0;border-radius:999px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer;transition:color .16s ease}
.bt-secret-seg[aria-checked=true]{color:var(--bt-ink);font-weight:500}
.bt-secret-seg:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
/* A key card asks the user to act, so the process group carrying it stays open in every
   work-details mode (same override as .bt-group-replies in styles.js). */
[data-step-process]:has(.bt-secret)>div:first-child{display:none!important}
[data-step-process]:has(.bt-secret)>[data-step-process-body]{display:block!important;content-visibility:visible!important;max-height:none!important;overflow:visible!important;mask-image:none!important;scrollbar-gutter:auto!important}
.bt-secret-ok{display:flex;align-items:center;gap:4px;margin-top:6px;animation:bt-secret-in .22s cubic-bezier(.22,1,.36,1)}
.bt-secret-ok svg{width:13px;height:13px;color:#16a34a}
@keyframes bt-secret-in{from{opacity:0;transform:translateY(-2px)}}
.bt-secret-saved{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-secret-note{font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-secret-note code,.bt-secret-about code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.bt-secret-warn{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;font-size:12px;line-height:16px;color:#b25e09;background:color-mix(in srgb,#f59e0b 12%,transparent)}
.bt-secret-error{font-size:12px;line-height:16px;color:#e02135}
.bt-secret .bt-q-btn:disabled{opacity:.5;cursor:default}
.bt-secret-done .bt-q-head{align-items:center}
.bt-secret-done .bt-q-title{font-size:13px;line-height:18px;color:var(--bt-ink-2);font-weight:500}
.bt-secret-scope-tag{font-weight:400;color:var(--bt-ink-3)}
.bt-secret-check{color:var(--bt-green,#22a06b);animation:bt-secret-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
.bt-secret-done{animation:bt-secret-settle .32s cubic-bezier(.22,1,.36,1) backwards}
@keyframes bt-secret-pop{from{opacity:0;transform:scale(.4)}}
@keyframes bt-secret-settle{from{opacity:.4;transform:scale(.985)}}
.bt-secret-event{display:inline-flex;align-items:center;gap:5px}
.bt-secret-dock{flex-direction:column;align-items:center}
.bt-secret-dock .bt-q{max-width:min(550px,calc(100% - 32px))}
.bt-secret-about{margin:0 0 12px;padding:0 4px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-secret-title{display:flex;align-items:center;gap:6px;min-width:0;color:var(--bt-ink)}
.bt-secret-title svg{flex:none;color:var(--bt-ink-2)}
.bt-secret-purpose{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2)}
.bt-secret-faces{display:inline-flex}
.bt-secret-faces>*+*{margin-left:-6px}
.bt-secret-edit{display:flex;flex-direction:column;gap:14px;padding:4px 12px 14px;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
.bt-secret-edit-block{display:flex;flex-direction:column;gap:8px}
.bt-secret-edit-label{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-secret-radios{display:flex;gap:16px;font-size:13px}
.bt-secret-radio{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.bt-secret-bots{display:flex;flex-wrap:wrap;gap:6px}
.bt-secret-bot{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px 0 5px;border-radius:999px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.bt-secret-bot[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink);border-color:var(--bt-line-2)}
.bt-secret-bot svg{width:13px;height:13px}
.bt-secret-inline{display:flex;gap:8px;align-items:center}
.bt-secret-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.bt-secret-row-actions .bt-set-hint{flex:1}
.bt-secret-danger{color:#e02135;display:inline-flex;align-items:center;gap:4px}
.bt-secret-danger svg{width:13px;height:13px}
.bt-secret-add .bt-input{height:34px}
@media (prefers-reduced-motion:reduce){.bt-secret-glide{transition:none}.bt-secret-check,.bt-secret-done,.bt-secret-ok,.bt-secret-edit{animation:none}}
`
