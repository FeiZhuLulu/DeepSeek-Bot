import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// A damped spring (mass 1) sampled into a CSS linear() easing, for WAAPI glides
// and CSS transitions alike.
export function springEasing(stiffness, damping) {
  const w0 = Math.sqrt(stiffness)
  const zeta = damping / (2 * w0)
  const at = (t) => {
    if (zeta >= 1) return 1 - (1 + w0 * t) * Math.exp(-w0 * t)
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t))
  }
  let end = 0.05
  while (end < 2 && Math.abs(1 - at(end)) > 0.001) end += 0.01
  const points = Array.from({ length: 25 }, (_, index) => (index === 24 ? 1 : at(end * index / 24)).toFixed(4))
  return { duration: Math.round(end * 1000), easing: `linear(${points.join(',')})`, stiffness, damping }
}

// The capsule's two springs: a gentle one (ω=20, ζ=0.78) reshapes surfaces, a
// tighter one (ω=30, ζ=0.8) answers the press.
export const SPRING_SHAPE = springEasing(400, 31.2)
export const SPRING_TAP = springEasing(900, 48)
// Rows of a list move to new places on ω=22, ζ=0.8.
export const SPRING_LIST = springEasing(484, 35.2)
// A looser spring (ω≈18, ζ≈0.56) that overshoots a little, for a surface that stretches
// open, and a quicker one for a mark that pops in.
export const SPRING_STRETCH = springEasing(320, 20)
export const SPRING_POP = springEasing(500, 22)
// A thumb's two edges: the one in front runs the fast spring (ω=28), the one behind
// the slower one (ω=17), so the thumb stretches into the move and settles behind it
// within about a quarter second.
export const SPRING_LEAD = springEasing(784, 48.2)
export const SPRING_TRAIL = springEasing(289, 29.2)
// A highlight that follows the keyboard and pointer down a list keeps up on stiffer
// edges (ω=30 and ω=20).
export const QUICK_EDGES = { lead: springEasing(900, 51), trail: springEasing(400, 34) }

export const spring = (curve, ...properties) => properties.map(property => `${property} ${curve.duration}ms ${curve.easing}`).join(',')

// Springs stepped once per frame. A new target keeps the current velocity, so a thumb
// that is sent somewhere else mid-move turns smoothly instead of starting over. Each
// frame covers the whole time since the last one, like a CSS transition, so a busy
// page delays the thumb instead of slowing it down.
function liveSprings(apply) {
  const values = new Map()
  let frame = 0
  let last = 0
  const read = () => Object.fromEntries([...values].map(([key, value]) => [key, value.x]))
  const step = (now) => {
    const dt = Math.min(0.5, Math.max(0.001, (now - last) / 1000))
    last = now
    const steps = Math.ceil(dt * 240)
    const h = dt / steps
    let moving = false
    for (const value of values.values()) {
      for (let index = 0; index < steps; index += 1) {
        value.v += (-value.k * (value.x - value.to) - value.c * value.v) * h
        value.x += value.v * h
      }
      if (Math.abs(value.x - value.to) < 0.05 && Math.abs(value.v) < 1) { value.x = value.to; value.v = 0 } else moving = true
    }
    apply(read())
    frame = moving ? requestAnimationFrame(step) : 0
  }
  return {
    target: () => (values.size ? Object.fromEntries([...values].map(([key, value]) => [key, value.to])) : null),
    set(targets, curves, jump) {
      for (const [key, to] of Object.entries(targets)) {
        const value = values.get(key)
        const { stiffness: k, damping: c } = curves[key]
        if (!value || jump) values.set(key, { x: to, v: 0, to, k, c })
        else Object.assign(value, { to, k, c })
      }
      if (jump) { cancelAnimationFrame(frame); frame = 0; apply(read()); return }
      if (!frame) { last = performance.now(); frame = requestAnimationFrame(step) }
    },
    stop: () => cancelAnimationFrame(frame),
  }
}

const CHOSEN = '[aria-pressed="true"],[aria-selected="true"],[aria-current="page"]'

// One thumb for a row (or column) of choices that glides to the chosen one. Attach
// `box` to the positioned container and `thumb` to an absolutely placed child; the
// thumb appears in place with a new box, then springs on every change of `key`. The
// box gets data-glide once the thumb is placed, so its CSS can drop the chosen item's
// own fill. `selector` finds the chosen item; with none the thumb gets data-hidden.
// `box` takes a ref the caller already holds for the container.
export function useGlide(key, { axis = 'x', selector = CHOSEN, lead = SPRING_LEAD, trail = SPRING_TRAIL, box: given } = {}) {
  const ownBox = useRef(null)
  const box = given ?? ownBox
  const thumb = useRef(null)
  const own = useRef(null)
  if (own.current === null) {
    own.current = {
      key: undefined, node: null, observer: null,
      springs: liveSprings(({ start, end }) => {
        const knob = thumb.current
        if (!knob) return
        knob.style.transform = axis === 'x' ? `translateX(${start}px)` : `translateY(${start}px)`
        knob.style[axis === 'x' ? 'width' : 'height'] = `${Math.max(0, end - start)}px`
      }),
    }
  }
  // `jump` places without motion, and only when the chosen item moved: a box that
  // resizes while the thumb is under way does not cut the glide short.
  const place = (jump) => {
    const container = box.current
    const knob = thumb.current
    if (!container || !knob) return
    const chosen = container.querySelector(selector)
    if (!chosen) { knob.dataset.hidden = ''; return }
    const start = axis === 'x' ? chosen.offsetLeft : chosen.offsetTop
    const end = start + (axis === 'x' ? chosen.offsetWidth : chosen.offsetHeight)
    const { springs } = own.current
    const before = springs.target()
    const hidden = knob.dataset.hidden !== undefined
    if (jump && !hidden && before?.start === start && before?.end === end && container.dataset.glide !== undefined) return
    delete knob.dataset.hidden
    const forward = before === null || start >= before.start
    springs.set({ start, end }, forward ? { start: trail, end: lead } : { start: lead, end: trail }, jump || hidden || before === null || reducedMotion())
    container.dataset.glide = ''
  }
  useLayoutEffect(() => {
    const state = own.current
    const node = box.current
    if (node === state.node && key === state.key) return
    const fresh = node !== state.node
    state.key = key
    if (fresh) {
      state.observer?.disconnect()
      state.node = node
      state.observer = node && typeof ResizeObserver === 'function' ? new ResizeObserver(() => place(true)) : null
      state.observer?.observe(node)
    }
    place(fresh)
  })
  useEffect(() => () => { own.current.observer?.disconnect(); own.current.springs.stop() }, [])
  return { box, thumb }
}

// Buttons side by side over one thumb that glides to the pressed one (aria-pressed).
export function Segmented({ label, value, className, children }) {
  const glide = useGlide(value)
  return h('div', { ref: glide.box, className: className ? `bt-seg ${className}` : 'bt-seg', role: 'group', 'aria-label': label },
    h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }), children)
}

// Children of `list` matching `selector` slide from where they were to where a change of
// `key` put them, on SPRING_LIST, and children that were not there before clear from a
// blur; `id` names a child across renders. offsetTop ignores transforms, so a slide in
// flight does not skew the next one.
export function useFlip(list, key, selector, id = node => node.dataset.flip) {
  const tops = useRef(null)
  useLayoutEffect(() => {
    const container = list.current
    if (!container) return
    const next = new Map()
    const moving = tops.current !== null && !reducedMotion()
    for (const node of container.querySelectorAll(selector)) {
      const name = id(node)
      const top = node.offsetTop
      next.set(name, top)
      if (!moving) continue
      const before = tops.current.get(name)
      if (before === undefined) {
        node.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' })
      } else if (Math.abs(before - top) > 0.5) {
        node.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: SPRING_LIST.duration, easing: SPRING_LIST.easing })
      }
    }
    tops.current = next
  }, [key])
}

// `box` changes height on SPRING_SHAPE when a change of `key` changes its content, so
// a surface reshapes around what it holds instead of jumping. A change that comes
// mid-morph starts from the height on screen. The box clips its content meanwhile.
export function useMorph(box, key) {
  const last = useRef({ key, height: null })
  useLayoutEffect(() => {
    const node = box.current
    const state = last.current
    if (!node) { last.current = { key, height: null }; return }
    const running = node.getAnimations().filter(animation => animation.id === 'bt-morph')
    if (key === state.key) {
      if (running.length === 0) state.height = node.offsetHeight
      return
    }
    const from = running.length ? node.offsetHeight : state.height
    for (const animation of running) animation.cancel()
    const to = node.offsetHeight
    last.current = { key, height: to }
    if (from === null || Math.abs(from - to) < 1 || reducedMotion()) return
    node.dataset.morph = ''
    const animation = node.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: SPRING_SHAPE.duration, easing: SPRING_SHAPE.easing, id: 'bt-morph' })
    animation.onfinish = () => { delete node.dataset.morph }
    animation.oncancel = () => { if (!node.getAnimations().some(other => other.id === 'bt-morph' && other !== animation)) delete node.dataset.morph }
  })
}

// The last truthy `value` for `ms` after it turns falsy, so a closing layer can play its
// exit; `leaving` is true meanwhile.
export function useLinger(value, ms) {
  const [kept, setKept] = useState(value)
  useEffect(() => {
    if (value) { setKept(value); return undefined }
    const timer = setTimeout(() => setKept(value), reducedMotion() ? 0 : ms)
    return () => clearTimeout(timer)
  }, [value])
  return [value || kept, !value && Boolean(kept)]
}
