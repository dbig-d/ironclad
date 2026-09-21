'use strict';
// ---------------------------------------------------------------------------
// Campaign world map: one long painted strip where every region's biome
// blends into the next, a road threading through all the mission nodes, and
// a little tank that drives on to each newly unlocked mission. Also the
// hangar's turntable preview.
// ---------------------------------------------------------------------------

const WM = { RW: 880, H: 600, SCALE: LOW_MEM ? 1 : 1.5, BLEND: 150, NODE_R: 17 };

class WorldMap {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ui = ui;
    this.regions = CAMPAIGN.regions;
    this.W = this.regions.length * WM.RW;
    this.camX = 0;
    this.camTX = 0;
    this.time = 0;
    this.sel = null;
    this.hover = null;
    this.drive = null;   // tank animation between nodes
    this.noise = makeNoise(new RNG(4242));
    this.layout();
    this.bindInput();
  }

  // ---- layout -------------------------------------------------------------------------
  layout() {
    const R = new RNG(9001), H = WM.H;
    this.nodes = [];
    this.regions.forEach((reg, ri) => {
      const n = 6;
      for (let j = 0; j < n; j++) {
        const x = ri * WM.RW + 120 + j * (WM.RW - 240) / (n - 1) + R.float(-18, 18);
        const y = H * 0.57 + Math.sin(j * 1.25 + ri * 2.2) * H * 0.18 + R.float(-22, 22);
        const level = reg.levels[j] || null;
        this.nodes.push({ x, y, region: ri, j, level, ghost: !level });
      }
    });
    // Road: Catmull-Rom through every node, from the left edge to the right.
    const pts = [{ x: -40, y: this.nodes[0].y + 30 }, ...this.nodes, { x: this.W + 40, y: this.nodes[this.nodes.length - 1].y - 20 }];
    this.road = [];
    const cr = (p0, p1, p2, p3, t) => {
      const t2 = t * t, t3 = t2 * t;
      return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      if (i >= 1 && i <= this.nodes.length) this.nodes[i - 1].roadI = this.road.length;
      const steps = Math.max(6, Math.ceil(dist(p1.x, p1.y, p2.x, p2.y) / 8));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        this.road.push({ x: cr(p0.x, p1.x, p2.x, p3.x, t), y: cr(p0.y, p1.y, p2.y, p3.y, t) });
      }
    }
    this.road.push(pts[pts.length - 1]);
    // Where the tank parks for each mission: on the road a little before the node,
    // so the drive between missions ends exactly where the tank then waits.
    for (const n of this.nodes) n.parkI = Math.max(0, n.roadI - 8);
    this.soonX = this.regions.findIndex(r => r.soon) * WM.RW;
    if (this.soonX < 0) this.soonX = this.W;
  }

  // Blend between neighbouring regions: returns [left, right, t] where t is
  // how far into the right-hand region this point reads.
  mix(x, y) {
    const k = Math.round(x / WM.RW);
    if (k > 0 && k < this.regions.length) {
      const wob = (this.noise.fbm(y * 0.012 + k * 7.3, k * 3.1, 3) - 0.5) * 170;
      const d = x - (k * WM.RW + wob);
      if (Math.abs(d) < WM.BLEND) return [k - 1, k, smoothstep(-WM.BLEND, WM.BLEND, d)];
      const r = d < 0 ? k - 1 : k;
      return [r, r, 0];
    }
    const r = clamp(Math.floor(x / WM.RW), 0, this.regions.length - 1);
    return [r, r, 0];
  }
  biomeAt(x, y, rng) {
    const [a, b, t] = this.mix(x, y);
    return BIOMES[this.regions[rng.chance(t) ? b : a].biome];
  }

  nearRoad(x, y, pad) {
    for (let i = 0; i < this.road.length; i += 2) {
      const p = this.road[i];
      if (Math.abs(p.x - x) > pad) continue;
      if (dist2(p.x, p.y, x, y) < pad * pad) return true;
    }
    return false;
  }
  nearNode(x, y, pad) { return this.nodes.some(n => dist2(n.x, n.y, x, y) < pad * pad); }

  // ---- baking ---------------------------------------------------------------------------
  build() {
    if (this.baked) return;
    const S = WM.SCALE, W = this.W, H = WM.H;
    const c = makeCanvas(W * S, H * S), ctx = c.getContext('2d');
    ctx.scale(S, S);
    const R = new RNG(1717);

    // 1. Ground colour, blended across region borders.
    const cell = 4, lw = Math.ceil(W / cell), lh = Math.ceil(H / cell);
    const low = makeCanvas(lw, lh), lctx = low.getContext('2d'), img = lctx.createImageData(lw, lh);
    const pal = this.regions.map(r => BIOMES[r.biome].ground.map(hexToRgb));
    const colorOf = (ri, n) => {
      const cols = pal[ri], t = clamp(n * 1.5 - 0.25, 0, 0.999) * (cols.length - 1), i = Math.floor(t), f = t - i;
      const A = cols[i], B = cols[Math.min(i + 1, cols.length - 1)];
      return [lerp(A[0], B[0], f), lerp(A[1], B[1], f), lerp(A[2], B[2], f)];
    };
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const wx = x * cell, wy = y * cell;
        const n = this.noise.fbm(wx * 0.011, wy * 0.011, 4), n2 = this.noise.fbm(wx * 0.04 + 50, wy * 0.04 + 50, 2);
        const [a, b, t] = this.mix(wx, wy);
        const A = colorOf(a, n), B = colorOf(b, n), v = (n2 - 0.5) * 16;
        const k = (y * lw + x) * 4;
        img.data[k] = lerp(A[0], B[0], t) + v;
        img.data[k + 1] = lerp(A[1], B[1], t) + v;
        img.data[k + 2] = lerp(A[2], B[2], t) + v;
        img.data[k + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(low, 0, 0, lw * cell, lh * cell);

    // 2. Grain.
    const grain = makeCanvas(128, 128), gctx = grain.getContext('2d'), gimg = gctx.createImageData(128, 128);
    for (let i = 0; i < gimg.data.length; i += 4) {
      const v = R.chance(0.5) ? 255 : 0;
      gimg.data[i] = gimg.data[i + 1] = gimg.data[i + 2] = v;
      gimg.data[i + 3] = R.float(0, 18);
    }
    gctx.putImageData(gimg, 0, 0);
    ctx.fillStyle = ctx.createPattern(grain, 'repeat');
    ctx.fillRect(0, 0, W, H);

    // 3. Ground details, per biome, mixed at the borders.
    for (let i = 0; i < W * H / 260; i++) {
      const x = R.float(0, W), y = R.float(0, H), b = this.biomeAt(x, y, R);
      this.detail(ctx, b, x, y, R);
    }
    // Marsh ponds and dune ridges are bigger set pieces.
    for (let i = 0; i < 70; i++) {
      const x = R.float(0, W), y = R.float(30, H - 30), b = this.biomeAt(x, y, R);
      if (this.nearRoad(x, y, 40) || this.nearNode(x, y, 50)) continue;
      if (b.id === 'marsh') this.pond(ctx, x, y, R.float(14, 30), R);
      else if (b.id === 'snow' && R.chance(0.5)) this.icePatch(ctx, x, y, R.float(16, 34), R);
    }

    // 4. The road, its colour shifting with the land it crosses.
    const grad = alpha => {
      const g = ctx.createLinearGradient(0, 0, W, 0);
      this.regions.forEach((r, i) => {
        const b = BIOMES[r.biome];
        g.addColorStop(clamp((i * WM.RW + 60) / W, 0, 1), rgba(alpha.dark ? b.dirtDark : b.dirt, alpha.a));
        g.addColorStop(clamp(((i + 1) * WM.RW - 60) / W, 0, 1), rgba(alpha.dark ? b.dirtDark : b.dirt, alpha.a));
      });
      return g;
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const path = () => { ctx.beginPath(); this.road.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
    for (const [w, a] of [[34, { a: 0.14 }], [24, { a: 0.35 }], [16, { a: 0.7 }], [11, { a: 0.3, dark: true }], [8, { a: 0.6 }]]) {
      ctx.lineWidth = w; ctx.strokeStyle = grad(a); path(); ctx.stroke();
    }
    ctx.setLineDash([2, 5]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(40,30,15,0.35)';
    path(); ctx.stroke();
    ctx.setLineDash([]);

    // 5. Rocks, buildings, trees (trees last so canopies overlap the rest).
    for (let i = 0; i < W / 30; i++) {
      const x = R.float(0, W), y = R.float(20, H - 20);
      if (this.nearRoad(x, y, 26) || this.nearNode(x, y, 42)) continue;
      const b = this.biomeAt(x, y, R);
      ctx.save(); ctx.translate(x, y);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      const r = R.float(4, 9);
      ctx.beginPath(); ctx.ellipse(3, 3.5, r, r * 0.8, 0, 0, TAU); ctx.fill();
      drawRock(ctx, { r }, R, b);
      ctx.restore();
    }
    // Villages and outposts beside the road.
    for (let i = 0; i < this.regions.length * 4; i++) {
      const ri = Math.floor(i / 4), x = ri * WM.RW + R.float(80, WM.RW - 80), y = R.float(60, H - 50);
      if (this.nearRoad(x, y, 46) || this.nearNode(x, y, 60) || !this.nearRoad(x, y, 110)) continue;
      const b = BIOMES[this.regions[ri].biome];
      const n = R.int(1, 3);
      for (let k = 0; k < n; k++) {
        const w = R.int(22, 34), h = R.int(16, 24), bx = x + k * R.float(28, 36) - 20, by = y + R.float(-14, 14);
        if (this.nearRoad(bx + w / 2, by + h / 2, 30)) continue;
        this.house(ctx, bx, by, w, h, R.pick(b.roof), R, b);
      }
    }
    const trees = [];
    for (let i = 0; i < W / 5; i++) {
      const cx = R.float(0, W), cy = R.float(10, H - 10), b = this.biomeAt(cx, cy, R);
      const dens = { grassland: 0.7, cherry: 0.85, autumn: 1, snow: 0.9, marsh: 0.65, desert: 0.22, badlands: 0.3 }[b.id] || 0.6;
      if (!R.chance(dens)) continue;
      const n = R.int(1, 4);
      for (let k = 0; k < n; k++) {
        const x = cx + R.float(-18, 18), y = cy + R.float(-14, 14);
        if (this.nearRoad(x, y, 22) || this.nearNode(x, y, 36)) continue;
        trees.push({ x, y, b, r: R.float(7, 12) * (b.treeType === 'cactus' ? 0.7 : 1) });
      }
    }
    trees.sort((a, b) => a.y - b.y);
    for (const t of trees) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(t.x + t.r * 0.35, t.y + t.r * 0.45, t.r, t.r * 0.85, 0, 0, TAU); ctx.fill();
      ctx.save(); ctx.translate(t.x, t.y);
      drawTree(ctx, { canopy: t.r }, R, t.b);
      ctx.restore();
    }

    // 6. Fortifications around each boss node.
    for (const n of this.nodes) {
      if (!n.level || !n.level.boss) continue;
      // A ring of sandbags on the far side of the road.
      for (let a = -2.5; a <= -0.6; a += 0.21) {
        const bx = n.x + Math.cos(a) * 34, by = n.y + Math.sin(a) * 30;
        ctx.save(); ctx.translate(bx, by); ctx.rotate(a + Math.PI / 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        roundRectPath(ctx, -3, -1.2, 7.5, 5, 2.2); ctx.fill();
        const g = ctx.createLinearGradient(0, -2.5, 0, 2.5);
        g.addColorStop(0, '#d2c298'); g.addColorStop(1, '#8e7f58');
        ctx.fillStyle = g;
        roundRectPath(ctx, -3.8, -2.5, 7.5, 5, 2.2); ctx.fill();
        ctx.strokeStyle = 'rgba(61,51,34,0.6)'; ctx.lineWidth = 0.5; ctx.stroke();
        ctx.restore();
      }
    }
    // Light vignette along the top and bottom edges.
    for (const [y0, y1] of [[0, 40], [H, H - 40]]) {
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, 'rgba(10,12,9,0.35)'); g.addColorStop(1, 'rgba(10,12,9,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, Math.min(y0, y1), W, 40);
    }
    this.baked = c;
  }

  detail(ctx, b, x, y, R) {
    switch (b.id) {
      case 'grassland': case 'cherry': case 'autumn': case 'marsh': {
        ctx.strokeStyle = rgba(R.pick(b.detail), R.float(0.35, 0.7));
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let k = 0; k < 3; k++) { const a = -Math.PI / 2 + R.float(-0.7, 0.7); ctx.moveTo(x + k, y); ctx.lineTo(x + k + Math.cos(a) * 3.5, y + Math.sin(a) * 3.5); }
        ctx.stroke();
        if (b.id !== 'marsh' && R.chance(b.id === 'grassland' ? 0.12 : 0.45)) {
          ctx.fillStyle = rgba(R.pick(b.flowers), R.float(0.6, 0.95));
          ctx.beginPath(); ctx.ellipse(x + R.float(-5, 5), y + R.float(-5, 5), b.id === 'autumn' ? 1.8 : 1.2, b.id === 'autumn' ? 1 : 0.9, R.float(0, TAU), 0, TAU); ctx.fill();
        }
        break;
      }
      case 'snow':
        if (R.chance(0.3)) {
          const g = ctx.createRadialGradient(x, y, 0, x, y, 8);
          g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g; ctx.fillRect(x - 8, y - 8, 16, 16);
        } else { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(x, y, 0.8, 0.8); }
        break;
      case 'desert':
        if (R.chance(0.25)) {
          ctx.strokeStyle = 'rgba(255,243,214,0.25)'; ctx.lineWidth = 0.9;
          const l = R.float(10, 26);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + l / 2, y - 3, x + l, y + R.float(-2, 2)); ctx.stroke();
        }
        break;
      case 'badlands':
        if (R.chance(0.2)) {
          ctx.strokeStyle = 'rgba(74,29,12,0.25)'; ctx.lineWidth = 0.7;
          let px = x, py = y, a = R.float(0, TAU);
          ctx.beginPath(); ctx.moveTo(px, py);
          for (let s = 0; s < 4; s++) { a += R.float(-0.9, 0.9); px += Math.cos(a) * 5; py += Math.sin(a) * 5; ctx.lineTo(px, py); }
          ctx.stroke();
        }
        break;
    }
  }

  // Small gabled house: two roof planes (lit and shaded), a ridge and a chimney.
  house(ctx, x, y, w, h, col, R, b) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(3, 4, w, h);
    ctx.fillStyle = shade(col, 0.18);
    ctx.fillRect(0, 0, w, h / 2);
    ctx.fillStyle = shade(col, -0.22);
    ctx.fillRect(0, h / 2, w, h / 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.5;
    for (let i = 2; i < w; i += 3) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke(); }
    ctx.fillStyle = shade(col, -0.4);
    ctx.fillRect(0, h / 2 - 0.7, w, 1.4);
    ctx.fillStyle = '#5a5550';
    ctx.fillRect(w * 0.7, h * 0.15, 3, 3.5);
    if (b.id === 'snow') { ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(0, 0, w, h / 2 - 1); }
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 0.8;
    ctx.strokeRect(0.4, 0.4, w - 0.8, h - 0.8);
    ctx.restore();
  }

  pond(ctx, x, y, r, R) {
    ctx.save();
    ctx.fillStyle = 'rgba(58,47,30,0.5)';
    ctx.beginPath(); ctx.ellipse(x, y, r + 4, r * 0.6 + 4, R.float(-0.3, 0.3), 0, TAU); ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.15, 1, x, y, r);
    g.addColorStop(0, '#557a74'); g.addColorStop(1, '#2d433c');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.6, R.float(-0.3, 0.3), 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(210,228,222,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - r * 0.5, y - r * 0.15); ctx.lineTo(x + r * 0.1, y - r * 0.2); ctx.stroke();
    ctx.restore();
  }

  icePatch(ctx, x, y, r, R) {
    ctx.fillStyle = 'rgba(175,205,222,0.3)';
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.55, R.float(0, TAU), 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.ellipse(x - 2, y - 2, r * 0.7, r * 0.35, 0, Math.PI * 1.1, Math.PI * 1.7); ctx.stroke();
  }

  // ---- interaction --------------------------------------------------------------------------
  // Portrait phones put the briefing in a bottom sheet; the map fits above it.
  get sheet() { return this.vw <= 900 && this.vh > this.vw; }
  get mapH() { return this.sheet ? Math.max(200, this.vh - this.sheetH) : this.vh; }
  get scale() { return this.mapH / WM.H; }
  get briefW() { return this.sheet ? 0 : this.briefPx; }
  // Nodes and labels grow when the map is drawn small, so they stay readable and tappable.
  get uiK() { return clamp(0.95 / this.scale, 1, 1.8); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.dpr = dpr;
    this.vw = r.width; this.vh = r.height;
    const brief = document.getElementById('cp-brief');
    this.sheetH = brief ? brief.offsetHeight + 16 : 0;
    this.briefPx = brief && !this.sheet ? brief.offsetWidth + 24 : 0;
    const back = document.getElementById('cp-back');
    this.headerPx = back ? back.getBoundingClientRect().bottom + 8 : 70;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
  }

  toWorld(sx, sy) { return { x: sx / this.scale + this.camX, y: sy / this.scale }; }

  nodeAt(sx, sy) {
    const p = this.toWorld(sx, sy);
    let best = null, bd = ((WM.NODE_R + 8) * this.uiK + (this.touch ? 10 / this.scale : 0)) ** 2;
    for (const n of this.nodes) {
      const d = dist2(n.x, n.y, p.x, p.y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  bindInput() {
    const c = this.canvas;
    let down = null;
    c.addEventListener('pointerdown', e => { this.touch = e.pointerType === 'touch'; down = { x: e.clientX, y: e.clientY, cam: this.camTX, moved: false }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      const r = c.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (down) {
        const dx = e.clientX - down.x;
        if (Math.abs(dx) > (this.touch ? 10 : 4)) down.moved = true;
        if (down.moved) { this.camTX = this.clampCam(down.cam - dx / this.scale); this.camX = this.camTX; }
      }
      this.hover = this.nodeAt(sx, sy);
      c.style.cursor = down && down.moved ? 'grabbing' : this.hover ? 'pointer' : 'grab';
    });
    c.addEventListener('pointerup', e => {
      if (down && !down.moved) {
        const r = c.getBoundingClientRect(), n = this.nodeAt(e.clientX - r.left, e.clientY - r.top);
        if (n) this.select(n, true);
      }
      down = null;
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.camTX = this.clampCam(this.camTX + (e.deltaY + e.deltaX) / this.scale);
    }, { passive: false });
  }

  clampCam(x) {
    const visW = this.vw / this.scale;
    return clamp(x, 0, Math.max(0, this.W - visW + (this.briefW / this.scale)));
  }

  // Center a node in the part of the screen not covered by the briefing.
  focus(n, snap) {
    const avail = (this.vw - this.briefW) / this.scale;
    this.camTX = this.clampCam(n.x - avail / 2);
    if (snap) this.camX = this.camTX;
  }

  select(n, sound) {
    this.sel = n;
    if (sound) this.ui.app.sfx.play('click');
    this.ui.renderBrief(n);
    // The briefing's size decides how much room the map gets (bottom sheet on phones).
    this.resize();
    this.focus(n, false);
  }

  step(dir) {
    if (!this.sel) return;
    const i = this.nodes.indexOf(this.sel), j = clamp(i + dir, 0, this.nodes.length - 1);
    this.select(this.nodes[j], true);
  }

  // Opens on the frontier; if a new mission unlocked since last time, the
  // tank drives down the road to it.
  open(save) {
    this.resize();
    this.build();
    this.save = save;
    const front = frontierLevel(save);
    const seen = clamp(save.seen || 0, 0, front);
    const target = this.nodes.find(n => n.level && n.level.order === front);
    const from = this.nodes.find(n => n.level && n.level.order === seen);
    this.drive = front > seen ? { a: from.parkI, b: target.parkI, t: 0, to: target } : null;
    this.tankAt = from || target;
    if (front > seen) { save.seen = front; saveCampaign(save); }
    this.focus(this.drive ? from : target, true);
    this.select(target, false);
  }

  // ---- drawing -------------------------------------------------------------------------------
  frame(dt) {
    this.time += dt;
    const ctx = this.ctx, s = this.scale, dpr = this.dpr;
    this.camX = lerp(this.camX, this.camTX, damp(8, dt));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d0a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.baked) return;
    // Baked strip.
    const visW = this.vw / s;
    const x0 = clamp(this.camX, 0, this.W), x1 = clamp(this.camX + visW, 0, this.W);
    if (this.sheet) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.vw * dpr, this.mapH * dpr); ctx.clip(); }
    ctx.setTransform(dpr * s, 0, 0, dpr * s, -this.camX * s * dpr, 0);
    ctx.imageSmoothingEnabled = true;
    if (x1 > x0) ctx.drawImage(this.baked, x0 * WM.SCALE, 0, (x1 - x0) * WM.SCALE, WM.H * WM.SCALE, x0, 0, x1 - x0, WM.H);

    this.drawSoonFog(ctx, x0, x1);
    this.drawRegionTitles(ctx);
    this.drawTank(ctx, dt);
    this.drawNodes(ctx);
    if (this.sheet) ctx.restore();
  }

  drawSoonFog(ctx, x0, x1) {
    if (this.soonX >= this.W || x1 < this.soonX - 200) return;
    const fx = this.soonX, H = WM.H;
    const g = ctx.createLinearGradient(fx - 220, 0, fx + 60, 0);
    g.addColorStop(0, 'rgba(14,17,14,0)'); g.addColorStop(1, 'rgba(14,17,14,0.58)');
    ctx.fillStyle = g;
    ctx.fillRect(fx - 220, 0, 280, H);
    ctx.fillStyle = 'rgba(14,17,14,0.58)';
    ctx.fillRect(fx + 60, 0, this.W - fx - 60 + 40, H);
    // Drifting cloud banks.
    ctx.save();
    ctx.globalAlpha = 0.28;
    for (let i = 0; i < 60; i++) {
      const bx = fx - 120 + ((i * 97.3 + this.time * 9) % (this.W - fx + 200));
      const by = ((i * 53.7) % H);
      const r = 60 + (i % 5) * 18;
      if (bx + r < x0 || bx - r > x1) continue;
      ctx.drawImage(FxArt.tints.screen, bx - r, by - r * 0.6, r * 2, r * 1.2);
    }
    ctx.restore();
  }

  drawRegionTitles(ctx) {
    // Phones in portrait show the region in the briefing sheet instead.
    if (this.sheet) return;
    // Keep the banners clear of the header bar however small the map is drawn.
    const top = Math.max(62, (this.headerPx || 70) / this.scale);
    ctx.save();
    ctx.translate(0, top - 62);
    this.regions.forEach((r, i) => {
      const cx = i * WM.RW + WM.RW / 2;
      const levels = r.levels;
      const got = levels.reduce((n, l) => n + starCount(levelStars(this.save, l.id)), 0);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(10,12,9,0.62)';
      roundRectPath(ctx, cx - 112, 62, 224, r.soon ? 50 : 56, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(236,230,214,0.16)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#f0a93a';
      ctx.font = '600 9px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.fillText(('REGION ' + ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][i]).split('').join(String.fromCharCode(8202)), cx, 76);
      ctx.fillStyle = '#ece6d6';
      ctx.font = '400 19px "Saira Stencil One", Impact, sans-serif';
      ctx.fillText(r.name.toUpperCase(), cx, 96);
      ctx.font = '600 10px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.fillStyle = r.soon ? '#a9a390' : '#ffc850';
      ctx.fillText(r.soon ? 'COMING SOON' : `★ ${got} / ${levels.length * 3}`, cx, r.soon ? 107 : 110);
      ctx.restore();
    });
    ctx.restore();
  }

  drawNodes(ctx) {
    const R = WM.NODE_R * this.uiK, K = this.uiK, t = this.time, save = this.save;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of this.nodes) {
      const L = n.level, sel = n === this.sel, hov = n === this.hover;
      const r = R * (L && L.boss ? 1.18 : 1) * (hov ? 1.06 : 1);
      if (n.ghost) {
        ctx.fillStyle = 'rgba(20,22,20,0.55)';
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.8, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(236,230,214,0.25)';
        ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
        if (sel) this.selRing(ctx, n.x, n.y, r);
        continue;
      }
      const st = levelStars(save, L.id), open = levelUnlocked(save, L.order), won = st[0];
      const current = open && !won;
      // Shadow + base plate.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(n.x + 2, n.y + 3, r, 0, TAU); ctx.fill();
      let g = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.35, 1, n.x, n.y, r);
      if (won) { g.addColorStop(0, '#6fb2ff'); g.addColorStop(1, '#23508a'); }
      else if (open) { g.addColorStop(0, '#ffcf73'); g.addColorStop(1, '#b8761d'); }
      else { g.addColorStop(0, '#5a5a52'); g.addColorStop(1, '#2a2b27'); }
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = won ? '#bfe0ff' : open ? '#fff0c2' : 'rgba(236,230,214,0.3)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (current) {
        const k = (t * 0.9) % 1;
        ctx.strokeStyle = `rgba(255,200,90,${1 - k})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 + k * 10, 0, TAU); ctx.stroke();
      }
      // Label: number, boss star or padlock.
      if (!open) {
        ctx.fillStyle = 'rgba(236,230,214,0.6)';
        ctx.fillRect(n.x - 4.5 * K, n.y - 1 * K, 9 * K, 7 * K);
        ctx.strokeStyle = 'rgba(236,230,214,0.6)'; ctx.lineWidth = 1.6 * K;
        ctx.beginPath(); ctx.arc(n.x, n.y - 2 * K, 3 * K, Math.PI, 0); ctx.stroke();
      } else if (L.boss) {
        ctx.fillStyle = won ? '#fff' : '#3a2206';
        ctx.beginPath();
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = (i % 2 ? 3.6 : 8.5) * K; ctx.lineTo(n.x + Math.cos(a) * rr, n.y + Math.sin(a) * rr); }
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = won ? '#fff' : '#3a2206';
        ctx.font = `700 ${Math.round(15 * K)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
        ctx.fillText(String(L.order + 1), n.x, n.y + 1);
      }
      // Stars under the node, then the mission name and mode.
      for (let i = 0; i < 3; i++) this.star(ctx, n.x + (i - 1) * 11 * K, n.y + r + 9 * K, 4.6 * K, st[i] ? '#ffc850' : 'rgba(20,22,20,0.7)', st[i] ? '#8a5a10' : 'rgba(236,230,214,0.35)');
      if (sel || hov || current) {
        ctx.font = `600 ${Math.round(11 * K)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
        const label = L.name.toUpperCase(), tw = ctx.measureText(label).width + 12 * K;
        ctx.fillStyle = 'rgba(10,12,9,0.75)';
        roundRectPath(ctx, n.x - tw / 2, n.y + r + 17 * K, tw, 15 * K, 4); ctx.fill();
        ctx.fillStyle = '#ece6d6';
        ctx.fillText(label, n.x, n.y + r + 25 * K);
      }
      if (sel) this.selRing(ctx, n.x, n.y, r);
    }
    ctx.restore();
  }

  selRing(ctx, x, y, r) {
    const k = 0.5 + 0.5 * Math.sin(this.time * 4), s = r + 7 + k * 2, L = 6;
    ctx.strokeStyle = '#f0a93a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(x + dx * s, y + dy * (s - L)); ctx.lineTo(x + dx * s, y + dy * s); ctx.lineTo(x + dx * (s - L), y + dy * s);
    }
    ctx.stroke();
  }

  star(ctx, x, y, r, fill, stroke) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 0.8; ctx.stroke();
  }

  // The player's tank sits on the frontier node (and drives there after a win).
  drawTank(ctx, dt) {
    let p, a;
    if (this.drive) {
      const d = this.drive;
      d.t = Math.min(1, d.t + dt / 2.2);
      const f = d.a + (d.b - d.a) * easeOutCubic(d.t), i = Math.floor(f);
      const p0 = this.road[i], p1 = this.road[Math.min(i + 1, this.road.length - 1)];
      p = { x: lerp(p0.x, p1.x, f - i), y: lerp(p0.y, p1.y, f - i) };
      a = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      if (d.t < 1 && Math.random() < dt * 20) this.dust = (this.dust || []).concat([{ x: p.x, y: p.y, life: 0.8 }]);
      if (d.t >= 1) { this.drive = null; this.tankAt = d.to; }
      else if (d.t > 0.1 && Math.abs(this.camTX - (p.x - (this.vw - this.briefW) / this.scale / 2)) > 4) {
        this.camTX = this.clampCam(p.x - (this.vw - this.briefW) / this.scale / 2);
      }
    } else if (this.tankAt) {
      const i = this.tankAt.parkI, p0 = this.road[i], p1 = this.road[Math.min(i + 1, this.road.length - 1)];
      p = { x: p0.x, y: p0.y };
      a = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    if (!p) return;
    this.dust = (this.dust || []).filter(d => (d.life -= dt) > 0);
    for (const d of this.dust) {
      ctx.globalAlpha = d.life * 0.4;
      ctx.drawImage(FxArt.tints.dust, d.x - 8, d.y - 8, 16, 16);
    }
    ctx.globalAlpha = 1;
    const art = TankArt.get(TEAM_COLORS[0]), k = 0.42 * Math.min(this.uiK, 1.4);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(3, 4, 15, 11, a, 0, TAU); ctx.fill();
    ctx.rotate(a);
    ctx.scale(k, k);
    ctx.fillStyle = '#26231f';
    roundRectPath(ctx, -30, -22, 60, 10, 3); ctx.fill();
    roundRectPath(ctx, -30, 12, 60, 10, 3); ctx.fill();
    ctx.drawImage(TankArt.hull(TEAM_COLORS[0], this.save.equip.hull), -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H);
    ctx.drawImage(art.barrel, 0, -BARREL_H / 2, BARREL_W, BARREL_H);
    ctx.drawImage(art.turret, -(TURRET_W / 2 - 4), -TURRET_H / 2, TURRET_W, TURRET_H);
    ctx.restore();
  }
}

// Hangar turntable: the player's current build on a concrete pad.
class HangarPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.tank = new Tank({ name: 'You', team: 0, color: TEAM_COLORS[0] });
    this.tank.alive = true;
    this.tank.missileCharge = 9999;
    // Just enough of a renderer for Renderer.prototype.drawTank.
    this.r = Object.create(Renderer.prototype);
    this.r.time = 0;
    this.r.views = [{}];
    this.r.game = { specialCost: () => 1, night: false };
  }

  setLoadout(L) { this.tank.loadout = Object.assign({}, L); this.tank.recalc(140); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), r = this.canvas.getBoundingClientRect();
    this.dpr = dpr; this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
  }

  frame(dt) {
    if (!this.w) this.resize();
    this.time += dt;
    this.r.time = this.time;
    const ctx = this.ctx, t = this.tank, w = this.w, h = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const k = Math.min(w, h) / 150;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(k, k);
    // Pad with painted markings.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(2, 3, 52, 0, TAU); ctx.fill();
    const g = ctx.createRadialGradient(-10, -12, 5, 0, 0, 52);
    g.addColorStop(0, '#8d897d'); g.addColorStop(1, '#5b5850');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 50, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(240,169,58,0.55)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.arc(0, 0, 45, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // The tank itself, slowly turning, turret sweeping.
    t.x = w / 2 / k; t.y = h / 2 / k;
    t.angle = -0.5 + this.time * 0.35;
    t.turret = t.angle + Math.sin(this.time * 0.8) * 0.6;
    t.treadL = t.treadR = this.time * 6;
    t.spin = this.time * 12;
    t.heat = 0;
    ctx.save();
    ctx.scale(k, k);
    this.r.drawTankShadow(ctx, t);
    this.r.drawTank(ctx, t);
    ctx.restore();
  }
}
