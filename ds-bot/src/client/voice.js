import { createElement as h, useEffect, useRef, useState } from 'react'
import { stripHeader } from './text.js'
import { MicIcon, CloseIcon } from './icons.js'
import { BotMark, RoomAvatar } from './mark.js'
import { speechApi, useDictation } from './composer.js'
import { Shimmer } from './cells.js'
import { useEscape, usePaneLeft } from './overlay-hooks.js'
import { t } from './i18n.js'

// Voice chat: listen, send what the user said, read the Bot's answer aloud, listen
// again. Browser speech recognition and synthesis only; nothing leaves the browser
// except through the browser's own speech service.
const plainSpeech = text => stripHeader(text).replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|~-]+/g, ' ').replace(/\s+/g, ' ').trim()
const VOICE_LABELS = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', paused: 'Paused', unsupported: 'Voice chat is not available in this browser' }

function useMicLevel(enabled) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.getUserMedia) return undefined
    let stream = null
    let audio = null
    let frame = 0
    let stopped = false
    navigator.mediaDevices.getUserMedia({ audio: true }).then((media) => {
      if (stopped) { media.getTracks().forEach(track => track.stop()); return }
      stream = media
      audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 256
      audio.createMediaStreamSource(media).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      let smooth = 0
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const value of data) sum += ((value - 128) / 128) ** 2
        smooth = smooth * 0.8 + Math.min(1, Math.sqrt(sum / data.length) * 4) * 0.2
        setLevel(Math.round(smooth * 100) / 100)
        frame = requestAnimationFrame(tick)
      }
      tick()
    }).catch(() => {})
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach(track => track.stop())
      void audio?.close().catch(() => {})
      setLevel(0)
    }
  }, [enabled])
  return level
}

export function VoiceMode({ sessionId, roster, actions, useSessions, useSessionStatus }) {
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const name = bot?.name ?? room?.name ?? t('Bot')
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const lastReply = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    const entry = Array.isArray(outline) ? outline[outline.length - 1] : undefined
    return entry ? `${outline.length}|${entry.response ?? ''}` : '0|'
  })
  const [phase, setPhase] = useState(speechApi() ? 'listening' : 'unsupported')
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const waiting = useRef(null)
  const paneLeft = usePaneLeft()
  const close = () => { window.speechSynthesis?.cancel(); actions.closeVoice() }
  useEscape(close)
  const dictation = useDictation((text, final) => {
    setHeard(text)
    if (!final) return
    dictation.stop()
    setPhase('thinking')
    waiting.current = lastReply.split('|')[0]
    void actions.send(sessionId, text.trim()).catch(() => setPhase('listening'))
  })
  const listen = phase === 'listening'
  useEffect(() => {
    if (!listen || dictation.listening) return undefined
    const timer = setTimeout(() => dictation.start({ continuous: false, onEnd: () => {} }), 250)
    return () => clearTimeout(timer)
  }, [listen, dictation.listening])
  // Recognition stops on silence; keep listening until the user pauses or ends.
  useEffect(() => {
    if (phase !== 'listening') dictation.stop()
  }, [phase])
  useEffect(() => {
    if (phase !== 'thinking' || running || waiting.current === null) return
    const [count, text] = [lastReply.slice(0, lastReply.indexOf('|')), lastReply.slice(lastReply.indexOf('|') + 1)]
    if (count === waiting.current || !text.trim()) return
    waiting.current = null
    const speech = plainSpeech(text)
    setSaid(speech)
    setHeard('')
    if (!window.speechSynthesis || !speech) { setPhase('listening'); return }
    const utterance = new SpeechSynthesisUtterance(speech)
    utterance.lang = /[\u3400-\u9fff]/.test(speech) ? 'zh-CN' : 'en-US'
    utterance.onend = () => setPhase(current => (current === 'speaking' ? 'listening' : current))
    utterance.onerror = utterance.onend
    setPhase('speaking')
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }, [phase, running, lastReply])
  useEffect(() => () => window.speechSynthesis?.cancel(), [])
  const level = useMicLevel(phase === 'listening' && dictation.listening)
  const markState = phase === 'thinking' ? 'thinking' : phase === 'speaking' ? 'sending' : 'idle'
  const togglePause = () => {
    if (phase === 'paused') { setPhase('listening'); return }
    window.speechSynthesis?.cancel()
    setPhase('paused')
  }
  const caption = phase === 'speaking' ? said : heard
  return h('div', { className: 'bt-pane bt-voice-pane', style: { left: paneLeft } },
    h('div', { className: 'bt-voice-stage', role: 'dialog', 'aria-label': t('Voice chat with {name}', { name }), 'data-phase': phase },
      h('div', { className: 'bt-voice-orb', style: { '--bt-level': level } },
        h('span', { className: 'bt-voice-ring', 'aria-hidden': true }),
        h('span', { className: 'bt-voice-ring bt-voice-ring-2', 'aria-hidden': true }),
        bot ? h(BotMark, { bot, size: 112, state: markState, live: true, gaze: phase === 'listening' }) : room ? h(RoomAvatar, { room, roster, size: 112 }) : null),
      h('div', { className: 'bt-voice-name' }, name),
      h('div', { className: 'bt-voice-status', role: 'status' },
        phase === 'thinking' ? h(Shimmer, null, t('Thinking…')) : VOICE_LABELS[phase] ? t(VOICE_LABELS[phase]) : ''),
      h('div', { className: 'bt-voice-caption', key: `${phase}:${caption.slice(0, 12)}` }, caption),
      dictation.note ? h('div', { className: 'bt-voice-note' }, dictation.note) : null),
    h('div', { className: 'bt-voice-bar' },
      h('button', {
        type: 'button', className: 'bt-voice-btn', 'aria-pressed': phase === 'paused', disabled: phase === 'unsupported',
        'aria-label': phase === 'paused' ? t('Resume listening') : t('Pause'), onClick: togglePause,
      }, h(MicIcon, { size: 20 }), phase === 'paused' ? h('span', { className: 'bt-voice-slash', 'aria-hidden': true }) : null),
      h('button', { type: 'button', className: 'bt-voice-btn bt-voice-end', 'aria-label': t('End voice chat'), onClick: close }, h(CloseIcon))))
}
