// Source of DS Bot's characters. Each one is a small 3D model made of
// signed-distance primitives (spheres, ellipsoids, round cones, a torus, extrusions, and
// the first mascots' design outlines inflated into soft slabs), seen from one fixed
// three-quarter view and traced into flat layers in a 100-unit box: the body, decals,
// a shade on the side away from the light, and a highlight facing it. The eyes are
// capsules laid on the model's front surface and projected the same way, so the near
// eye is wider than the far one and both lean with the surface.
//
//   node dev/characters.mjs                   prints the CHARACTERS block for src/client/characters.js
//   node dev/characters.mjs --preview a.html  also writes a preview gallery
import { writeFileSync } from 'node:fs'
import { BLOSSOM_PETALS, MOON_BODY, SQUIRCLE_BODY, STAR_BODY, WAVE_BODY } from './mascot-outlines.mjs'

// ---------------------------------------------------------------------------
// Vectors and the view.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = a => Math.hypot(a[0], a[1], a[2])
const norm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const rad = deg => (deg * Math.PI) / 180
const mul = (m, p) => [dot(m[0], p), dot(m[1], p), dot(m[2], p)]
const mm = (a, b) => a.map(row => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]))
const tr = m => [0, 1, 2].map(i => [m[0][i], m[1][i], m[2][i]])
const rx = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[1, 0, 0], [0, c, -s], [0, s, c]] }
const ry = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[c, 0, s], [0, 1, 0], [-s, 0, c]] }
const rz = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[c, -s, 0], [s, c, 0], [0, 0, 1]] }

// Object space: x right, y up, z toward the viewer. The model turns its face to the
// viewer's right, tips its top toward the viewer, and leans back a little.
const VIEW = { yaw: 34, pitch: 16, roll: 10 }
const toWorld = mm(rz(VIEW.roll), mm(rx(VIEW.pitch), ry(VIEW.yaw)))
const toObject = tr(toWorld)

// ---------------------------------------------------------------------------
// Signed-distance primitives (Inigo Quilez's formulas).
const sphere = (c, r) => p => len(sub(p, c)) - r
function ellipsoid(c, radii, turn) {
  const m = turn ? tr(rz(turn)) : null
  return (p) => {
    let q = sub(p, c)
    if (m) q = mul(m, q)
    const k0 = len([q[0] / radii[0], q[1] / radii[1], q[2] / radii[2]])
    const k1 = len([q[0] / radii[0] ** 2, q[1] / radii[1] ** 2, q[2] / radii[2] ** 2])
    return k1 === 0 ? -Math.min(...radii) : (k0 * (k0 - 1)) / k1
  }
}
function roundBox(c, half, r) {
  return (p) => {
    const q = sub(p, c).map((v, i) => Math.abs(v) - (half[i] - r))
    return len(q.map(v => Math.max(v, 0))) + Math.min(Math.max(...q), 0) - r
  }
}
function capsule(a, b, r) {
  const ba = sub(b, a)
  return (p) => {
    const pa = sub(p, a)
    const h = Math.max(0, Math.min(1, dot(pa, ba) / dot(ba, ba)))
    return len(sub(pa, ba.map(v => v * h))) - r
  }
}
function roundCone(a, b, r1, r2) {
  const ba = sub(b, a)
  const l2 = dot(ba, ba)
  const rr = r1 - r2
  const a2 = l2 - rr * rr
  const il2 = 1 / l2
  return (p) => {
    const pa = sub(p, a)
    const y = dot(pa, ba)
    const z = y - l2
    const xv = sub(pa.map(v => v * l2), ba.map(v => v * y))
    const x2 = dot(xv, xv)
    const y2 = y * y * l2
    const z2 = z * z * l2
    const k = Math.sign(rr) * rr * rr * x2
    if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2
    if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1
    return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
  }
}
// A ring standing in the xy plane, facing the viewer.
const torus = (c, R, r) => (p) => { const q = sub(p, c); return Math.hypot(Math.hypot(q[0], q[1]) - R, q[2]) - r }
// A 2D profile in the xy plane, pushed `depth` back and forth, its edges rounded by `round`.
const extrude = (profile, depth, round) => (p) => {
  const d = profile(p[0], p[1])
  const w = Math.abs(p[2]) - depth
  return Math.min(Math.max(d, w), 0) + Math.hypot(Math.max(d, 0), Math.max(w, 0)) - round
}
const box2 = (cx, cy, hx, hy) => (x, y) => {
  const qx = Math.abs(x - cx) - hx
  const qy = Math.abs(y - cy) - hy
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
}
const smin = (k, ...parts) => p => parts.map(f => f(p)).reduce((a, b) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k / 4
})
const clipBelow = (f, y) => p => Math.max(f(p), y - p[1])

// ---------------------------------------------------------------------------
// 2D outlines from SVG paths. A path is flattened to polygons, and its signed distance
// (negative inside, even-odd per path, union across paths) is baked on a grid once.
function flatten(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g)
  const loops = []
  let loop = []
  let i = 0
  let cmd = 'M'
  let [x, y] = [0, 0]
  let [sx, sy] = [0, 0]
  let control = null
  const num = () => parseFloat(tokens[i++])
  const close = () => { if (loop.length > 2) loops.push(loop); loop = [] }
  const curve = (points, steps = 12) => {
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps
      const m = 1 - t
      const p = points.length === 3
        ? [m * m * points[0][0] + 2 * m * t * points[1][0] + t * t * points[2][0], m * m * points[0][1] + 2 * m * t * points[1][1] + t * t * points[2][1]]
        : [0, 1].map(k => m * m * m * points[0][k] + 3 * m * m * t * points[1][k] + 3 * m * t * t * points[2][k] + t * t * t * points[3][k])
      loop.push(p)
    }
  }
  const arc = (rx, ry, phi, large, sweep, x2, y2) => {
    const c = Math.cos(rad(phi))
    const s = Math.sin(rad(phi))
    const dx = (x - x2) / 2
    const dy = (y - y2) / 2
    const x1p = c * dx + s * dy
    const y1p = -s * dx + c * dy
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda) }
    const sign = large === sweep ? -1 : 1
    const k = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)))
    const cxp = (k * rx * y1p) / ry
    const cyp = (-k * ry * x1p) / rx
    const cx = c * cxp - s * cyp + (x + x2) / 2
    const cy = s * cxp + c * cyp + (y + y2) / 2
    const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if (!sweep && dt > 0) dt -= 2 * Math.PI
    if (sweep && dt < 0) dt += 2 * Math.PI
    const steps = Math.max(4, Math.ceil(Math.abs(dt) / 0.12))
    for (let n = 1; n <= steps; n += 1) {
      const t = t1 + (dt * n) / steps
      loop.push([cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c])
    }
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M': close(); x = ox + num(); y = oy + num(); [sx, sy] = [x, y]; loop.push([x, y]); cmd = rel ? 'l' : 'L'; control = null; break
      case 'L': x = ox + num(); y = oy + num(); loop.push([x, y]); control = null; break
      case 'H': x = ox + num(); loop.push([x, y]); control = null; break
      case 'V': y = oy + num(); loop.push([x, y]); control = null; break
      case 'C': { const p1 = [ox + num(), oy + num()]; const p2 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p2, p]); [x, y] = p; control = p2; break }
      case 'S': { const p1 = control ? [2 * x - control[0], 2 * y - control[1]] : [x, y]; const p2 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p2, p]); [x, y] = p; control = p2; break }
      case 'Q': { const p1 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p]); [x, y] = p; control = null; break }
      case 'A': { const [rx, ry, phi, large, sweep] = [num(), num(), num(), num(), num()]; const x2 = ox + num(); const y2 = oy + num(); arc(Math.abs(rx), Math.abs(ry), phi, !!large, !!sweep, x2, y2); [x, y] = [x2, y2]; control = null; break }
      case 'Z': close(); [x, y] = [sx, sy]; control = null; break
      default: throw new Error(`Unsupported path command ${cmd}`)
    }
  }
  close()
  return loops
}

function polygonDistance(loops, x, y) {
  let best = Infinity
  let inside = false
  for (const loop of loops) {
    for (let a = 0, b = loop.length - 1; a < loop.length; b = a, a += 1) {
      const [x1, y1] = loop[b]
      const [x2, y2] = loop[a]
      const dx = x2 - x1
      const dy = y2 - y1
      const h = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(x - x1 - dx * h, y - y1 - dy * h))
      if ((y1 > y) !== (y2 > y) && x < x1 + ((y - y1) * dx) / dy) inside = !inside
    }
  }
  return inside ? -best : best
}

// An outline as a 2D distance in object units. `map` takes object (x, y) to the path's
// own coordinates and `unit` is how many path units make one object unit; `grow`
// fattens the outline (in path units), which also rounds its corners.
function outline(paths, { map, unit, grow = 0 }) {
  const shapes = paths.map(flatten)
  const R = 1.6
  const G = 260
  const grid = new Float64Array((G + 1) * (G + 1))
  for (let i = 0; i <= G; i += 1) {
    for (let j = 0; j <= G; j += 1) {
      const [px, py] = map(-R + (2 * R * j) / G, R - (2 * R * i) / G)
      grid[i * (G + 1) + j] = (Math.min(...shapes.map(loops => polygonDistance(loops, px, py))) - grow) / unit
    }
  }
  return (x, y) => {
    const fj = Math.max(0, Math.min(G - 1e-9, ((x + R) / (2 * R)) * G))
    const fi = Math.max(0, Math.min(G - 1e-9, ((R - y) / (2 * R)) * G))
    const [i, j] = [Math.floor(fi), Math.floor(fj)]
    const [ti, tj] = [fi - i, fj - j]
    const at = (a, b) => grid[a * (G + 1) + b]
    const inner = (at(i, j) * (1 - tj) + at(i, j + 1) * tj) * (1 - ti) + (at(i + 1, j) * (1 - tj) + at(i + 1, j + 1) * tj) * ti
    // Outside the baked square the distance only grows.
    return inner + Math.max(0, Math.abs(x) - R, Math.abs(y) - R)
  }
}
// A 512-unit design box seen as object space: its center at the origin, `per` design
// units to one object unit, y up.
const box512 = (cx, cy, per = 190) => ({ map: (x, y) => [cx + x * per, cy - y * per], unit: per })

// A soft slab: the outline pushed back and forth `depth`, its rim rounded by `round`.
const puffy = (profile, depth, round) => extrude((x, y) => profile(x, y) + round, depth, round)
// A 2D distance seen on the front of a model as a decal.
const segment2 = (ax, ay, bx, by) => (x, y) => {
  const dx = bx - ax
  const dy = by - ay
  const h = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - ax - dx * h, y - ay - dy * h)
}
const polyline2 = (points, width) => (x, y) => Math.min(...points.slice(1).map((p, k) => segment2(...points[k], ...p)(x, y))) - width
const circle2 = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r

// ---------------------------------------------------------------------------
// The models. `eyes` are [x, y] spots on the front, found by a ray along -z; `eye`
// scales the capsule (1 = 10 by 23 units at a face-on spot).
// `paints` are decals on the model's front: a region (negative inside) of the hit
// point, drawn in a fixed color over the body color.
const decal = (region2, fill, opacity = 1) => ({ region: p => region2(p[0], p[1]), fill, opacity })
// The wave's heart, drawn freehand in a 100-unit box (y down), a little lopsided on purpose.
const WAVE_HEART = 'M50 78C38 70 22 59 20 45C18.5 35 25 27 34 27C41 27 46.5 31.5 50 37.5C53.5 31 59.5 26.5 66.5 27C75.5 27.5 81.5 35.5 80 45.5C78 59.5 62 70.5 50 78Z'

// The first mascots: their original outlines, inflated into soft 3D bodies.
const MASCOTS = {
  whale: {
    label: 'Whale',
    sdf: smin(0.14,
      ellipsoid([0.12, -0.06, 0], [0.8, 0.68, 0.66]),
      roundCone([-0.42, -0.34, 0], [-1.0, 0.16, 0], 0.18, 0.065),
      ellipsoid([-0.96, 0.5, 0], [0.13, 0.36, 0.09], 14),
      ellipsoid([-1.28, 0.22, 0], [0.13, 0.34, 0.09], 74)),
    eyes: [[-0.06, 0.12], [0.34, 0.12]],
    paints: [{ region: p => Math.max(sphere([0.42, -0.98, 0.52], 0.72)(p), -0.04 - p[2]), fill: '#fff', opacity: 1 }],
  },
  moon: {
    label: 'Moon',
    sdf: puffy(outline([MOON_BODY], box512(244, 288)), 0.1, 0.24),
    eyes: [[-0.2, 0.04], [0.22, 0.04]],
    paints: [decal((x, y) => Math.max(circle2(0.232, 0.674, 0.147)(x, y), -circle2(0.3, 0.747, 0.127)(x, y)), '#1783FF')],
  },
  zed: {
    label: 'Bull',
    sdf: smin(0.1,
      ellipsoid([0, -0.12, 0], [0.74, 0.68, 0.62]),
      roundCone([0.4, 0.3, 0], [0.78, 0.5, 0], 0.18, 0.12),
      roundCone([0.78, 0.5, 0], [0.86, 0.86, 0], 0.12, 0.05),
      roundCone([-0.4, 0.3, 0], [-0.78, 0.5, 0], 0.18, 0.12),
      roundCone([-0.78, 0.5, 0], [-0.86, 0.86, 0], 0.12, 0.05),
      ellipsoid([0.76, 0.02, -0.08], [0.26, 0.12, 0.1], -14),
      ellipsoid([-0.76, 0.02, -0.08], [0.26, 0.12, 0.1], 14)),
    eyes: [[-0.22, -0.1], [0.22, -0.1]],
    paints: [decal(polyline2([[-0.1, 0.44], [0.1, 0.44], [-0.09, 0.3], [0.11, 0.3]], 0.034), '#fff')],
  },
  wave: {
    label: 'Wave',
    sdf: puffy(outline([WAVE_BODY], box512(256, 262)), 0.1, 0.24),
    eyes: [[-0.2, 0.34], [0.2, 0.34]],
    // A hand-drawn heart, low on the body.
    paints: [decal(outline([WAVE_HEART], { map: (x, y) => [50 + x * 120, 50 - (y + 0.22) * 120], unit: 120 }), '#fff', 0.4)],
  },
  star: {
    label: 'Star',
    sdf: puffy(outline([STAR_BODY], { ...box512(256, 262), grow: 22 }), 0.1, 0.2),
    eyes: [[-0.17, -0.02], [0.17, -0.02]],
    eye: 0.85,
  },
  squircle: {
    label: 'Squircle',
    sdf: puffy(outline([SQUIRCLE_BODY], box512(256, 256)), 0.12, 0.26),
    eyes: [[-0.2, 0.06], [0.2, 0.06]],
  },
  hex: {
    label: 'Blossom',
    sdf: puffy(outline(BLOSSOM_PETALS, { map: (x, y) => [9.86 + x * 9.6, 10 - y * 9.6], unit: 9.6, grow: 0.6 }), 0.08, 0.12),
    eyes: [[-0.16, -0.04], [0.18, -0.04]],
    eye: 0.8,
  },
}

// The geometric characters.
const GEOMETRIC = {
  gumdrop: {
    sdf: roundCone([0, -0.55, 0], [0, 0.55, 0], 0.82, 0.42),
    eyes: [[-0.2, 0.18], [0.2, 0.18]],
  },
  peanut: {
    sdf: smin(0.35, sphere([0, 0.42, 0], 0.6), sphere([0, -0.5, 0], 0.72)),
    eyes: [[-0.2, 0.5], [0.2, 0.5]],
    eye: 0.9,
  },
  saucer: {
    sdf: smin(0.12, ellipsoid([0, -0.25, 0], [1.05, 0.3, 1.05]), sphere([0, 0, 0], 0.56)),
    eyes: [[-0.18, 0.18], [0.18, 0.18]],
    eye: 0.8,
  },
  bunny: {
    sdf: smin(0.14, sphere([0, -0.3, 0], 0.68), ellipsoid([-0.26, 0.62, -0.05], [0.16, 0.48, 0.12], 10), ellipsoid([0.26, 0.62, -0.05], [0.16, 0.48, 0.12], -10)),
    eyes: [[-0.2, -0.22], [0.2, -0.22]],
    eye: 0.85,
  },
  kitty: {
    sdf: smin(0.12, ellipsoid([0, -0.12, 0], [0.86, 0.74, 0.72]), roundCone([-0.42, 0.4, 0], [-0.58, 0.92, 0], 0.26, 0.05), roundCone([0.42, 0.4, 0], [0.58, 0.92, 0], 0.26, 0.05)),
    eyes: [[-0.24, -0.05], [0.24, -0.05]],
  },
  beacon: {
    sdf: smin(0.05, roundBox([0, -0.22, 0], [0.82, 0.62, 0.56], 0.26), capsule([0, 0.3, 0], [0, 0.82, 0], 0.07), sphere([0, 0.9, 0], 0.16)),
    eyes: [[-0.26, -0.2], [0.26, -0.2]],
  },
  plus: {
    sdf: extrude((x, y) => Math.min(box2(0, 0, 0.82, 0.24)(x, y), box2(0, 0, 0.24, 0.82)(x, y)), 0.22, 0.14),
    eyes: [[-0.14, 0.02], [0.14, 0.02]],
    eye: 0.72,
  },
  magnet: {
    sdf: extrude((x, y) => Math.max(y < 0 ? Math.abs(Math.hypot(x, y) - 0.56) - 0.24 : Math.abs(Math.abs(x) - 0.56) - 0.24, y - 0.72), 0.22, 0.1),
    eyes: [[-0.17, -0.56], [0.17, -0.56]],
    eye: 0.72,
  },
  acorn: {
    sdf: smin(0.04, ellipsoid([0, -0.22, 0], [0.72, 0.78, 0.72]), clipBelow(ellipsoid([0, 0.3, 0], [0.88, 0.5, 0.88]), 0.16), capsule([0, 0.72, 0], [0.08, 0.98, 0], 0.08)),
    eyes: [[-0.22, -0.12], [0.22, -0.12]],
  },
  pebbles: {
    sdf: smin(0.22, roundBox([0, -0.48, 0], [0.9, 0.38, 0.62], 0.34), roundBox([0.05, 0.36, 0], [0.62, 0.4, 0.5], 0.3)),
    eyes: [[-0.16, 0.38], [0.24, 0.38]],
    eye: 0.82,
  },
  cushion: {
    sdf: roundBox([0, 0, 0], [0.92, 0.78, 0.38], 0.36),
    eyes: [[-0.26, -0.02], [0.22, -0.02]],
  },
  ring: {
    sdf: torus([0, 0, 0], 0.64, 0.3),
    eyes: [[-0.2, -0.64], [0.2, -0.64]],
    eye: 0.62,
  },
  gem: {
    sdf: extrude((x, y) => polygonDistance([[[-0.52, 0.56], [0.52, 0.56], [0.94, 0.12], [0, -0.86], [-0.94, 0.12]]], x, y), 0.24, 0.1),
    eyes: [[-0.2, 0.2], [0.2, 0.2]],
    eye: 0.8,
  },
}

// Picker order: the mascots lead, the star second.
const ORDER = ['whale', 'star', 'moon', 'wave', 'squircle', 'zed', 'hex']
const MODELS = { ...Object.fromEntries(ORDER.map(id => [id, MASCOTS[id]])), ...GEOMETRIC }

function contours(field) {
  const at = (i, j) => field[i * (N + 1) + j]
  const point = (i, j, di, dj) => {
    const a = at(i, j)
    const b = at(i + di, j + dj)
    const k = a / (a - b)
    return [-EXTENT + (j + dj * k) * STEP, EXTENT - (i + di * k) * STEP]
  }
  const segments = []
  const edge = {
    top: (i, j) => [`h${i},${j}`, () => point(i, j, 0, 1)],
    bottom: (i, j) => [`h${i + 1},${j}`, () => point(i + 1, j, 0, 1)],
    left: (i, j) => [`v${i},${j}`, () => point(i, j, 1, 0)],
    right: (i, j) => [`v${i},${j + 1}`, () => point(i, j + 1, 1, 0)],
  }
  const PAIRS = {
    1: [['left', 'bottom']], 2: [['bottom', 'right']], 3: [['left', 'right']], 4: [['top', 'right']],
    5: [['left', 'top'], ['bottom', 'right']], 6: [['top', 'bottom']], 7: [['left', 'top']], 8: [['left', 'top']],
    9: [['top', 'bottom']], 10: [['left', 'bottom'], ['top', 'right']], 11: [['top', 'right']], 12: [['left', 'right']],
    13: [['bottom', 'right']], 14: [['left', 'bottom']],
  }
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const code = (at(i, j) < 0 ? 8 : 0) | (at(i, j + 1) < 0 ? 4 : 0) | (at(i + 1, j + 1) < 0 ? 2 : 0) | (at(i + 1, j) < 0 ? 1 : 0)
      for (const [a, b] of PAIRS[code] ?? []) segments.push([edge[a](i, j), edge[b](i, j)])
    }
  }
  const byEdge = new Map()
  segments.forEach(([a, b], index) => {
    for (const [key] of [a, b]) byEdge.set(key, [...(byEdge.get(key) ?? []), index])
  })
  const used = new Set()
  const loops = []
  for (let start = 0; start < segments.length; start += 1) {
    if (used.has(start)) continue
    const loop = []
    let index = start
    let [[fromKey, fromPoint], [toKey]] = segments[start]
    loop.push(fromPoint())
    for (;;) {
      used.add(index)
      const [a, b] = segments[index]
      const [nextKey, nextPoint] = a[0] === fromKey ? b : a
      loop.push(nextPoint())
      fromKey = nextKey
      const next = (byEdge.get(nextKey) ?? []).find(other => !used.has(other))
      if (next === undefined) break
      index = next
    }
    void toKey
    if (loop.length > 8) loops.push(loop)
  }
  return loops
}

function simplify(points, tolerance) {
  if (points.length < 3) return points
  const [a, b] = [points[0], points.at(-1)]
  let far = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l
    if (d > far) { far = d; index = i }
  }
  if (far <= tolerance) return [a, b]
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)]
}

// ---------------------------------------------------------------------------
// Tracing. Each grid ray keeps the smallest distance it meets: negative inside the
// silhouette, about the distance to it outside, so marching squares finds a smooth edge.
const N = 300
const EXTENT = 1.7
const STEP = (2 * EXTENT) / N

// Light from the upper left, a little in front. The side turned away from it is the
// shade; the patch facing it is the highlight, which is what shapes a black body.
const LIGHT = norm([-0.62, 0.68, 0.4])
const SHADE_AT = 0.06
const LIGHT_AT = 0.86

function gradient(sdf, p) {
  const e = 1e-3
  return norm([0, 1, 2].map((axis) => {
    const plus = [...p]
    const minus = [...p]
    plus[axis] += e
    minus[axis] -= e
    return sdf(plus) - sdf(minus)
  }))
}

// The ray's smallest distance and, when it hits, the hit point and normal (object space).
function rayMin(sdf, X, Y) {
  let t = 2.4
  let best = Infinity
  let hit = null
  for (let i = 0; i < 400 && t > -2.4; i += 1) {
    const p = mul(toObject, [X, Y, t])
    const d = sdf(p)
    if (d < best) best = d
    if (d < 1e-3 && hit === null) hit = { p, n: gradient(sdf, p) }
    t -= Math.max(Math.abs(d) * 0.8, 0.002)
  }
  return [best, hit]
}

function surfaceAt(sdf, x, y) {
  let z = 2.5
  for (let i = 0; i < 300; i += 1) {
    const d = sdf([x, y, z])
    if (d < 1e-4) break
    z -= Math.max(d, 1e-4)
  }
  const p = [x, y, z]
  return { p, n: gradient(sdf, p) }
}

const f = n => String(+n.toFixed(1))

function build(model) {
  const size = (N + 1) * (N + 1)
  const field = new Float64Array(size)
  const paints = model.paints ?? []
  // Every layer lies inside the body: its field is the body's field where the layer
  // applies and outside everywhere else, so no layer spills past the silhouette.
  const layers = { shade: new Float64Array(size), light: new Float64Array(size), paints: paints.map(() => new Float64Array(size)) }
  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= N; j += 1) {
      const k = i * (N + 1) + j
      const [d, hit] = rayMin(model.sdf, -EXTENT + j * STEP, EXTENT - i * STEP)
      field[k] = d
      const off = Math.max(d, STEP)
      if (hit === null) {
        layers.shade[k] = off
        layers.light[k] = off
        layers.paints.forEach((layer) => { layer[k] = off })
        continue
      }
      const lit = dot(mul(toWorld, hit.n), LIGHT)
      layers.shade[k] = Math.max(d, (lit - SHADE_AT) * 0.25)
      layers.light[k] = Math.max(d, (LIGHT_AT - lit) * 0.25)
      paints.forEach((paint, index) => {
        layers.paints[index][k] = hit.n[2] > 0.1 ? Math.max(d, paint.region(hit.p)) : off
      })
    }
  }
  const loops = contours(field)
  const all = loops.flat()
  const xs = all.map(p => p[0])
  const ys = all.map(p => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = 92 / Math.max(x1 - x0, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const place = ([X, Y]) => [50 + (X - cx) * scale, 50 - (Y - cy) * scale]
  const toPath = loopList => loopList.map((loop) => {
    // A closed loop starts and ends on the same point, so split it at its far side
    // before simplifying; otherwise every point is "on" the zero-length chord.
    const ring = loop.map(place)
    const far = ring.reduce((best, p, i) => (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[best][0] - ring[0][0], ring[best][1] - ring[0][1]) ? i : best), 0)
    const points = [...simplify(ring.slice(0, far + 1), 0.25).slice(0, -1), ...simplify(ring.slice(far), 0.25)].slice(0, -1)
    // Relative steps on a 0.1 grid keep the strings short; rounding the running point
    // rather than each step stops the error from adding up around the loop.
    const grid = points.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)])
    const steps = grid.slice(1).map(([x, y], k) => [x - grid[k][0], y - grid[k][1]]).filter(([dx, dy]) => dx || dy)
    const num = v => (v < 0 ? '-' : ' ') + String(Math.abs(v) / 10).replace(/^0\./, '.')
    return `M${f(grid[0][0] / 10)} ${f(grid[0][1] / 10)}l${steps.map(([dx, dy]) => `${num(dx)}${num(dy)}`).join('').trim()}z`
  }).join('')
  const eyeSize = model.eye ?? 1
  const eyes = model.eyes.map(([x, y]) => {
    const { p, n } = surfaceAt(model.sdf, x, y)
    const u = norm(cross([0, 1, 0], n))
    const v = cross(n, u)
    const [wp, wu, wv] = [mul(toWorld, p), mul(toWorld, u), mul(toWorld, v)]
    const [ex, ey] = place([wp[0], wp[1]])
    const vs = [wv[0], -wv[1]]
    const tilt = (Math.atan2(vs[0], -vs[1]) * 180) / Math.PI
    return [ex, ey, 10 * eyeSize * Math.hypot(wu[0], wu[1]), 23 * eyeSize * Math.hypot(...vs), tilt].map(value => +value.toFixed(1))
  })
  return {
    ...(model.label ? { label: model.label } : {}),
    body: toPath(loops),
    ...(paints.length ? { paints: paints.map((paint, index) => [toPath(contours(layers.paints[index])), paint.fill, paint.opacity]) } : {}),
    shade: toPath(contours(layers.shade)),
    light: toPath(contours(layers.light)),
    eyes,
  }
}

export const CHARACTERS = Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [id, build(model)]))

const block = Object.entries(CHARACTERS).map(([id, character]) => `  ${id}: ${JSON.stringify(character).replace(/"(\w+)":/g, '$1:').replaceAll('"', "'")},`).join('\n')
console.log(`export const CHARACTERS = {\n${block}\n}`)

const out = process.argv.indexOf('--preview')
if (out > 0) {
  const colors = ['#A27952', '#FF3E51', '#FF781C', '#FFAF38', '#00C972', '#1CC3B0', '#2A92FE', '#A97EFE', '#FF5EB1', '#959595']
  const INK = { whale: '#4D6BFE', moon: '#141416', zed: '#2D2D2D', wave: '#EC2F6B', star: '#0AA8D6', squircle: '#FF6900', hex: '#082DFF' }
  const INK_DARK = { moon: '#F1F2F4', zed: '#D6D6DA' }
  let serial = 0
  const mark = (c, color, size) => {
    serial += 1
    const holes = c.eyes.map(([ex, ey, w, h, tilt]) => `<g transform="translate(${ex} ${ey}) rotate(${tilt})"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="#000"/></g>`).join('')
    const paint = (c.paints ?? []).map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" fill-opacity="${opacity}"/>`).join('')
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100"><defs><mask id="m${serial}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="300" height="300"><rect x="-100" y="-100" width="300" height="300" fill="#fff"/>${holes}</mask></defs><g mask="url(#m${serial})" fill-rule="evenodd"><path d="${c.body}" fill="${color}"/>${paint}<path d="${c.shade}" fill="#000" fill-opacity=".14"/><path d="${c.light}" fill="#fff" fill-opacity=".16"/></g></svg>`
  }
  const cells = dark => Object.entries(CHARACTERS).map(([id, c], index) => {
    const color = (dark && INK_DARK[id]) || INK[id] || colors[index % colors.length]
    return `<div class="cell"><div>${mark(c, color, 96)}</div><div class="row">${mark(c, color, 40)}${mark(c, dark ? '#fff' : '#000', 28)}${mark(c, color, 20)}</div><div class="name">${id}</div></div>`
  }).join('')
  writeFileSync(process.argv[out + 1], `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px -apple-system,system-ui,sans-serif;background:#fcfcfc}section{padding:12px 20px;display:grid;grid-template-columns:repeat(7,104px);gap:4px}.dark{background:#141414}.cell{display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px 0}.row{display:flex;align-items:center;gap:6px}.name{color:#777}</style><section>${cells(false)}</section><section class="dark">${cells(true)}</section>`)
}
