'use strict';
// ---------------------------------------------------------------------------
// Math, random and color helpers shared by every module.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, t) => {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
};
const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

function angNorm(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
const angDiff = (from, to) => angNorm(to - from);
// Shortest-way-round interpolation between two angles.
const lerpAngle = (a, b, t) => angNorm(a + angDiff(a, b) * t);

function rotateToward(cur, target, maxStep) {
  const d = angDiff(cur, target);
  if (Math.abs(d) <= maxStep) return angNorm(target);
  return angNorm(cur + Math.sign(d) * maxStep);
}

// Frame-rate independent exponential smoothing factor.
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ---- Seeded RNG -------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RNG {
  constructor(seed) { this.seed = seed >>> 0; this.next = mulberry32(this.seed); }
  float(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.float(a, b + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  gauss() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// Unseeded helpers for purely cosmetic randomness.
const rand = (a = 0, b = 1) => a + (b - a) * Math.random();
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const randPick = arr => arr[Math.floor(Math.random() * arr.length)];

// ---- Value noise --------------------------------------------------------------
function makeNoise(rng) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  const p = [];
  for (let i = 0; i < 256; i++) { p.push(i); vals[i] = rng.next(); }
  rng.shuffle(p);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = t => t * t * (3 - 2 * t);
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const v00 = vals[perm[X + perm[Y]]];
    const v10 = vals[perm[X + 1 + perm[Y]]];
    const v01 = vals[perm[X + perm[Y + 1]]];
    const v11 = vals[perm[X + 1 + perm[Y + 1]]];
    const u = fade(xf), v = fade(yf);
    return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
  }
  function fbm(x, y, oct = 4) {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }
  return { noise, fbm };
}

// ---- Color --------------------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  const c = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function mixColor(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
}
// amt > 0 lightens toward white, amt < 0 darkens toward black.
function shade(hex, amt) {
  return amt >= 0 ? mixColor(hex, '#ffffff', amt) : mixColor(hex, '#000000', -amt);
}
// HUD bars: scale rather than resize, and only when the value really changed.
// A width change lays the page out again; a transform is only composited.
function setBar(owner, key, v) {
  const el = owner[key];
  if (!el) return;
  const k = Math.round(clamp(v, 0, 1) * 500) / 500;
  const seen = key + '_was';
  if (owner[seen] === k) return;
  owner[seen] = k;
  el.style.transform = 'scaleX(' + k + ')';
}

// Drop everything whose life has run out, in place, order not preserved.
function reapDead(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].life <= 0) { list[i] = list[list.length - 1]; list.pop(); }
  }
}

// The same few colours are rebuilt into strings every frame: remember them.
const RGBA_MEMO = new Map();
function rgba(hex, a) {
  const key = hex + '|' + a;
  let s = RGBA_MEMO.get(key);
  if (s === undefined) {
    const [r, g, b] = hexToRgb(hex);
    s = `rgba(${r},${g},${b},${a})`;
    if (RGBA_MEMO.size < 4096) RGBA_MEMO.set(key, s);
  }
  return s;
}
function hsl(h, s, l) { return `hsl(${h},${s}%,${l}%)`; }
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

// Touch-first devices get lighter textures (phones have tight canvas memory).
const LOW_MEM = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

// Creates an offscreen canvas. Works in the browser; returns null headless.
function makeCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// A finished sprite blits faster as an ImageBitmap than as a canvas (about a
// fifth less per drawImage on a phone). Conversion is asynchronous: `swap`
// receives the bitmap when it is ready, and the canvas serves until then.
function toBitmap(canvas, swap) {
  if (!canvas || typeof createImageBitmap !== 'function') return;
  createImageBitmap(canvas).then(swap, () => {});
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
