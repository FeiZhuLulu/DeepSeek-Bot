// Settings → Feedback: report a problem as a GitHub issue with the diagnostics filled
// in, see the latest errors, and download the log. Also the toast for actions that
// fail away from any form (menus, the palette).
import { createElement as h, useEffect, useState } from 'react'
import { clearClientErrors, clientErrors, clientFacts, failureLabel, issueUrl, WHAT_MAX } from './diagnostics.js'
import { dateLocale, t } from './i18n.js'
import { CloseIcon } from './icons.js'
import { SPRING_SHAPE } from './motion.js'

export const FeedbackIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z' }), h('path', { d: 'M10 7v2.6M10 11.4h.01' }))

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// No clipboard API (an insecure context, a locked-down WebView) is a failure,
// not a success: the caller then opens the preview to copy by hand.
const copy = text => (navigator.clipboard === undefined
  ? Promise.resolve(false)
  : navigator.clipboard.writeText(text).then(() => true, () => false))

function whenText(time) {
  const date = new Date(time)
  const today = new Date().toDateString() === date.toDateString()
  const clock = date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  return today ? clock : `${date.toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' })} ${clock}`
}

function entrySummary(entry) {
  if (entry.source === 'turn') return failureLabel(entry.code, entry.text)
  return entry.text
}

const SOURCES = { turn: 'Model call', host: 'DS Bot', api: 'DS Bot', browser: 'This window' }

export function FeedbackPage({ actions, run, Section, Row }) {
  const [what, setWhat] = useState('')
  const [report, setReport] = useState(null)
  const [preview, setPreview] = useState(false)
  const [note, setNote] = useState('')
  // Each action reads the report again, so it holds errors from the last few seconds.
  const fetchReport = () => actions.diagnostics({ client: clientFacts(), clientErrors: clientErrors() }).then((next) => { setReport(next); return next })
  const load = () => fetchReport().then(() => undefined)
  useEffect(() => { void run(load()) }, [])

  const copyReport = () => run(fetchReport().then(async (next) => {
    const copied = await copy(next.markdown)
    setNote(copied ? t('Copied the diagnostics.') : t('Could not copy. Select the text below and copy it.'))
    if (!copied) setPreview(true)
  }))
  const [issueLink, setIssueLink] = useState(null)
  const openIssue = () => {
    // The window is reserved inside the click gesture and addressed once the
    // diagnostics are gathered; opening after the awaits would hit the blocker.
    const win = window.open('', '_blank')
    if (win !== null) win.opener = null
    run(fetchReport().then(async (next) => {
      const copied = await copy(next.markdown)
      const { url, inline } = issueUrl(next.issuesUrl, { what, diagnostics: next.markdown })
      if (win !== null) {
        win.location.href = url
        setIssueLink(null)
        setNote(inline
          ? t('Opened a new GitHub issue with the diagnostics filled in. Check it before you submit.')
          : copied
            ? t('Opened a new GitHub issue. The diagnostics are long, so they are on the clipboard: paste them into the issue.')
            : t('Opened a new GitHub issue. Copy the diagnostics below into it.'))
      } else {
        setIssueLink(url)
        setNote(t('The browser blocked the new window.'))
      }
      if (!inline && !copied) setPreview(true)
    }))
  }
  const downloadLog = () => run(actions.diagnosticsLog().then((text) => {
    download('ds-bot-diagnostics.log', text || 'No entries.\n')
    setNote(t('Downloaded the log. Keys, tokens, and your home folder are hidden in it.'))
  }))
  const clearLog = () => run(actions.diagnosticsClear().then(clearClientErrors).then(load).then(() => setNote(t('Cleared the error log.'))))

  const browserErrors = report ? clientErrors().map(entry => ({ ...entry, source: 'browser' })) : []
  const entries = [...(report?.entries ?? []), ...browserErrors].sort((a, b) => new Date(b.time) - new Date(a.time))
  const total = (report?.total ?? 0) + browserErrors.length
  const shown = entries.slice(0, 8)
  return [
    h(Section, { key: 'report', title: t('Report a problem') },
      h('div', { className: 'bt-set-row bt-set-paste bt-fb-what' },
        h('label', { className: 'bt-set-copy', htmlFor: 'bt-fb-what' },
          h('span', null, t('What happened?')),
          h('span', { className: 'bt-set-hint' }, t('What you did, what you expected, and what happened instead. It goes into the issue.'))),
        h('textarea', { id: 'bt-fb-what', className: 'bt-input bt-input-area', value: what, maxLength: WHAT_MAX, placeholder: t('For example: I asked Writer in the group chat and it showed an error.'), onChange: event => setWhat(event.target.value) })),
      h(Row, { label: t('Diagnostics'), hint: t('Versions, system, models, and the latest errors. Saved keys, tokens, and your home folder are hidden.') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setPreview(!preview), 'aria-expanded': preview }, preview ? t('Hide') : t('Show')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copyReport }, t('Copy'))),
      preview ? h('div', { className: 'bt-set-row bt-fb-preview' }, h('pre', { tabIndex: 0, 'aria-label': t('Diagnostics') }, report?.markdown || t('Loading…'))) : null,
      h(Row, { label: t('GitHub issue'), hint: t('Opens a new issue in the DS Bot repository with all of this filled in. Nothing is sent until you submit it there.') },
        h('button', { type: 'button', className: 'bt-fb-primary', onClick: openIssue }, t('Report on GitHub')))),
    note ? h('div', { key: 'note', className: 'bt-note bt-fb-note', role: 'status' },
      note,
      issueLink ? [' ', h('a', { key: 'link', href: issueLink, target: '_blank', rel: 'noopener noreferrer' }, t('Open the issue'))] : null) : null,
    h(Section, { key: 'errors', title: report ? t('Recent errors · {count}', { count: total }) : t('Recent errors') },
      shown.length === 0
        ? h(Row, { label: t('No errors recorded.'), hint: t('Failed model calls and DS Bot problems show here, newest first.') })
        : shown.map((entry, index) => h('div', { key: `${entry.time}-${index}`, className: 'bt-set-row bt-fb-entry', title: entry.text },
            h('span', { className: 'bt-fb-dot', 'data-level': entry.level, 'aria-hidden': true }),
            h('div', { className: 'bt-set-copy' },
              h('span', { className: 'bt-fb-text' }, entrySummary(entry)),
              h('span', { className: 'bt-set-hint' }, [whenText(entry.time), entry.bot, entry.where, t(SOURCES[entry.source] ?? 'DS Bot')].filter(Boolean).join(' · '))),
            entry.code ? h('span', { className: 'bt-tag bt-fb-code' }, entry.status ? `${entry.code} ${entry.status}` : entry.code) : null)),
      h(Row, { label: t('Error log'), hint: t('Kept on this computer across restarts, up to about 1 MB.') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: downloadLog }, t('Download')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: clearLog, disabled: !report || total === 0 }, t('Clear')))),
  ]
}

const TOAST_MS = 6000

// One failure at a time, bottom center; a newer one replaces it.
export function ErrorToast({ useUi, actions }) {
  const toast = useUi(state => state.toast)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (!toast) return undefined
    setLeaving(false)
    const fade = setTimeout(() => setLeaving(true), TOAST_MS)
    const gone = setTimeout(() => actions.dismissToast(toast.token), TOAST_MS + 200)
    return () => { clearTimeout(fade); clearTimeout(gone) }
  }, [toast?.token])
  if (!toast) return null
  return h('div', { className: 'bt-toast', role: 'alert', 'data-leaving': leaving || undefined },
    h('span', { className: 'bt-toast-text' }, toast.text),
    h('button', { type: 'button', className: 'bt-toast-link', onClick: () => { actions.dismissToast(toast.token); actions.openSettings('feedback') } }, t('Details')),
    h('button', { type: 'button', className: 'bt-icon-btn bt-toast-close', 'aria-label': t('Dismiss'), onClick: () => actions.dismissToast(toast.token) }, h(CloseIcon)))
}

export const FEEDBACK_CSS = `
.bt-fb-what{cursor:default}
.bt-fb-what:hover,.bt-fb-entry:hover,.bt-fb-preview:hover{background:none}
.bt-fb-what .bt-input-area{min-height:80px}
.bt-fb-preview{cursor:default;padding:0}
.bt-fb-preview pre{margin:0;width:100%;max-height:240px;overflow:auto;padding:10px 12px;box-sizing:border-box;font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--bt-ink-2);white-space:pre-wrap;word-break:break-word;outline:none}
.bt-fb-primary{height:28px;border-radius:999px;border:0;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);padding:0 14px;font-size:12px;cursor:pointer;transition:filter .12s ease}
.bt-fb-primary:hover{filter:brightness(1.08)}
.bt-fb-primary:active{filter:brightness(.94)}
.bt-fb-note{margin:-8px 4px 0}
.bt-fb-entry{cursor:default;align-items:flex-start}
.bt-fb-dot{flex:none;width:6px;height:6px;border-radius:50%;margin-top:6px;background:#e02135}
.bt-fb-dot[data-level=warn]{background:#e3a008}
.bt-fb-text{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.bt-fb-code{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.bt-event-error{color:#e02135}
.bt-toast{position:fixed;left:50%;bottom:28px;z-index:1000;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));padding:8px 8px 8px 14px;border-radius:12px;background:var(--bt-card,#fff);color:var(--bt-ink,#141414);border:1px solid var(--bt-line-2,rgba(0,0,0,.15));box-shadow:0 8px 28px rgba(0,0,0,.14);font-size:13px;line-height:18px;transform:translateX(-50%);animation:bt-toast-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .2s ease-out}
.bt-toast[data-leaving]{opacity:0;transform:translate(-50%,6px) scale(.98);filter:blur(3px);transition:opacity .18s ease-in,transform .18s ease-in,filter .18s ease-in}
.bt-toast-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.bt-toast-text::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:#e02135;margin:0 8px 1px 0}
.bt-toast-link{flex:none;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;padding:4px 6px;border-radius:6px}
.bt-toast-link:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-toast-close{flex:none}
@keyframes bt-toast-in{from{transform:translate(-50%,16px) scale(.94)}}
@media (prefers-reduced-motion:reduce){.bt-toast{animation:none}.bt-toast[data-leaving]{transition:none}}
`
