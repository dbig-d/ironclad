'use strict';
// ---------------------------------------------------------------------------
// Battlefield: procedural layout, collision geometry, line of sight and a
// navigation grid with A* for the bots.
// ---------------------------------------------------------------------------

const NAV_CELL = 24;
const OGRID = 128;             // obstacle lookup grid cell (px)
const NAV_DX = [1, -1, 0, 0, 1, 1, -1, -1], NAV_DY = [0, 0, 1, -1, 1, -1, 1, -1], NAV_DC = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142];
const NAV_CLEAR = TANK.radius + 1;
const OBSTACLE_GAP = 82;   // min gap between unrelated obstacles (tank width + slack)

class GameMap {
  // opts: { w, h, seed, biome, layout: 'teams'|'ffa', mode, hillR, spawnCount, recipe }
  // recipe (campaign maps): { density, kinds, roads, convoy, features: [...] } in
  // normalised coordinates; team maps mirror every feature through the centre.
  constructor(opts) {
    this.w = opts.w;
    this.h = opts.h;
    this.seed = opts.seed >>> 0;
    this.biome = BIOMES[opts.biome] || BIOMES.grassland;
    this.layout = opts.layout;
    this.mode = opts.mode;
    this.rng = new RNG(this.seed);
    this.obstacles = [];
    this.roads = [];
    this.bases = [];
    this.hill = null;
    this.spawns = [];
    this._clusterId = 1;
    this.recipe = opts.recipe || null;
    this.decals = [];     // painted-only set pieces (crop fields, frozen lakes, scorched earth)
    this.convoyRoute = null;

    if (this.layout === 'teams') {
      this.bases = [{ x: 170, y: this.h / 2 }, { x: this.w - 170, y: this.h / 2 }];
      // Several spawn zones per side so teams fan out along different lanes.
      // CTF uses two flank bunkers so the flag isn't in the respawn stream.
      this.spawnCenters = this.bases.map((b, t) => {
        const x = b.x + (t === 0 ? 1 : -1) * 120;
        const ys = this.mode === 'ctf' ? [0.2, 0.8] : [0.18, 0.5, 0.82];
        return ys.map(f => ({ x, y: this.h * f }));
      });
      this.lanes = [0.2, 0.5, 0.8].map(f => f * this.h);
      if (this.mode === 'koth') this.hill = { x: this.w / 2, y: this.h / 2, r: opts.hillR || 200 };
      this.generateTeams();
    } else {
      this.generateFFA();
    }
    this.buildNav();
    this.pools = [];
    this.generateWater();
    this.buildWaterMask();
    this.makeSpawns(opts.spawnCount || 8);
  }

  // ---- water (marsh) -----------------------------------------------------------------
  // A pool is a clump of overlapping ellipses. Roads cross water on bridges.
  makePool(x, y, r, R) {
    const blobs = [];
    for (let i = 0; i < 5; i++) blobs.push([x + R.float(-r, r) * 0.45, y + R.float(-r, r) * 0.3, r * R.float(0.45, 0.7), r * R.float(0.3, 0.5), R.float(-0.4, 0.4)]);
    let reach = 0;
    for (const [bx, by, rx] of blobs) reach = Math.max(reach, dist(x, y, bx, by) + rx);
    return { x, y, r, reach, blobs };
  }

  mirrorPool(p) {
    return { x: this.w - p.x, y: this.h - p.y, r: p.r, reach: p.reach, blobs: p.blobs.map(([bx, by, rx, ry, a]) => [this.w - bx, this.h - by, rx, ry, a]) };
  }

  poolFits(p) {
    if (p.x - p.reach < 60 || p.y - p.reach < 60 || p.x + p.reach > this.w - 60 || p.y + p.reach > this.h - 60) return false;
    for (let a = 0; a < TAU; a += Math.PI / 6) if (this.onRoad(p.x + Math.cos(a) * p.reach, p.y + Math.sin(a) * p.reach)) return false;
    if (this.onRoad(p.x, p.y) || this.pointBlocked(p.x, p.y, p.r * 0.6)) return false;
    if (this.layout === 'teams') for (const cs of this.spawnCenters) for (const c of cs) if (Math.abs(c.x - p.x) < 180 + p.reach && Math.abs(c.y - p.y) < 190 + p.reach) return false;
    if (this.hill && dist(this.hill.x, this.hill.y, p.x, p.y) < this.hill.r + p.reach) return false;
    return !this.pools.some(o => dist(o.x, o.y, p.x, p.y) < o.reach + p.reach + 30);
  }

  generateWater() {
    const R = new RNG(this.seed ^ 0x77aa11), teams = this.layout === 'teams';
    // Designed water first: ponds and rivers (a river is one long pool of blobs).
    for (const f of (this.recipe && this.recipe.features) || []) {
      let p = null;
      if (f.t === 'pond') p = this.makePool(f.x * this.w, f.y * this.h, f.r, R);
      else if (f.t === 'river') {
        const pts = f.pts.map(([x, y]) => ({ x: x * this.w, y: y * this.h })), blobs = [];
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], c = pts[i], L = dist(a.x, a.y, c.x, c.y), n = Math.ceil(L / 50), ang = Math.atan2(c.y - a.y, c.x - a.x);
          for (let k = 0; k <= n; k++) blobs.push([lerp(a.x, c.x, k / n) + R.float(-6, 6), lerp(a.y, c.y, k / n) + R.float(-6, 6), 46, f.w / 2 * R.float(0.85, 1.1), ang + R.float(-0.1, 0.1)]);
        }
        const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length, cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
        let reach = 0;
        for (const [bx, by, rx, ry] of blobs) reach = Math.max(reach, dist(cx, cy, bx, by) + Math.max(rx, ry));
        p = { x: cx, y: cy, r: f.w, reach, blobs, river: true };
      }
      if (!p) continue;
      this.pools.push(p);
      if (teams && !f.c) this.pools.push(this.mirrorPool(p));
    }
    if (this.biome.id !== 'marsh' || (this.recipe && this.recipe.noPools)) return;
    const want = Math.round(this.w * this.h / 320000);
    for (let tries = 0, n = 0; n < want && tries < want * 40; tries++) {
      const x = R.float(120, teams ? this.w / 2 : this.w - 120), y = R.float(120, this.h - 120);
      const p = this.makePool(x, y, R.float(55, 120), R);
      if (!this.poolFits(p)) continue;
      this.pools.push(p);
      n++;
      if (teams) { const m = this.mirrorPool(p); if (this.poolFits(m)) { this.pools.push(m); n++; } }
    }
  }

  // Raw test (ignores bridges): is this point inside a pool?
  inPool(x, y) {
    for (const p of this.pools) {
      if (Math.abs(p.x - x) > p.reach || Math.abs(p.y - y) > p.reach) continue;
      for (const [bx, by, rx, ry, a] of p.blobs) {
        const c = Math.cos(a), s = Math.sin(a), dx = x - bx, dy = y - by;
        const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
        if (u * u + v * v <= 1) return true;
      }
    }
    return false;
  }

  buildWaterMask() {
    this.waterMask = new Uint8Array(this.cols * this.rows);
    if (!this.pools.length) return;
    for (let i = 0; i < this.waterMask.length; i++) {
      const p = this.cellCenter(i);
      if (!this.roadMask[i] && this.inPool(p.x, p.y)) this.waterMask[i] = 1;
    }
  }

  // Wading depth: in water and not on a bridge.
  onWater(x, y) {
    if (!this.pools.length || x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.waterMask[this.cellOf(x, y)] === 1 && this.inPool(x, y);
  }

  // ---- geometry helpers ------------------------------------------------------
  static rectDist(o, x, y) {
    const dx = Math.max(o.x - x, 0, x - (o.x + o.w));
    const dy = Math.max(o.y - y, 0, y - (o.y + o.h));
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Distance from point to obstacle surface (negative when inside a circle).
  obstacleDist(o, x, y) {
    if (o.shape === 'rect') return GameMap.rectDist(o, x, y);
    return dist(o.cx, o.cy, x, y) - o.r;
  }

  // Gap between two obstacle shapes (approximate for rect-rect).
  static gapBetween(a, b) {
    if (a.shape === 'rect' && b.shape === 'rect') {
      const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
      const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
      return Math.sqrt(dx * dx + dy * dy);
    }
    if (a.shape === 'circle' && b.shape === 'circle') return dist(a.cx, a.cy, b.cx, b.cy) - a.r - b.r;
    const r = a.shape === 'rect' ? a : b, c = a.shape === 'rect' ? b : a;
    return GameMap.rectDist(r, c.cx, c.cy) - c.r;
  }

  // Uniform grid over the obstacles so collision and ray queries only look nearby.
  // Built on first use and rebuilt if the obstacle list changes.
  grid() {
    const obs = this.obstacles;
    if (this._gridList === obs && this._gridN === obs.length) return this._grid;
    const gc = Math.max(1, Math.ceil(this.w / OGRID)), gr = Math.max(1, Math.ceil(this.h / OGRID));
    const cells = new Array(gc * gr);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    for (const o of obs) {
      const c0 = clamp(Math.floor(o.bx0 / OGRID), 0, gc - 1), c1 = clamp(Math.floor(o.bx1 / OGRID), 0, gc - 1);
      const r0 = clamp(Math.floor(o.by0 / OGRID), 0, gr - 1), r1 = clamp(Math.floor(o.by1 / OGRID), 0, gr - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * gc + c].push(o);
    }
    this._grid = { gc, gr, cells, seen: new Uint32Array(gc * gr) };
    this._gridList = obs;
    this._gridN = obs.length;
    this._qid = this._qid || 0;
    this._near = this._near || [];
    return this._grid;
  }

  // Obstacles in the grid cells overlapping a box (each once). Returns a shared array.
  nearby(x0, y0, x1, y1) {
    const G = this.grid(), out = this._near, q = ++this._qid;
    out.length = 0;
    const c0 = Math.max(0, Math.floor(x0 / OGRID)), c1 = Math.min(G.gc - 1, Math.floor(x1 / OGRID));
    const r0 = Math.max(0, Math.floor(y0 / OGRID)), r1 = Math.min(G.gr - 1, Math.floor(y1 / OGRID));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = G.cells[r * G.gc + c];
        for (let i = 0; i < cell.length; i++) { const o = cell[i]; if (o._q !== q) { o._q = q; out.push(o); } }
      }
    }
    return out;
  }

  // Obstacles near a segment: short or padded segments use their box, long ones walk the grid.
  nearLine(x1, y1, x2, y2, pad) {
    const dx = x2 - x1, dy = y2 - y1;
    if (pad > 64 || (Math.abs(dx) < OGRID * 2.5 && Math.abs(dy) < OGRID * 2.5)) {
      return this.nearby(Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.max(x1, x2) + pad, Math.max(y1, y2) + pad);
    }
    const G = this.grid(), out = this._near, q = ++this._qid;
    out.length = 0;
    // Samples at most half a cell apart; the 3x3 block around each covers the padded line.
    const n = Math.ceil(Math.hypot(dx, dy) / (OGRID / 2));
    let lc = -9, lr = -9;
    for (let i = 0; i <= n; i++) {
      const c = Math.floor((x1 + dx * i / n) / OGRID), r = Math.floor((y1 + dy * i / n) / OGRID);
      if (c === lc && r === lr) continue;
      lc = c; lr = r;
      for (let rr = Math.max(0, r - 1); rr <= Math.min(G.gr - 1, r + 1); rr++) {
        for (let cc = Math.max(0, c - 1); cc <= Math.min(G.gc - 1, c + 1); cc++) {
          const ci = rr * G.gc + cc;
          if (G.seen[ci] === q) continue;
          G.seen[ci] = q;
          const cell = G.cells[ci];
          for (let k = 0; k < cell.length; k++) { const o = cell[k]; if (o._q !== q) { o._q = q; out.push(o); } }
        }
      }
    }
    return out;
  }

  pointBlocked(x, y, pad = 0) {
    if (x < pad || y < pad || x > this.w - pad || y > this.h - pad) return true;
    for (const o of this.nearby(x - pad, y - pad, x + pad, y + pad)) {
      if (x < o.bx0 - pad || x > o.bx1 + pad || y < o.by0 - pad || y > o.by1 + pad) continue;
      if (this.obstacleDist(o, x, y) < pad) return true;
    }
    return false;
  }

  // Returns the obstacle a small projectile at (x,y) is touching, or null.
  projectileHit(x, y, r) {
    for (const o of this.nearby(x - r, y - r, x + r, y + r)) {
      if (x < o.bx0 - r || x > o.bx1 + r || y < o.by0 - r || y > o.by1 + r) continue;
      if (this.obstacleDist(o, x, y) < r) return o;
    }
    return null;
  }

  // Pushes a circle out of obstacles and map edges. Returns true on contact.
  resolveCircle(ent, r) {
    let hit = false;
    const near = this.nearby(ent.x - r - 8, ent.y - r - 8, ent.x + r + 8, ent.y + r + 8);
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (ent.x < o.bx0 - r || ent.x > o.bx1 + r || ent.y < o.by0 - r || ent.y > o.by1 + r) continue;
      if (o.shape === 'rect') {
        const px = clamp(ent.x, o.x, o.x + o.w), py = clamp(ent.y, o.y, o.y + o.h);
        let dx = ent.x - px, dy = ent.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0) {
          // Center inside the rectangle: push out along the shallowest axis.
          const l = ent.x - o.x, rr = o.x + o.w - ent.x, t = ent.y - o.y, b = o.y + o.h - ent.y;
          const m = Math.min(l, rr, t, b);
          if (m === l) ent.x = o.x - r; else if (m === rr) ent.x = o.x + o.w + r;
          else if (m === t) ent.y = o.y - r; else ent.y = o.y + o.h + r;
          hit = true;
        } else if (d2 < r * r) {
          const d = Math.sqrt(d2);
          ent.x = px + (dx / d) * r;
          ent.y = py + (dy / d) * r;
          hit = true;
        }
      } else {
        const dx = ent.x - o.cx, dy = ent.y - o.cy;
        const d2 = dx * dx + dy * dy, min = o.r + r;
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 0.001;
          ent.x = o.cx + (dx / d) * min;
          ent.y = o.cy + (dy / d) * min;
          hit = true;
        }
      }
    }
    if (ent.x < r) { ent.x = r; hit = true; }
    if (ent.y < r) { ent.y = r; hit = true; }
    if (ent.x > this.w - r) { ent.x = this.w - r; hit = true; }
    if (ent.y > this.h - r) { ent.y = this.h - r; hit = true; }
    return hit;
  }

  // First hit fraction t in [0,1] along the segment, or -1 when clear.
  raycast(x1, y1, x2, y2, pad = 0) {
    const dx = x2 - x1, dy = y2 - y1;
    const minX = Math.min(x1, x2) - pad, maxX = Math.max(x1, x2) + pad;
    const minY = Math.min(y1, y2) - pad, maxY = Math.max(y1, y2) + pad;
    let best = -1;
    const near = this.nearLine(x1, y1, x2, y2, pad);
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.bx1 < minX || o.bx0 > maxX || o.by1 < minY || o.by0 > maxY) continue;
      let t = -1;
      if (o.shape === 'rect') {
        let t0 = 0, t1 = 1;
        const ax = o.x - pad, bx = o.x + o.w + pad, ay = o.y - pad, by = o.y + o.h + pad;
        if (Math.abs(dx) < 1e-9) { if (x1 < ax || x1 > bx) continue; }
        else {
          let ta = (ax - x1) / dx, tb = (bx - x1) / dx;
          if (ta > tb) { const s = ta; ta = tb; tb = s; }
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
          if (t0 > t1) continue;
        }
        if (Math.abs(dy) < 1e-9) { if (y1 < ay || y1 > by) continue; }
        else {
          let ta = (ay - y1) / dy, tb = (by - y1) / dy;
          if (ta > tb) { const s = ta; ta = tb; tb = s; }
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
          if (t0 > t1) continue;
        }
        t = t0;
      } else {
        const r = o.r + pad;
        const fx = x1 - o.cx, fy = y1 - o.cy;
        const a = dx * dx + dy * dy;
        const b = 2 * (fx * dx + fy * dy);
        const c = fx * fx + fy * fy - r * r;
        if (c < 0) t = 0;
        else {
          const disc = b * b - 4 * a * c;
          if (disc < 0 || a === 0) continue;
          const s = Math.sqrt(disc);
          const ta = (-b - s) / (2 * a);
          if (ta < 0 || ta > 1) continue;
          t = ta;
        }
      }
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  lineOfSight(x1, y1, x2, y2, pad = 0) { return this.raycast(x1, y1, x2, y2, pad) < 0; }

  // ---- generation --------------------------------------------------------------
  addObstacle(o) {
    if (o.shape === 'rect') {
      o.cx = o.x + o.w / 2; o.cy = o.y + o.h / 2;
      o.bx0 = o.x; o.by0 = o.y; o.bx1 = o.x + o.w; o.by1 = o.y + o.h;
    } else {
      o.bx0 = o.cx - o.r; o.by0 = o.cy - o.r; o.bx1 = o.cx + o.r; o.by1 = o.cy + o.r;
    }
    o.id = this.obstacles.length;
    this.obstacles.push(o);
    return o;
  }

  fits(o, keepOut) {
    const edge = 70;
    if (o.shape === 'rect') {
      if (o.x < edge || o.y < edge || o.x + o.w > this.w - edge || o.y + o.h > this.h - edge) return false;
    } else if (o.cx - o.r < edge || o.cy - o.r < edge || o.cx + o.r > this.w - edge || o.cy + o.r > this.h - edge) return false;
    for (const k of keepOut) {
      const d = o.shape === 'rect' ? GameMap.rectDist(o, k.x, k.y) : dist(o.cx, o.cy, k.x, k.y) - o.r;
      if (d < k.r) return false;
    }
    for (const e of this.obstacles) {
      const gap = GameMap.gapBetween(o, e);
      const need = o.cluster && o.cluster === e.cluster ? -1e9 : OBSTACLE_GAP;
      if (gap < need) return false;
    }
    return true;
  }

  mirror(o) {
    const m = Object.assign({}, o);
    if (o.shape === 'rect') { m.x = this.w - o.x - o.w; m.y = this.h - o.y - o.h; }
    else { m.cx = this.w - o.cx; m.cy = this.h - o.cy; }
    m.seed = o.seed + 7919;
    m.mirrored = true;
    m.flip = !o.flip;
    return m;
  }

  // ---- campaign set pieces -------------------------------------------------------------
  // Each feature becomes groups of obstacles; a group is placed (and mirrored) whole.
  featureGroups(f) {
    const R = this.rng, X = f.x * this.w, Y = f.y * this.h, b = this.biome;
    const seed = () => R.int(1, 1e9);
    const rect = (kind, cx, cy, w, h, height, extra) => Object.assign({ kind, shape: 'rect', x: cx - w / 2, y: cy - h / 2, w, h, height, seed: seed() }, extra);
    const out = [];
    switch (f.t) {
      case 'hedge': out.push([rect('hedge', X, Y, f.v ? 24 : f.len, f.v ? f.len : 24, 12)]); break;
      case 'line': {
        const th = { sandbags: 26, barrier: 22, pipe: 20 }[f.k] || 24, hgt = { sandbags: 11, barrier: 14, pipe: 16 }[f.k] || 12;
        out.push([rect(f.k, X, Y, f.v ? th : f.len, f.v ? f.len : th, hgt)]);
        break;
      }
      case 'bld': {
        const hgt = { barn: 44, temple: 62, house: 30, bunker: 20, building: 46 }[f.k] || 40;
        const color = f.k === 'barn' ? '#9c3a2b' : f.k === 'temple' ? (f.color || '#7c2c25') : R.pick(b.roof);
        out.push([rect(f.k, X, Y, f.w, f.h, hgt, { color, flip: !!f.flip })]);
        break;
      }
      case 'grove':
        for (let i = 0; i < (f.n || 3); i++) {
          const a = R.float(0, TAU), d = Math.sqrt(R.next()) * (f.r || 80);
          out.push(this.makeKind('tree', X + Math.cos(a) * d, Y + Math.sin(a) * d));
        }
        break;
      case 'orchard':
        for (let cx = 0; cx < f.cols; cx++) for (let cy = 0; cy < f.rows; cy++) {
          const tx = X + (cx - (f.cols - 1) / 2) * f.gap, ty = Y + (cy - (f.rows - 1) / 2) * f.gap, r = R.int(13, 15);
          out.push([{ kind: 'tree', shape: 'circle', cx: tx + R.float(-6, 6), cy: ty + R.float(-6, 6), r, canopy: r * R.float(2.3, 2.6), height: 0, seed: seed(), cluster: this._clusterId++ }]);
        }
        break;
      case 'rocks':
        for (let i = 0; i < (f.n || 3); i++) {
          const a = R.float(0, TAU), d = Math.sqrt(R.next()) * (f.r || 80);
          out.push(this.makeKind('rock', X + Math.cos(a) * d, Y + Math.sin(a) * d));
        }
        break;
      case 'ridge': {
        // A chain of big boulders; 'gaps' (0..1 along the ridge) leave passes.
        const x1 = f.x1 * this.w, y1 = f.y1 * this.h, x2 = f.x2 * this.w, y2 = f.y2 * this.h;
        const L = dist(x1, y1, x2, y2), n = Math.max(1, Math.round(L / (f.step || 70)));
        const cl = this._clusterId++;   // one cluster: the boulders may touch and form a wall
        for (let i = 0; i <= n; i++) {
          const k = i / n;
          if ((f.gaps || []).some(gp => Math.abs(gp - k) < (f.gapW || 0.08))) continue;
          const r = R.int(f.rmin || 30, f.rmax || 42);
          out.push([{ kind: 'rock', shape: 'circle', cx: lerp(x1, x2, k) + R.float(-8, 8), cy: lerp(y1, y2, k) + R.float(-8, 8), r, height: 18, seed: seed(), cluster: cl }]);
        }
        break;
      }
      case 'wreck': out.push([{ kind: 'wreck', shape: 'circle', cx: X, cy: Y, r: 24, height: 12, seed: seed() }]); break;
      case 'village':
        for (let i = 0; i < (f.n || 4); i++) {
          const a = R.float(0, TAU), d = Math.sqrt(R.next()) * (f.r || 160);
          out.push(this.makeKind('house', X + Math.cos(a) * d - 50, Y + Math.sin(a) * d - 35));
        }
        break;
    }
    return out;
  }

  placeRecipe(keepOut) {
    const rc = this.recipe, teams = this.layout === 'teams';
    for (const f of rc.features || []) {
      if (!['hedge', 'line', 'bld', 'grove', 'orchard', 'rocks', 'ridge', 'wreck', 'village'].includes(f.t)) continue;
      for (const group of this.featureGroups(f)) {
        if (group.some(o => !this.fits(o, keepOut))) continue;
        for (const o of group) this.addObstacle(o);
        if (!teams || f.c) continue;
        const mirrored = group.map(o => this.mirror(o));
        if (group[0].cluster) mirrored.forEach(m => (m.cluster = group[0].cluster + 20000));
        if (mirrored.every(m => this.fits(m, keepOut))) for (const m of mirrored) this.addObstacle(m);
        else this.obstacles.length -= group.length;
      }
    }
    // Painted-only pieces.
    for (const f of rc.features || []) {
      if (f.t !== 'field' && f.t !== 'ice' && f.t !== 'scorch') continue;
      const d = { type: f.t, x: f.x * this.w, y: f.y * this.h, w: f.w || 0, h: f.h || 0, r: f.r || 0, a: f.a || 0 };
      this.decals.push(d);
      if (teams && !f.c) this.decals.push(Object.assign({}, d, { x: this.w - d.x, y: this.h - d.y }));
    }
  }

  // Keep-out circles from the recipe ('clear' areas stay open ground).
  recipeKeepOut(keepOut) {
    for (const f of (this.recipe && this.recipe.features) || []) {
      if (f.t !== 'clear') continue;
      keepOut.push({ x: f.x * this.w, y: f.y * this.h, r: f.r });
      if (this.layout === 'teams' && !f.c) keepOut.push({ x: this.w - f.x * this.w, y: this.h - f.y * this.h, r: f.r });
    }
  }

  // Custom roads: normalised polylines, mirrored on team maps unless c: true.
  recipeRoads() {
    const rc = this.recipe, teams = this.layout === 'teams';
    for (const f of rc.features || []) {
      if (f.t !== 'road') continue;
      const pts = f.pts.map(([x, y]) => ({ x: x * this.w, y: y * this.h }));
      this.roads.push(pts);
      if (teams && !f.c) this.roads.push(pts.map(p => ({ x: this.w - p.x, y: this.h - p.y })).reverse());
      if (f.convoy) this.convoyRoute = pts;
    }
  }

  // Builds one obstacle (or a small cluster) of the given kind at (x, y).
  makeKind(kind, x, y) {
    const R = this.rng, b = this.biome;
    const seed = R.int(1, 1e9);
    switch (kind) {
      case 'building': {
        const w = R.int(6, 11) * 20, h = R.int(5, 9) * 20;
        return [{ kind, shape: 'rect', x, y, w, h, height: R.int(34, 56), seed, color: R.pick(b.roof) }];
      }
      case 'container': {
        const long = R.int(115, 135), short = 42, vert = R.chance(0.5);
        return [{ kind, shape: 'rect', x, y, w: vert ? short : long, h: vert ? long : short, height: 24, seed, color: R.pick(CONTAINER_COLORS) }];
      }
      case 'sandbags': {
        const long = R.int(5, 9) * 20, vert = R.chance(0.5);
        return [{ kind, shape: 'rect', x, y, w: vert ? 26 : long, h: vert ? long : 26, height: 11, seed }];
      }
      case 'barrier': {
        const long = R.int(4, 8) * 24, vert = R.chance(0.5);
        return [{ kind, shape: 'rect', x, y, w: vert ? 22 : long, h: vert ? long : 22, height: 14, seed }];
      }
      case 'crates': {
        const s = R.pick([40, 48, 56]);
        return [{ kind, shape: 'rect', x, y, w: s, h: s, height: 20, seed }];
      }
      case 'rock': {
        const cl = this._clusterId++, n = R.int(1, 3), out = [];
        for (let i = 0; i < n; i++) {
          const r = R.int(20, 40);
          out.push({ kind, shape: 'circle', cx: x + R.float(-40, 40) * (i > 0), cy: y + R.float(-40, 40) * (i > 0), r, height: 14, seed: seed + i, cluster: cl });
        }
        return out;
      }
      case 'house': {
        const w = R.int(4, 6) * 20, h = R.int(3, 4) * 20, vert = R.chance(0.5);
        return [{ kind, shape: 'rect', x, y, w: vert ? h : w, h: vert ? w : h, height: 30, seed, color: R.pick(b.roof) }];
      }
      case 'hedge': {
        const long = R.int(6, 12) * 20, vert = R.chance(0.5);
        return [{ kind, shape: 'rect', x, y, w: vert ? 24 : long, h: vert ? long : 24, height: 12, seed }];
      }
      case 'wreck':
        return [{ kind, shape: 'circle', cx: x, cy: y, r: 24, height: 12, seed }];
      case 'tree': {
        const cl = this._clusterId++, n = R.int(2, 5), out = [];
        for (let i = 0; i < n; i++) {
          const r = R.int(13, 17);
          const a = R.float(0, TAU), d = i === 0 ? 0 : R.float(46, 70);
          const canopy = r * (b.treeType === 'cactus' ? R.float(1.5, 1.8) : R.float(2.4, 2.9));
          out.push({ kind, shape: 'circle', cx: x + Math.cos(a) * d, cy: y + Math.sin(a) * d, r, canopy, height: 0, seed: seed + i, cluster: cl });
        }
        return out;
      }
    }
    return [];
  }

  kindWeights() {
    if (this.recipe && this.recipe.kinds) return Object.entries(this.recipe.kinds);
    const t = this.biome.treeType;
    return [
      ['building', 0.16], ['container', 0.18], ['sandbags', 0.16], ['barrier', 0.1],
      ['crates', 0.1], ['rock', t === 'palm' ? 0.2 : t === 'cactus' ? 0.26 : 0.12],
      ['tree', t === 'pine' ? 0.22 : t === 'palm' ? 0.08 : t === 'cactus' ? 0.1 : t === 'blossom' || t === 'autumn' ? 0.22 : t === 'willow' ? 0.15 : 0.18],
    ];
  }

  pickKind() {
    const ws = this.kindWeights();
    let total = 0; for (const [, w] of ws) total += w;
    let r = this.rng.float(0, total);
    for (const [k, w] of ws) { if ((r -= w) <= 0) return k; }
    return 'rock';
  }

  area(o) { return o.shape === 'rect' ? o.w * o.h : Math.PI * (o.canopy ? o.r * 1.6 : o.r) ** 2; }

  generateTeams() {
    const { w, h } = this, R = this.rng;
    const keepOut = [
      { x: this.bases[0].x, y: this.bases[0].y, r: this.mode === 'ctf' ? 260 : 330 },
      { x: this.bases[1].x, y: this.bases[1].y, r: this.mode === 'ctf' ? 260 : 330 },
    ];
    for (const cs of this.spawnCenters) for (const c of cs) keepOut.push({ x: c.x, y: c.y, r: 230 });
    if (this.hill) keepOut.push({ x: this.hill.x, y: this.hill.y, r: this.hill.r + 30 });
    const rc = this.recipe;
    if (rc) { this.recipeKeepOut(keepOut); this.placeRecipe(keepOut); }

    // Center piece: symmetric by itself under 180° rotation.
    if (rc && rc.noCenter) {
      // The recipe decides the middle of the map.
    } else if (this.hill) {
      const hr = this.hill.r;
      const sb = { kind: 'sandbags', shape: 'rect', x: w / 2 - hr * 0.55 - 13, y: h / 2 - 60, w: 26, h: 120, height: 11, seed: R.int(1, 1e9) };
      this.addObstacle(sb);
      this.addObstacle(this.mirror(sb));
    } else if (R.chance(0.7) && w > 2000) {
      const bw = R.int(7, 10) * 20, bh = R.int(5, 7) * 20;
      this.addObstacle({ kind: 'building', shape: 'rect', x: w / 2 - bw / 2, y: h / 2 - bh / 2, w: bw, h: bh, height: 52, seed: R.int(1, 1e9), color: R.pick(this.biome.roof) });
    }

    let covered = 0;
    for (const o of this.obstacles) covered += this.area(o);
    const target = w * h * (rc && rc.density !== undefined ? rc.density : 0.11);
    for (let tries = 0; tries < 5000 && covered < target; tries++) {
      const kind = this.pickKind();
      const x = R.float(80, w / 2 + 60), y = R.float(80, h - 80);
      const group = this.makeKind(kind, x, y);
      const mirrored = group.map(o => this.mirror(o));
      if (mirrored.length && group[0].cluster) mirrored.forEach(m => (m.cluster = group[0].cluster + 10000));
      let ok = true;
      for (const o of group) if (!this.fits(o, keepOut)) { ok = false; break; }
      if (!ok) continue;
      // The mirrored half must not collide with the original group either.
      for (const o of group) this.addObstacle(o);
      for (const m of mirrored) if (!this.fits(m, keepOut)) { ok = false; break; }
      if (!ok) { this.obstacles.length -= group.length; continue; }
      for (const m of mirrored) this.addObstacle(m);
      for (const o of group) covered += this.area(o) * 2;
    }

    if (rc && rc.roads === 'custom') { this.recipeRoads(); return; }
    // Three lane roads: top and bottom mirror each other, the middle mirrors itself.
    const x0 = this.spawnCenters[0][0].x - 60, jit = () => R.float(-h * 0.06, h * 0.06);
    const yT = h * 0.2;
    const top = [{ x: x0, y: yT }, { x: w * 0.3, y: yT + jit() }, { x: w * 0.5, y: yT + jit() }, { x: w * 0.7, y: yT + jit() }, { x: w - x0, y: yT }];
    this.roads.push(top, top.map(p => ({ x: w - p.x, y: h - p.y })));
    const my = R.float(-h * 0.08, h * 0.08);
    this.roads.push([{ x: x0, y: h / 2 }, { x: w * 0.3, y: h / 2 + my }, { x: w / 2, y: h / 2 }, { x: w * 0.7, y: h / 2 - my }, { x: w - x0, y: h / 2 }]);
    if (R.chance(0.7)) {
      const ox = R.float(-w * 0.1, w * 0.1);
      this.roads.push([{ x: w / 2 + ox, y: -40 }, { x: w / 2, y: h / 2 }, { x: w / 2 - ox, y: h + 40 }]);
    }
    if (rc) this.recipeRoads();
  }

  generateFFA() {
    const { w, h } = this, R = this.rng, rc = this.recipe;
    const keepOut = [];
    if (rc) { this.recipeKeepOut(keepOut); this.placeRecipe(keepOut); }
    let covered = 0;
    for (const o of this.obstacles) covered += this.area(o);
    const target = w * h * (rc && rc.density !== undefined ? rc.density : 0.1);
    for (let tries = 0; tries < 6000 && covered < target; tries++) {
      const kind = this.pickKind();
      const group = this.makeKind(kind, R.float(80, w - 80), R.float(80, h - 80));
      let ok = true;
      for (const o of group) if (!this.fits(o, keepOut)) { ok = false; break; }
      if (!ok) continue;
      for (const o of group) { this.addObstacle(o); covered += this.area(o); }
    }
    if (rc && rc.roads === 'custom') { this.recipeRoads(); return; }
    for (let i = 0; i < 3; i++) {
      const a = R.float(0, Math.PI);
      const cx = w / 2 + R.float(-w * 0.25, w * 0.25), cy = h / 2 + R.float(-h * 0.25, h * 0.25);
      const L = Math.max(w, h);
      this.roads.push([
        { x: cx - Math.cos(a) * L, y: cy - Math.sin(a) * L },
        { x: cx + R.float(-120, 120), y: cy + R.float(-120, 120) },
        { x: cx + Math.cos(a) * L, y: cy + Math.sin(a) * L },
      ]);
    }
    if (rc) this.recipeRoads();
  }

  // ---- navigation -----------------------------------------------------------------
  buildNav() {
    this.cols = Math.ceil(this.w / NAV_CELL);
    this.rows = Math.ceil(this.h / NAV_CELL);
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = (c + 0.5) * NAV_CELL, y = (r + 0.5) * NAV_CELL;
        this.blocked[r * this.cols + c] = this.pointBlocked(x, y, NAV_CLEAR) ? 1 : 0;
      }
    }
    this.buildRoadMask();
    this._g = new Float32Array(n);
    this._came = new Int32Array(n);
    this._stamp = new Uint32Array(n);
    this._closed = new Uint32Array(n);
    this._gen = 0;
    this._hf = new Float64Array(Math.max(1024, n * 2));
    this._hi = new Int32Array(Math.max(1024, n * 2));
  }

  // Cells on a road (roads are drawn as quadratic curves through midpoints).
  buildRoadMask() {
    const mask = new Uint8Array(this.cols * this.rows), half = 32;
    const mark = (x, y) => {
      const c0 = Math.floor((x - half) / NAV_CELL), c1 = Math.floor((x + half) / NAV_CELL);
      const r0 = Math.floor((y - half) / NAV_CELL), r1 = Math.floor((y + half) / NAV_CELL);
      for (let r = Math.max(0, r0); r <= Math.min(this.rows - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(this.cols - 1, c1); c++) {
          const cx = (c + 0.5) * NAV_CELL, cy = (r + 0.5) * NAV_CELL;
          if (dist2(cx, cy, x, y) < half * half) mask[r * this.cols + c] = 1;
        }
      }
    };
    for (const pts of this.roads) {
      let from = pts[0];
      const seg = (a, ctrl, b) => {
        const len = dist(a.x, a.y, ctrl.x, ctrl.y) + dist(ctrl.x, ctrl.y, b.x, b.y);
        const n = Math.max(2, Math.ceil(len / 14));
        for (let i = 0; i <= n; i++) {
          const t = i / n, u = 1 - t;
          mark(u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x, u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y);
        }
      };
      for (let i = 1; i < pts.length - 1; i++) {
        const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
        seg(from, pts[i], mid);
        from = mid;
      }
      const last = pts[pts.length - 1];
      seg(from, { x: (from.x + last.x) / 2, y: (from.y + last.y) / 2 }, last);
    }
    this.roadMask = mask;
  }

  onRoad(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.roadMask[this.cellOf(x, y)] === 1;
  }

  cellOf(x, y) {
    const c = clamp(Math.floor(x / NAV_CELL), 0, this.cols - 1);
    const r = clamp(Math.floor(y / NAV_CELL), 0, this.rows - 1);
    return r * this.cols + c;
  }
  cellCenter(i) {
    return { x: ((i % this.cols) + 0.5) * NAV_CELL, y: (Math.floor(i / this.cols) + 0.5) * NAV_CELL };
  }
  walkable(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return !this.blocked[this.cellOf(x, y)];
  }

  nearestFreeCell(x, y, maxR = 14) {
    const c0 = clamp(Math.floor(x / NAV_CELL), 0, this.cols - 1);
    const r0 = clamp(Math.floor(y / NAV_CELL), 0, this.rows - 1);
    if (!this.blocked[r0 * this.cols + c0]) return r0 * this.cols + c0;
    for (let rad = 1; rad <= maxR; rad++) {
      let best = -1, bd = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const r = r0 + dr, c = c0 + dc;
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const i = r * this.cols + c;
          if (this.blocked[i]) continue;
          const p = this.cellCenter(i), d = dist2(p.x, p.y, x, y);
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  // Grid walk used for path smoothing. dry: also refuse to cross water.
  clearPath(x1, y1, x2, y2, dry = false) {
    const d = dist(x1, y1, x2, y2);
    const steps = Math.ceil(d / (NAV_CELL * 0.4));
    const wm = dry && this.pools.length ? this.waterMask : null;
    const cols = this.cols, blocked = this.blocked, w = this.w, h = this.h, inv = 1 / NAV_CELL;
    for (let i = 1; i < steps; i++) {
      const t = i / steps, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      const c = (y * inv | 0) * cols + (x * inv | 0);
      if (blocked[c] || (wm && wm[c])) return false;
    }
    return true;
  }

  // A* over the nav grid. Returns an array of smoothed waypoints or null.
  // dry: water cells cost extra, so wheeled and tracked tanks go around ponds.
  findPath(sx, sy, tx, ty, maxIter = 30000, dry = false) {
    const start = this.nearestFreeCell(sx, sy), goal = this.nearestFreeCell(tx, ty);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [{ x: tx, y: ty }];
    const cols = this.cols, rows = this.rows, blocked = this.blocked;
    const wet = dry && this.pools.length ? this.waterMask : null;
    const g = this._g, came = this._came, stamp = this._stamp, closed = this._closed;
    const gen = ++this._gen;
    const gx = goal % cols, gy = (goal / cols) | 0;
    const h = i => {
      const dx = Math.abs((i % cols) - gx), dy = Math.abs(((i / cols) | 0) - gy);
      return (dx + dy) + (1.4142 - 2) * (dx < dy ? dx : dy);
    };
    // Binary min-heap of (f, cell) in preallocated typed arrays.
    let hf = this._hf, hi = this._hi, size = 0;
    const push = (f, i) => {
      if (size >= hf.length) {
        const nf = new Float64Array(hf.length * 2), ni = new Int32Array(hi.length * 2);
        nf.set(hf); ni.set(hi); hf = this._hf = nf; hi = this._hi = ni;
      }
      let k = size++;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (hf[p] <= f) break;
        hf[k] = hf[p]; hi[k] = hi[p];
        k = p;
      }
      hf[k] = f; hi[k] = i;
    };
    const pop = () => {
      const top = hi[0];
      size--;
      if (size > 0) {
        const lf = hf[size], li = hi[size];
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = -1, mf = lf;
          if (l < size && hf[l] < mf) { m = l; mf = hf[l]; }
          if (r < size && hf[r] < mf) { m = r; mf = hf[r]; }
          if (m < 0) break;
          hf[k] = hf[m]; hi[k] = hi[m];
          k = m;
        }
        hf[k] = lf; hi[k] = li;
      }
      return top;
    };
    stamp[start] = gen; g[start] = 0; came[start] = -1;
    push(h(start), start);
    let found = false, iter = 0;
    const DX = NAV_DX, DY = NAV_DY, DC = NAV_DC;
    while (size > 0 && iter++ < maxIter) {
      const cur = pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) { found = true; break; }
      const cx = cur % cols, cy = (cur / cols) | 0, gc = g[cur];
      for (let d = 0; d < 8; d++) {
        const dx = DX[d], dy = DY[d], nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (blocked[ni] || closed[ni] === gen) continue;
        if (dx && dy && (blocked[cy * cols + nx] || blocked[ny * cols + cx])) continue;
        const ng = gc + (wet && wet[ni] ? DC[d] * 3.5 : DC[d]);
        if (stamp[ni] !== gen || ng < g[ni]) {
          stamp[ni] = gen; g[ni] = ng; came[ni] = cur;
          push(ng + h(ni), ni);
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let c = goal; c !== -1; c = came[c]) cells.push(c);
    cells.reverse();
    const pts = cells.map(c => this.cellCenter(c));
    if (this.walkable(tx, ty)) pts[pts.length - 1] = { x: tx, y: ty };
    // String-pull: keep only the waypoints needed to stay on free cells.
    const out = [];
    let anchor = { x: sx, y: sy }, i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      while (j + 1 < pts.length && this.clearPath(anchor.x, anchor.y, pts[j + 1].x, pts[j + 1].y, !!wet)) j++;
      out.push(pts[j]);
      anchor = pts[j];
      i = j;
    }
    if (!out.length) out.push(pts[pts.length - 1]);
    return out;
  }

  randomWalkable(rng, cx, cy, r, minR = 0) {
    for (let i = 0; i < 60; i++) {
      const a = rng.float(0, TAU), d = rng.float(minR, r);
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      if (this.walkable(x, y)) return { x, y };
    }
    const c = this.nearestFreeCell(cx, cy, 40);
    return c >= 0 ? this.cellCenter(c) : { x: cx, y: cy };
  }

  // ---- spawns -------------------------------------------------------------------------
  makeSpawns(count) {
    if (this.layout === 'teams') {
      for (let t = 0; t < 2; t++) {
        const angle = t === 0 ? 0 : Math.PI;
        const groups = this.spawnCenters[t].map((c, zone) => {
          const pts = [];
          for (let gx = -1; gx <= 2; gx++) {
            for (let gy = -2; gy <= 2; gy++) {
              const x = c.x + (t === 0 ? 1 : -1) * gx * 64, y = c.y + gy * 64;
              if (this.walkable(x, y)) pts.push({ x, y, angle, zone });
            }
          }
          return pts.sort((a, b) => dist2(a.x, a.y, c.x, c.y) - dist2(b.x, b.y, c.x, c.y));
        });
        // Interleave clusters so consecutive spawns alternate bunkers.
        const out = [];
        for (let i = 0; out.length < groups.reduce((n, g) => n + g.length, 0); i++) {
          for (const gr of groups) if (gr[i]) out.push(gr[i]);
        }
        this.spawns.push(out);
        (this.spawnZones = this.spawnZones || [])[t] = groups;
      }
    } else {
      const pts = [];
      const cand = [];
      for (let i = 0; i < 1500; i++) {
        const x = this.rng.float(150, this.w - 150), y = this.rng.float(150, this.h - 150);
        if (this.walkable(x, y) && !this.pointBlocked(x, y, 60)) cand.push({ x, y });
      }
      // Greedy farthest-point sampling for an even spread.
      if (cand.length) pts.push(cand[0]);
      while (pts.length < count && cand.length) {
        let best = null, bd = -1;
        for (const c of cand) {
          let md = Infinity;
          for (const p of pts) md = Math.min(md, dist2(c.x, c.y, p.x, p.y));
          if (md > bd) { bd = md; best = c; }
        }
        pts.push(best);
      }
      for (const p of pts) p.angle = Math.atan2(this.h / 2 - p.y, this.w / 2 - p.x);
      this.spawns.push(pts);
    }
  }
}
