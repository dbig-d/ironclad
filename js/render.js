'use strict';
// ---------------------------------------------------------------------------
// World renderer: camera, terrain, obstacles, tanks, shells, objectives,
// particles and world-space labels. Screen-space HUD lives in hud.js.
// ---------------------------------------------------------------------------

// Quality tiers the frame-rate governor steps through: render resolution,
// particle density, cloud shadows and ambient weather.
const QUALITY = [
  { res: 0.55, density: 0.45, clouds: false, ambient: 0.4 },
  { res: 0.7, density: 0.6, clouds: false, ambient: 0.6 },
  { res: 0.85, density: 0.8, clouds: true, ambient: 0.8 },
  { res: 1, density: 1, clouds: true, ambient: 1 },
];
// Ambient weather: fixed pseudo-random offsets per particle slot, computed once.
const AMB_HASH = (() => {
  const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const a = new Float32Array(128 * 3);
  for (let i = 0; i < 128; i++) { a[i * 3] = hash(i * 3 + 1); a[i * 3 + 1] = hash(i * 7 + 2); a[i * 3 + 2] = hash(i * 11 + 5); }
  return a;
})();
const LEAF_COLS = ['rgba(214,112,44,0.9)', 'rgba(190,72,38,0.9)', 'rgba(232,168,56,0.9)', 'rgba(160,62,36,0.85)'];
// Name tags are baked into sprites; this changes when web fonts finish loading so they re-bake.
let LABEL_GEN = 0;
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.ready.then(() => LABEL_GEN++);
  document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', () => LABEL_GEN++);
}

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.quality = LOW_MEM ? 2 : 3;
    this.cloudTex = makeCloudTexture(1234);
    this.cloudPattern = this.ctx.createPattern(this.cloudTex, 'repeat');
    this.hud = new HudPainter(this);
    this.views = [this.makeView(0)];
    this.view = this.views[0];
    this.resize();
  }

  // A view is one camera + screen rectangle. Two views = split screen.
  makeView(idx) {
    return { idx, cam: { x: 0, y: 0, zoom: 1 }, x: 0, y: 0, w: 1, h: 1, baseZoom: 1, player: null };
  }

  // Main camera, for code that only cares about one view (audio, single player).
  get cam() { return this.views[0].cam; }

  setSplit(n) {
    while (this.views.length < n) this.views.push(this.makeView(this.views.length));
    this.views.length = n;
    this.layout();
  }

  get Q() { return QUALITY[this.quality]; }

  // Step quality down (dir -1) or up (+1). Returns false when already at the limit.
  setQuality(dir) {
    const q = clamp(this.quality + dir, 0, QUALITY.length - 1);
    if (q === this.quality) return false;
    this.quality = q;
    if (this.fx) this.fx.setDensity(this.Q.density);
    this.resize();
    return true;
  }

  resize() {
    const base = Math.min(window.devicePixelRatio || 1, 2);
    const dpr = Math.max(Math.min(base, 0.6), Math.round(base * this.Q.res * 20) / 20);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.layout();
  }

  layout() {
    const n = this.views.length, gap = 4;
    this.views.forEach((v, i) => {
      v.w = n === 1 ? this.w : (this.w - gap) / 2;
      v.h = this.h;
      v.x = n === 1 ? 0 : i * (v.w + gap);
      v.y = 0;
      v.baseZoom = clamp(Math.sqrt((v.w * v.h) / (1500 * 860)), 0.5, 1.6);
    });
    this.hud.resize();
  }

  setGame(game, humans = []) {
    this.game = game;
    this.terrain = new Terrain(game.map);
    this.fx = new FX(this.terrain);
    this.fx.setDensity(this.Q.density);
    this.setSplit(Math.max(1, humans.length));
    this.views.forEach((v, i) => {
      v.player = humans[i] || null;
      const f = v.player || game.tanks[0];
      v.cam.x = f.x; v.cam.y = f.y;
      v.cam.zoom = v.baseZoom;
    });
    this.fx.viewers = this.views.map(v => ({ cam: v.cam, player: v.player }));
    this.hud.setGame(game);
  }

  screenToWorld(sx, sy, v = this.views[0]) {
    return { x: (sx - v.x - v.w / 2) / v.cam.zoom + v.cam.x, y: (sy - v.y - v.h / 2) / v.cam.zoom + v.cam.y };
  }
  worldToScreen(wx, wy, v = this.view) {
    return { x: (wx - v.cam.x) * v.cam.zoom + v.x + v.w / 2, y: (wy - v.cam.y) * v.cam.zoom + v.y + v.h / 2 };
  }

  // focus: tank or point the view follows; aim: world point for look-ahead.
  updateCamera(v, dt, focus, aim, zoomMul = 1) {
    const c = v.cam, m = this.game.map;
    let tx = focus.x, ty = focus.y;
    if (aim) {
      const dx = aim.x - focus.x, dy = aim.y - focus.y, d = Math.hypot(dx, dy);
      const k = Math.min(d * 0.22, 190) / (d || 1);
      tx += dx * k; ty += dy * k;
    }
    c.zoom = lerp(c.zoom, v.baseZoom * zoomMul, damp(3, dt));
    const hw = v.w / 2 / c.zoom, hh = v.h / 2 / c.zoom, lim = TERRAIN_PAD - 30;
    tx = m.w + 2 * lim < hw * 2 ? m.w / 2 : clamp(tx, hw - lim, m.w + lim - hw);
    ty = m.h + 2 * lim < hh * 2 ? m.h / 2 : clamp(ty, hh - lim, m.h + lim - hh);
    const k = damp(7, dt);
    c.x = lerp(c.x, tx, k);
    c.y = lerp(c.y, ty, k);
  }

  viewRect(margin = 0, v = this.view) {
    const c = v.cam, hw = v.w / 2 / c.zoom + margin, hh = v.h / 2 / c.zoom + margin;
    return { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh };
  }

  // ---- frame ------------------------------------------------------------------------
  render(dt, opts) {
    this.time += dt;
    const ctx = this.ctx, g = this.game, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d0a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.bucketParticles();

    for (const view of this.views) {
      this.view = view;
      const c = view.cam;
      const shake = (this.fx.shake[view.idx] || 0) ** 2 * 16;
      const sx = shake ? (Math.sin(this.time * 91) + Math.sin(this.time * 53)) * 0.5 * shake : 0;
      const sy = shake ? (Math.cos(this.time * 77) + Math.sin(this.time * 61)) * 0.5 * shake : 0;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.rect(view.x, view.y, view.w, view.h);
      ctx.clip();
      const z = c.zoom * dpr;
      ctx.setTransform(z, 0, 0, z, dpr * (view.x + view.w / 2 + sx) - c.x * z, dpr * (view.y + view.h / 2 + sy) - c.y * z);
      const v = this.viewRect(80);

      this.drawTerrain(ctx, v);
      this.drawGroundMarks(ctx);
      this.drawEscortGround(ctx);
      this.drawMines(ctx, v, view);
      this.drawStrikeMarks(ctx);
      this.drawWrecks(ctx, v);
      this.drawParticles(ctx, v, this.pDust);
      const seen = t => t.alive && this.inView(t, v) && this.visibleTo(t, view);
      for (const t of g.tanks) if (seen(t)) this.drawTankShadow(ctx, t);
      this.drawObstacles(ctx, v, false);
      this.drawFlags(ctx, false);
      for (const t of g.tanks) if (seen(t)) { if (t.isConvoy) this.drawConvoy(ctx, t); else this.drawTank(ctx, t); }
      this.drawFlags(ctx, true);
      const night = g.night;
      if (!night) { this.drawShells(ctx, v); this.drawMissiles(ctx, v); this.drawGrenades(ctx, v); }
      this.drawParticles(ctx, v, this.pGround);
      this.drawAdditive(ctx, v);
      this.drawSmokes(ctx, v);
      if (!night) this.drawArtillery(ctx, v);
      this.drawObstacles(ctx, v, true);
      this.drawPlanes(ctx, v);
      this.drawClouds(ctx, v);
      this.drawAmbient(ctx, v);
      if (night) {
        // Darkness, then everything that glows on top of it.
        this.drawNight(ctx, view);
        this.drawShells(ctx, v);
        this.drawMissiles(ctx, v);
        this.drawGrenades(ctx, v);
        this.drawAdditive(ctx, v, true);
        this.drawArtillery(ctx, v);
      }
      this.drawZone(ctx, v);
      if (!opts.demo) this.drawLabels(ctx, v, view.player, view);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.hud.drawView(ctx, view, opts);
      ctx.restore();
    }
    this.view = this.views[0];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.hud.drawShared(ctx, opts);
  }

  inView(p, v) { return p.x > v.x0 && p.x < v.x1 && p.y > v.y0 && p.y < v.y1; }

  // Enemy tanks inside a smokescreen are hidden unless you're right next to them.
  visibleTo(t, view) {
    const p = view.player;
    if (!p || t === p || t.team === p.team || !this.game.inSmoke(t.x, t.y)) return true;
    return p.alive && dist2(p.x, p.y, t.x, t.y) < 110 * 110;
  }

  // Night: an enemy is lit if one of your side's tanks is close enough.
  litAtNight(t, view) {
    const p = view.player;
    if (!this.game.night || !p || t.team === p.team || t.isConvoy) return true;
    for (const a of this.game.tanks) if (a.alive && a.team === p.team && dist2(a.x, a.y, t.x, t.y) < 380 * 380) return true;
    return false;
  }

  // Limited visibility overlay: night (dark blue with headlight beams), fog
  // (pale grey) or sandstorm (ochre). Lights, fires and blasts cut through it.
  drawNight(ctx, view) {
    const g = this.game, w = Math.ceil(view.w), h = Math.ceil(view.h), kind = g.visibility;
    const V = {
      night: { fill: 'rgba(5,9,24,0.8)', pool: 260, beam: 540, beamA: 0.9 },
      fog: { fill: 'rgba(198,204,206,0.84)', pool: 230, beam: 300, beamA: 0.5 },
      sandstorm: { fill: 'rgba(166,116,62,0.8)', pool: 250, beam: 340, beamA: 0.55 },
    }[kind];
    let c = this.nightCanvas;
    if (!c || c.width !== w || c.height !== h) c = this.nightCanvas = makeCanvas(w, h);
    const n = c.getContext('2d');
    n.globalCompositeOperation = 'source-over';
    n.clearRect(0, 0, w, h);
    n.fillStyle = V.fill;
    n.fillRect(0, 0, w, h);
    n.globalCompositeOperation = 'destination-out';
    const cam = view.cam, z = cam.zoom;
    const sx = x => (x - cam.x) * z + w / 2, sy = y => (y - cam.y) * z + h / 2;
    const hole = (x, y, r, a) => {
      const px = sx(x), py = sy(y), R = r * z;
      if (px < -R || py < -R || px > w + R || py > h + R || a <= 0) return;
      const gr = n.createRadialGradient(px, py, R * 0.2, px, py, R);
      gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      n.fillStyle = gr;
      n.fillRect(px - R, py - R, R * 2, R * 2);
    };
    const myTeam = view.player ? view.player.team : 0;
    for (const t of g.tanks) {
      if (!t.alive) continue;
      if (t.team === myTeam || t.isConvoy) {
        hole(t.x, t.y, V.pool * t.scale, 0.95);
        // Headlight beam.
        const L = V.beam * z, px = sx(t.x), py = sy(t.y);
        n.save();
        n.translate(px, py);
        n.rotate(t.angle);
        const gr = n.createRadialGradient(0, 0, 20 * z, 0, 0, L);
        gr.addColorStop(0, `rgba(0,0,0,${V.beamA})`); gr.addColorStop(0.6, `rgba(0,0,0,${V.beamA * 0.6})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
        n.fillStyle = gr;
        n.beginPath(); n.moveTo(10 * z, -10 * z); n.lineTo(L, -L * 0.38); n.lineTo(L, L * 0.38); n.lineTo(10 * z, 10 * z); n.closePath(); n.fill();
        n.restore();
      } else hole(t.x, t.y, 60, 0.35);
    }
    for (const l of this.fx.lights) hole(l.x, l.y, l.r * 1.7, clamp(l.life / l.max, 0, 1));
    for (const k of this.fx.wrecks) if (k.burn > 0) hole(k.x, k.y, 150, 0.55);
    for (const s of g.shells) if (s.flame) hole(s.x, s.y, 70, 0.4);
    for (const m of g.missiles) hole(m.x, m.y, 110, 0.6);
    for (const t of g.tanks) if (t.alive && t.burnT > 0) hole(t.x, t.y, 120, 0.6);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(c, view.x, view.y, view.w, view.h);
    // Blowing sand streaks / drifting fog banks over the top.
    if (kind === 'sandstorm' || kind === 'fog') {
      const t = this.time, tint = kind === 'fog' ? FxArt.tints.screen : FxArt.tints.dust;
      ctx.globalAlpha = kind === 'fog' ? 0.22 : 0.28;
      for (let i = 0; i < 26; i++) {
        const sp = kind === 'fog' ? 14 : 140, r = (kind === 'fog' ? 140 : 70) + (i % 5) * 30;
        const x = view.x + (((i * 173.1 + t * sp * (0.6 + (i % 3) * 0.3)) % (view.w + r * 2)) + view.w + r * 2) % (view.w + r * 2) - r;
        const y = view.y + ((i * 97.3) % view.h) + Math.sin(t * 0.5 + i) * 20;
        ctx.drawImage(tint, x - r, y - r * 0.5, r * 2, r);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawTerrain(ctx, v) {
    const T = this.terrain, s = T.scale, P = TERRAIN_PAD;
    const x0 = clamp(v.x0, -P, this.game.map.w + P), y0 = clamp(v.y0, -P, this.game.map.h + P);
    const x1 = clamp(v.x1, -P, this.game.map.w + P), y1 = clamp(v.y1, -P, this.game.map.h + P);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(T.canvas, (x0 + P) * s, (y0 + P) * s, (x1 - x0) * s, (y1 - y0) * s, x0, y0, x1 - x0, y1 - y0);
  }

  // Team pads, flag stands and the hill ring.
  drawGroundMarks(ctx) {
    const g = this.game, m = g.map, t = this.time;
    if (m.layout === 'teams') {
      let pads = this.pads;
      if (!pads || pads.map !== m) {
        pads = this.pads = { map: m, list: [] };
        m.spawnCenters.forEach((cs, team) => {
          const col = g.teams[team].color, w = 300, h = 330, L = 34;
          for (const cc of cs) {
            const cx = cc.x + (team === 0 ? 20 : -20), x0 = cx - w / 2, x1 = cx + w / 2, y0 = cc.y - h / 2, y1 = cc.y + h / 2;
            pads.list.push({
              fill: rgba(col.main, 0.1), stroke: rgba(col.ui, 0.75), x: x0, y: y0, w, h,
              corners: [x0, y0, L, L, x1, y0, -L, L, x0, y1, L, -L, x1, y1, -L, -L],
            });
          }
        });
      }
      ctx.lineWidth = 4;
      for (const p of pads.list) {
        ctx.fillStyle = p.fill;
        ctx.fillRect(p.x, p.y, p.w, p.h);
        ctx.strokeStyle = p.stroke;
        ctx.beginPath();
        for (let i = 0; i < 16; i += 4) {
          const bx = p.corners[i], by = p.corners[i + 1];
          ctx.moveTo(bx + p.corners[i + 2], by); ctx.lineTo(bx, by); ctx.lineTo(bx, by + p.corners[i + 3]);
        }
        ctx.stroke();
      }
    }
    if (g.mode instanceof CTFMode) {
      for (const f of g.mode.flags) {
        const col = g.teams[f.team].color;
        ctx.fillStyle = rgba(col.main, 0.25);
        ctx.beginPath(); ctx.arc(f.homeX, f.homeY, 46, 0, TAU); ctx.fill();
        ctx.strokeStyle = rgba(col.ui, 0.9);
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -t * 20;
        ctx.beginPath(); ctx.arc(f.homeX, f.homeY, 46, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (g.mode instanceof KOTHMode) {
      const k = g.mode, h = m.hill;
      const ownerCol = k.owner >= 0 ? g.teams[k.owner].color.ui : '#f3ecd6';
      const pulse = 0.5 + 0.5 * Math.sin(t * 4);
      ctx.fillStyle = k.contested ? rgba('#ffd35a', 0.08 + pulse * 0.08) : rgba(ownerCol, k.owner >= 0 ? 0.13 : 0.06);
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = rgba(k.contested ? '#ffd35a' : ownerCol, 0.85);
      ctx.lineWidth = 4;
      ctx.setLineDash([22, 14]);
      ctx.lineDashOffset = -t * 30;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      if (k.progress > 0 && k.progress < 1) {
        const pc = g.teams[k.owner >= 0 ? k.owner : k.capTeam].color.ui;
        ctx.strokeStyle = rgba(pc, 0.95);
        ctx.lineWidth = 10;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(h.x, h.y, h.r - 14, -Math.PI / 2, -Math.PI / 2 + TAU * k.progress); ctx.stroke();
        ctx.lineCap = 'butt';
      }
      // Crown emblem.
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.fillStyle = rgba(ownerCol, 0.55 + pulse * 0.2);
      ctx.beginPath();
      ctx.moveTo(-18, 10); ctx.lineTo(-20, -8); ctx.lineTo(-9, 1); ctx.lineTo(0, -14); ctx.lineTo(9, 1); ctx.lineTo(20, -8); ctx.lineTo(18, 10);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  drawWrecks(ctx, v) {
    const w = TankArt.getWreck();
    for (const k of this.fx.wrecks) {
      if (!this.inView(k, v)) continue;
      ctx.save();
      ctx.globalAlpha = Math.min(1, k.life / 2.5);
      ctx.translate(k.x, k.y);
      ctx.rotate(k.a);
      ctx.drawImage(w.hull, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H);
      ctx.rotate(k.ta - k.a);
      ctx.drawImage(w.barrel, -4, -BARREL_H / 2, BARREL_W, BARREL_H);
      ctx.drawImage(w.turret, -(TURRET_W / 2 - 4), -TURRET_H / 2, TURRET_W, TURRET_H);
      ctx.restore();
    }
  }

  drawTankShadow(ctx, t) {
    const sh = TankArt.getShadows(), s = t.scale;
    if (t.isConvoy) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.translate(t.x + 7, t.y + 9);
      ctx.rotate(t.angle);
      ctx.drawImage(sh.hull, -(CONVOY_W + 20) / 2, -(CONVOY_H + 18) / 2, CONVOY_W + 20, CONVOY_H + 18);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.translate(t.x + 5 * s, t.y + 7 * s);
    ctx.rotate(t.angle);
    ctx.scale(s, s);
    ctx.drawImage(sh.hull, -(HULL_W + 16) / 2, -(HULL_H + 16) / 2, HULL_W + 16, HULL_H + 16);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.translate(t.x + (9 - Math.cos(t.angle) * 2) * s, t.y + (12 - Math.sin(t.angle) * 2) * s);
    ctx.rotate(t.turret);
    ctx.scale(s, s);
    ctx.drawImage(sh.turret, -(TURRET_W + 46) / 2, -(TURRET_H + 16) / 2, TURRET_W + 46, TURRET_H + 16);
    ctx.restore();
  }

  drawTread(ctx, y0, phase, h = 10, x0 = -30, len = 60) {
    ctx.drawImage(GearArt.tread(h, len, gearFrame(phase, 4.5)), x0, y0, len, h);
  }

  // Running gear (hull space, nose +x). Treads and wheels are cached sprites, one per animation frame.
  drawRunningGear(ctx, t, tires) {
    const pl = t.treadL / t.scale, pr = t.treadR / t.scale;
    if (tires === 'quad') {
      this.drawTread(ctx, -26.5, pl, 7, -31, 62);
      this.drawTread(ctx, -19, pl + 2, 7, -29, 58);
      this.drawTread(ctx, 12, pr + 2, 7, -29, 58);
      this.drawTread(ctx, 19.5, pr, 7, -31, 62);
      return;
    }
    if (tires === 'rover') {
      for (const [y, ph] of [[-17.5, pl], [17.5, pr]]) {
        ctx.fillStyle = '#3a3733';
        ctx.fillRect(-26, y - 1, 52, 2);
        const img = GearArt.tyre(15, 9, 3.5, 3.5, 'bar', gearFrame(ph, 3.5));
        for (const x of [-20, 0, 20]) ctx.drawImage(img, x - 7.5, y - 4.5, 15, 9);
      }
      return;
    }
    if (tires === 'carwheels') {
      // Six big run-flat tyres on bogie arms; the front pair steers.
      const steer = clamp(t.turnVel * 0.2, -0.45, 0.45);
      for (const [y, ph] of [[-18.5, pl], [18.5, pr]]) {
        ctx.fillStyle = '#34312d';
        ctx.fillRect(-24, y - 1.2, 44, 2.4);
        const img = GearArt.tyre(17, 10.5, 4.6, 3.8, 'car', gearFrame(ph, 3.8));
        ctx.drawImage(img, -27.5, y - 5.25, 17, 10.5);
        ctx.drawImage(img, -9.5, y - 5.25, 17, 10.5);
        ctx.save();
        ctx.translate(17, y);
        ctx.rotate(steer);
        ctx.drawImage(img, -8.5, -5.25, 17, 10.5);
        ctx.restore();
      }
      return;
    }
    if (tires === 'halftrack') {
      // Tracks at the back, steering wheels up front that turn with the hull.
      this.drawTread(ctx, -22, pl, 10, -31, 36);
      this.drawTread(ctx, 12, pr, 10, -31, 36);
      const steer = clamp(t.turnVel * 0.18, -0.4, 0.4);
      for (const [y, ph] of [[-17, pl], [17, pr]]) {
        ctx.save();
        ctx.translate(17, y);
        ctx.rotate(steer);
        ctx.drawImage(GearArt.tyre(16, 10, 4, 3.6, 'hub', gearFrame(ph, 3.6)), -8, -5, 16, 10);
        ctx.restore();
      }
      return;
    }
    if (tires === 'christie') {
      // Christie suspension: big road wheels showing through a light track.
      for (const [y0, ph] of [[-22.5, pl], [11.5, pr]]) {
        this.drawTread(ctx, y0, ph, 11, -31, 62);
        const cy = y0 + 5.5, img = GearArt.roadWheel(gearFrame(ph / 5.2, TAU / 3));
        for (const x of [-21, -7, 7, 21]) ctx.drawImage(img, x - 5.4, cy - 5.4, 10.8, 10.8);
        ctx.fillStyle = 'rgba(38,35,31,0.85)';
        ctx.fillRect(-31, y0 < 0 ? y0 : y0 + 9.4, 62, 1.6);
      }
      return;
    }
    this.drawTread(ctx, -22, pl);
    this.drawTread(ctx, 12, pr);
    if (tires === 'neutral') {
      // Big toothed drive sprockets up front, each track driven on its own.
      for (const [y, ph] of [[-17, pl], [17, pr]]) ctx.drawImage(GearArt.sprocket(gearFrame(ph / 6, TAU / 8)), 18.5, y - 6.5, 13, 13);
    }
  }

  // Turret-space weapon: cannon, twin, fore & aft, gatling or bazooka tube.
  drawWeapon(ctx, t, art) {
    const w = t.loadout.weapon;
    const rec = easeOutCubic(t.recoil) * (w === 'mg' || w === 'flame' ? 1.2 : w === 'bazooka' || w === 'longgun' || w === 'hesh' ? 8 : 6);
    if (w === 'double') {
      const h = BARREL_H * 0.82;
      ctx.drawImage(art.barrel, -rec, -5.5 - h / 2, BARREL_W, h);
      ctx.drawImage(art.barrel, -rec * 0.7, 5.5 - h / 2, BARREL_W, h);
    } else if (w === 'twin') {
      ctx.drawImage(art.barrel, -rec, -BARREL_H / 2, BARREL_W, BARREL_H);
      ctx.save();
      ctx.rotate(Math.PI);
      ctx.drawImage(art.barrel, -rec - 3, -BARREL_H / 2, BARREL_W - 4, BARREL_H);
      ctx.restore();
    } else if (w === 'mg') {
      const g = ctx.createLinearGradient(0, -5, 0, 5);
      g.addColorStop(0, '#6d6a64'); g.addColorStop(0.5, '#3b3935'); g.addColorStop(1, '#1f1e1b');
      ctx.fillStyle = g;
      roundRectPath(ctx, 8 - rec, -5, 11, 10, 2.5);
      ctx.fill();
      const spin = t.spin || 0;
      const bars = [0, 1, 2].map(i => Math.sin(spin + i * TAU / 3) * 2.8).sort((a, b) => a - b);
      for (const y of bars) {
        ctx.fillStyle = shade('#4a4843', y * 0.06);
        ctx.fillRect(18 - rec, y - 0.9, 20, 1.8);
      }
      ctx.fillStyle = '#26241f';
      ctx.fillRect(37 - rec, -4, 2.5, 8);
      ctx.fillRect(26 - rec, -3.5, 2, 7);
      if (t.heat > 35) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,110,40,${(t.heat - 35) / 65 * 0.85})`;
        ctx.fillRect(18 - rec, -3.6, 21, 7.2);
        ctx.restore();
      }
    } else if (w === 'longgun') {
      ctx.drawImage(art.longBarrel, -rec, -BARREL_H / 2, LONG_W, BARREL_H);
    } else if (w === 'hesh') {
      ctx.drawImage(art.stub, -rec, -BARREL_H / 2, BARREL_W, BARREL_H);
    } else if (w === 'coax') {
      ctx.drawImage(art.barrel, -rec, -BARREL_H / 2, BARREL_W, BARREL_H);
      // Coaxial machine gun alongside the main gun.
      ctx.fillStyle = '#1f1e1b';
      ctx.fillRect(8, 5.3, 21.5, 1.4);
      ctx.fillStyle = '#3a3833';
      ctx.fillRect(8, 4.6, 9, 2.8);
      ctx.fillStyle = '#141311';
      ctx.fillRect(28.8, 5, 1.2, 2);
    } else if (w === 'wire') {
      // The launch rail sits on the turret roof (drawn after the turret).
    } else if (w === 'flame') {
      // Fuel tanks on the turret's back deck, a hose, and a flared nozzle with a pilot flame.
      for (const y of [-6.5, 6.5]) {
        const g = ctx.createLinearGradient(0, y - 3, 0, y + 3);
        g.addColorStop(0, '#8a8660'); g.addColorStop(0.5, '#5d5a3d'); g.addColorStop(1, '#3a3826');
        ctx.fillStyle = g;
        roundRectPath(ctx, -22, y - 3, 12, 6, 3); ctx.fill();
        ctx.fillStyle = '#d8a332';
        ctx.fillRect(-17, y - 3, 1.6, 6);
      }
      ctx.strokeStyle = '#2a2926';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-10, -6.5); ctx.quadraticCurveTo(0, -9, 8, -3); ctx.stroke();
      const g = ctx.createLinearGradient(0, -3.4, 0, 3.4);
      g.addColorStop(0, '#77736b'); g.addColorStop(0.5, '#45423d'); g.addColorStop(1, '#23221f');
      ctx.fillStyle = g;
      roundRectPath(ctx, 9 - rec, -3.2, 19, 6.4, 2); ctx.fill();
      ctx.fillStyle = '#9a958a';
      for (const x of [14, 20]) ctx.fillRect(x - rec, -3.5, 1.3, 7);
      ctx.fillStyle = '#34322d';
      ctx.beginPath(); ctx.moveTo(27 - rec, -3.4); ctx.lineTo(32 - rec, -4.8); ctx.lineTo(32 - rec, 4.8); ctx.lineTo(27 - rec, 3.4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#141311';
      ctx.fillRect(31.2 - rec, -3, 1.2, 6);
      if (t.overheatT <= 0) {
        const f = 0.8 + 0.3 * Math.sin(this.time * 31 + t.id);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.9;
        ctx.drawImage(FxArt.tints.fire, 32.5 - rec - 5 * f, -5 * f, 10 * f, 10 * f);
        ctx.fillStyle = '#9fd0ff';
        ctx.beginPath(); ctx.arc(33 - rec, 0, 0.9, 0, TAU); ctx.fill();
        ctx.restore();
      }
      if (t.heat > 35) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,110,40,${(t.heat - 35) / 65 * 0.7})`;
        ctx.fillRect(22 - rec, -3.2, 10, 6.4);
        ctx.restore();
      }
    } else if (w === 'bazooka') {
      ctx.drawImage(art.launcher, -rec, -(BARREL_H + 4) / 2, BARREL_W, BARREL_H + 4);
      if (t.reload <= 0) {
        ctx.fillStyle = '#c8402f';
        ctx.beginPath(); ctx.moveTo(39 - rec, -3.2); ctx.quadraticCurveTo(45 - rec, 0, 39 - rec, 3.2); ctx.closePath(); ctx.fill();
      }
    } else {
      ctx.drawImage(art.barrel, -rec, -BARREL_H / 2, BARREL_W, BARREL_H);
    }
  }

  // Special-equipment details: missile pod, smoke cups (turret), mine rack or mortar (hull).
  drawAttachment(ctx, t, where) {
    const sp = t.loadout.special, ready = t.missileCharge >= this.game.specialCost(t);
    if (where === 'hull') {
      if (sp === 'mine') {
        for (const y of [-5.5, 5.5]) {
          ctx.fillStyle = '#4f4d38';
          ctx.beginPath(); ctx.arc(-21, y, 3.6, 0, TAU); ctx.fill();
          ctx.fillStyle = ready ? '#ffb347' : '#2b2a20';
          ctx.beginPath(); ctx.arc(-21, y, 1.1, 0, TAU); ctx.fill();
        }
      } else if (sp === 'repair') {
        // Tool chest and spare track links on the back deck.
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-23, -9, 10, 7);
        const g = ctx.createLinearGradient(0, -10, 0, -3);
        g.addColorStop(0, '#b0502e'); g.addColorStop(1, '#6e2c18');
        ctx.fillStyle = g;
        roundRectPath(ctx, -24, -10, 10, 6.5, 1.2); ctx.fill();
        ctx.fillStyle = '#2a211b';
        ctx.fillRect(-21, -10.8, 4, 1.2);
        ctx.fillStyle = ready ? '#7dffa0' : '#e8dcc8';
        ctx.fillRect(-19.8, -8.6, 1.6, 3.8);
        ctx.fillRect(-20.9, -7.5, 3.8, 1.6);
        ctx.fillStyle = '#2e2c28';
        for (let i = 0; i < 3; i++) { roundRectPath(ctx, -24 + i * 3.6, 4, 3, 5, 0.8); ctx.fill(); }
        ctx.fillStyle = '#6a665e';
        for (let i = 0; i < 3; i++) ctx.fillRect(-23.4 + i * 3.6, 6.2, 1.8, 0.8);
      } else if (sp === 'overdrive') {
        // Supercharger on the engine deck and twin exhaust stacks.
        ctx.fillStyle = '#2d2b27';
        roundRectPath(ctx, -24, -5, 8, 10, 1.5); ctx.fill();
        ctx.fillStyle = '#7d786e';
        for (let y = -3.5; y <= 3; y += 2.2) ctx.fillRect(-23, y, 6, 1);
        for (const y of [-8.5, 8.5]) {
          ctx.fillStyle = '#3a3733';
          ctx.beginPath(); ctx.arc(-26, y, 2.6, 0, TAU); ctx.fill();
          ctx.fillStyle = t.boostT > 0 ? '#ffb347' : '#141414';
          ctx.beginPath(); ctx.arc(-26, y, 1.4, 0, TAU); ctx.fill();
        }
        if (ready) { ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.arc(-15, 0, 1.2, 0, TAU); ctx.fill(); }
      } else if (sp === 'salvo') {
        // Rocket pods slung on the rear fenders, two tubes each.
        for (const s of [-1, 1]) {
          const y = s * 17;
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(-27, y - 2.5, 17, 7);
          ctx.fillStyle = '#4b4e33';
          roundRectPath(ctx, -28, y - 4, 17, 8, 1.6); ctx.fill();
          ctx.fillStyle = '#6f7349';
          ctx.fillRect(-27.5, y - 3.6, 16, 1.2);
          ctx.fillStyle = '#2a2b1f';
          ctx.fillRect(-22, y - 4, 1, 8); ctx.fillRect(-16, y - 4, 1, 8);
          for (const dy of [-1.9, 1.9]) {
            ctx.fillStyle = '#16150f';
            ctx.beginPath(); ctx.arc(-11, y + dy, 1.8, 0, TAU); ctx.fill();
            if (ready) { ctx.fillStyle = '#c8402f'; ctx.beginPath(); ctx.arc(-11, y + dy, 1.15, 0, TAU); ctx.fill(); }
          }
        }
      } else if (sp === 'airstrike') {
        // Air-recognition panel on the engine deck, a radio set and its whip aerial.
        ctx.fillStyle = ready ? '#ff7a3c' : '#b85a36';
        ctx.fillRect(-25.5, -6.5, 8.5, 13);
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(-22.8, -6.5, 0.8, 13); ctx.fillRect(-19.8, -6.5, 0.8, 13);
        ctx.fillStyle = '#2f2d28';
        roundRectPath(ctx, -15, 7, 7.5, 4.5, 1); ctx.fill();
        ctx.fillStyle = ready && Math.sin(this.time * 8) > 0 ? '#7dffa0' : '#3c5a44';
        ctx.fillRect(-9.6, 8.2, 1.2, 1.2);
        const sway = clamp(-t.speed * 0.025, -4, 4) + Math.sin(this.time * 5 + t.id) * 0.7;
        ctx.strokeStyle = '#1b1a18'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(-13, 9); ctx.quadraticCurveTo(-25, 10 + sway * 0.4, -37, 12.5 + sway); ctx.stroke();
      } else if (sp === 'artillery') {
        ctx.fillStyle = '#2c2a26';
        ctx.beginPath(); ctx.arc(-17, 7.5, 4.6, 0, TAU); ctx.fill();
        ctx.save();
        ctx.translate(-17, 7.5);
        ctx.rotate(-2.4);
        const g = ctx.createLinearGradient(0, -2, 0, 2);
        g.addColorStop(0, '#77736b'); g.addColorStop(1, '#2d2b27');
        ctx.fillStyle = g;
        ctx.fillRect(0, -2, 11, 4);
        ctx.fillStyle = '#141414';
        ctx.fillRect(10, -1.4, 1.4, 2.8);
        ctx.restore();
      }
      return;
    }
    if (sp === 'missile') {
      ctx.fillStyle = '#2e2d2a';
      roundRectPath(ctx, -7, 10.5, 14, 5.5, 1.5);
      ctx.fill();
      if (ready) {
        ctx.fillStyle = '#d8453a';
        for (const y of [12, 14.6]) { ctx.beginPath(); ctx.arc(7.5, y, 1.3, 0, TAU); ctx.fill(); }
      }
    } else if (sp === 'flak') {
      // Twin 20 mm on a pintle at the back of the turret roof; it swings onto whatever it's shooting at.
      const on = t.flakT > 0, a = on ? t.flakAngle - t.turret : -0.4;
      ctx.save();
      ctx.translate(-5, -6.5);
      ctx.fillStyle = '#2d2b27';
      ctx.beginPath(); ctx.arc(0, 0, 4.2, 0, TAU); ctx.fill();
      ctx.rotate(a);
      ctx.fillStyle = '#44423c';
      roundRectPath(ctx, -3, -3.3, 7.5, 6.6, 1.2); ctx.fill();
      ctx.fillStyle = '#1b1a18';
      ctx.fillRect(4, -2.5, 13, 1.3); ctx.fillRect(4, 1.2, 13, 1.3);
      ctx.fillStyle = '#26241f';
      ctx.fillRect(15, -2.9, 2.2, 2.1); ctx.fillRect(15, 0.8, 2.2, 2.1);
      ctx.fillStyle = ready || on ? '#ffb347' : '#56534c';
      ctx.fillRect(-2.2, -1, 2, 2);
      ctx.restore();
    } else if (sp === 'grenades') {
      // A launcher cup on each side of the turret; brass shows while a grenade is loaded.
      for (const s of [-1, 1]) {
        const y = s * 12.4;
        ctx.fillStyle = '#34322d';
        roundRectPath(ctx, -5, y - 2.6, 11, 5.2, 1.4); ctx.fill();
        ctx.fillStyle = '#23211e';
        ctx.fillRect(5, y - 2.1, 3.6, 4.2);
        const loaded = t.grenadeAmmo >= (s < 0 ? 1 : 2) || (t.grenadeAmmo === 0 && ready);
        // A third round waiting shows as a brighter cap.
        const spare = t.grenadeAmmo >= 3;
        ctx.fillStyle = loaded ? (spare ? '#e8c35a' : '#c9a24a') : '#141311';
        ctx.beginPath(); ctx.arc(8.6, y, spare ? 1.8 : 1.5, 0, TAU); ctx.fill();
      }
    } else if (sp === 'smoke') {
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
        const x = 7 - i * 3.2, y = s * (11.5 + i * 0.6);
        ctx.fillStyle = '#34332f';
        ctx.beginPath(); ctx.arc(x, y, 1.7, 0, TAU); ctx.fill();
        ctx.fillStyle = ready ? '#c9c4b8' : '#56534c';
        ctx.beginPath(); ctx.arc(x, y, 0.8, 0, TAU); ctx.fill();
      }
    }
  }

  // Gold glow and a slowly turning ring under the Juggernaut.
  drawJugAura(ctx, t) {
    const r = 52 * t.scale, k = 0.5 + 0.5 * Math.sin(this.time * 3);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.28 + 0.12 * k;
    ctx.drawImage(FxArt.tints.glow, t.x - r * 1.5, t.y - r * 1.5, r * 3, r * 3);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = `rgba(255,200,80,${0.55 + 0.25 * k})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    ctx.lineDashOffset = -this.time * 40;
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  // Campaign Ace: a crimson and gold ring so the boss reads from afar.
  drawAceAura(ctx, t) {
    const r = 46 * t.scale, k = 0.5 + 0.5 * Math.sin(this.time * 2.5);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.18 + 0.1 * k;
    ctx.drawImage(FxArt.tints.red, t.x - r * 1.4, t.y - r * 1.4, r * 2.8, r * 2.8);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = `rgba(255,120,80,${0.5 + 0.3 * k})`;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 8]);
    ctx.lineDashOffset = this.time * 30;
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  drawTank(ctx, t) {
    const art = TankArt.get(t.color), s = t.scale;
    if (t.jug) this.drawJugAura(ctx, t);
    if (t.ace) this.drawAceAura(ctx, t);
    if (t.isPlayer) {
      // Co-op players get their own accent colour so each can find their tank.
      const col = this.views.length > 1 ? PLAYER_COLORS[t.humanIndex] : t.color.ui;
      ctx.strokeStyle = rgba(col, 0.4 + 0.15 * Math.sin(this.time * 3));
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(t.x, t.y, 38 * s, 0, TAU); ctx.stroke();
    }
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(s, s);
    const hull = TankArt.hull(t.color, t.loadout.hull);
    ctx.save();
    ctx.rotate(t.angle);
    this.drawRunningGear(ctx, t, t.loadout.tires);
    ctx.drawImage(hull, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H);
    this.drawAttachment(ctx, t, 'hull');
    if (t.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = t.flash * 0.55;
      ctx.drawImage(hull, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.translate(-Math.cos(t.angle) * 2, -Math.sin(t.angle) * 2);
    ctx.rotate(t.turret);
    this.drawWeapon(ctx, t, art);
    ctx.drawImage(art.turret, -(TURRET_W / 2 - 4), -TURRET_H / 2, TURRET_W, TURRET_H);
    if (t.loadout.weapon === 'wire') {
      const rec = easeOutCubic(t.recoil) * 3;
      ctx.drawImage(art.rail, -rec, -(BARREL_H + 4) / 2, BARREL_W, BARREL_H + 4);
      if (t.reload <= 0 && !(t.wireMissile && t.wireMissile.alive)) ctx.drawImage(FxArt.wire, 14 - rec, -5.5, 22, 11);
    }
    this.drawAttachment(ctx, t, 'turret');
    ctx.restore();
    // Anti-air rounds running: a faint ring shows the area it covers.
    if (t.flakT > 0) {
      ctx.save();
      ctx.strokeStyle = rgba(t.color.ui, Math.min(1, t.flakT) * (0.2 + 0.08 * Math.sin(this.time * 4)));
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 9]);
      ctx.lineDashOffset = this.time * 20;
      ctx.beginPath(); ctx.arc(t.x, t.y, FLAK.radius, 0, TAU); ctx.stroke();
      ctx.restore();
    }
    // On fire: an orange glow licking over the hull.
    if (t.burnT > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, t.burnT) * (0.35 + 0.15 * Math.sin(this.time * 23 + t.id));
      const r = 34 * s;
      ctx.drawImage(FxArt.tints.fire, t.x - r, t.y - r, r * 2, r * 2);
      ctx.restore();
    }
    // Level-up invulnerability: a golden shimmer.
    if (t.invuln > 0) {
      const a = Math.min(1, t.invuln * 1.5) * (0.6 + 0.25 * Math.sin(this.time * 12));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const r = 44 * s;
      const gr = ctx.createRadialGradient(t.x, t.y, r * 0.55, t.x, t.y, r);
      gr.addColorStop(0, 'rgba(255,200,80,0)');
      gr.addColorStop(0.85, `rgba(255,200,80,${0.28 * a})`);
      gr.addColorStop(1, `rgba(255,235,170,${0.55 * a})`);
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.fill();
      ctx.restore();
    }

    if (t.shield > 0 || t.spawnFx > 0) {
      const a = Math.min(1, t.shield * 2) * (0.55 + 0.2 * Math.sin(this.time * 10));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const r = (40 + t.spawnFx * 20) * s;
      const gr = ctx.createRadialGradient(t.x, t.y, r * 0.6, t.x, t.y, r);
      gr.addColorStop(0, 'rgba(120,200,255,0)');
      gr.addColorStop(0.85, `rgba(120,200,255,${0.25 * a})`);
      gr.addColorStop(1, `rgba(200,240,255,${0.5 * a})`);
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  drawFlagCloth(ctx, x, y, color, scale, phase) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(6, 5, 7, 3.5, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#d8d2c4';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -40); ctx.stroke();
    const w = 30, h = 20, t = this.time * 6 + phase;
    ctx.beginPath();
    ctx.moveTo(0, -40);
    for (let i = 0; i <= 6; i++) { const x2 = (i / 6) * w; ctx.lineTo(x2, -40 + Math.sin(t + i * 0.9) * 2.2 * (i / 6)); }
    for (let i = 6; i >= 0; i--) { const x2 = (i / 6) * w; ctx.lineTo(x2, -40 + h + Math.sin(t + i * 0.9) * 2.2 * (i / 6)); }
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -40, w, -20);
    g.addColorStop(0, shade(color.ui, -0.1)); g.addColorStop(1, shade(color.main, -0.2));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#f1ead8';
    ctx.beginPath(); ctx.arc(0, -41, 2.4, 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawFlags(ctx, carried) {
    const g = this.game;
    if (!(g.mode instanceof CTFMode)) return;
    for (const f of g.mode.flags) {
      const col = g.teams[f.team].color;
      if (f.state === 'carried' && carried && f.carrier) {
        const c = f.carrier;
        // Pulsing ring so the carrier reads at a glance.
        ctx.strokeStyle = rgba(col.ui, 0.5 + 0.3 * Math.sin(this.time * 6));
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(c.x, c.y, 44, 0, TAU); ctx.stroke();
        this.drawFlagCloth(ctx, c.x - Math.cos(c.angle) * 18, c.y - Math.sin(c.angle) * 18, col, 1, f.team);
      } else if (f.state !== 'carried' && !carried) {
        if (f.state === 'dropped') {
          ctx.strokeStyle = rgba(col.ui, 0.6);
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(f.x, f.y, 26 + Math.sin(this.time * 5) * 3, 0, TAU); ctx.stroke();
          // Return timer arc.
          ctx.strokeStyle = rgba('#ffffff', 0.8);
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(f.x, f.y, 32, -Math.PI / 2, -Math.PI / 2 + TAU * (f.dropT / 15)); ctx.stroke();
        }
        this.drawFlagCloth(ctx, f.x, f.y + 10, col, 1, f.team);
      }
    }
  }

  // Flamethrower jets: each puff swells and cools from white-hot to smoke.
  drawFlames(ctx) {
    const tints = FxArt.tints;
    ctx.save();
    for (const s of this.game.shells) {
      if (!s.flame) continue;
      const k = clamp(s.age / s.life, 0, 1), size = 6 + k * 20;
      if (k > 0.55) {
        ctx.globalAlpha = (k - 0.55) * 0.7;
        ctx.drawImage(tints.dark, s.x - size * 1.1, s.y - size * 1.1, size * 2.2, size * 2.2);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.game.shells) {
      if (!s.flame) continue;
      const k = clamp(s.age / s.life, 0, 1), size = 6 + k * 20, wob = Math.sin(s.age * 40 + s.x) * 2;
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.drawImage(tints.fire, s.x - size + wob, s.y - size, size * 2, size * 2);
      if (k < 0.45) {
        ctx.globalAlpha = (0.45 - k) * 1.6;
        const c = size * 0.55;
        ctx.drawImage(tints.glow, s.x - c, s.y - c, c * 2, c * 2);
      }
    }
    ctx.restore();
  }

  drawShells(ctx, v) {
    const glow = FxArt.tints.glow, shells = this.game.shells;
    this.drawFlames(ctx);
    if (!shells.length) return;
    const vis = s => s.x > v.x0 && s.x < v.x1 && s.y > v.y0 && s.y < v.y1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // Machine-gun tracers.
    ctx.strokeStyle = 'rgba(255,226,140,0.9)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (const s of shells) {
      if (!s.bullet || !vis(s)) continue;
      const l = Math.min(0.03, s.age) * s.speed;
      ctx.moveTo(s.x - Math.cos(s.angle) * l, s.y - Math.sin(s.angle) * l);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    // Shell streaks: a wide faint tail and a bright core, each one batched stroke.
    const streak = (k, width, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const s of shells) {
        if (s.bullet || s.flame || !vis(s)) continue;
        const long = s.kind === 'long';
        const trail = Math.min(long ? 0.07 : 0.06, s.age) * (long ? s.speed : TANK.shellSpeed) * k;
        ctx.moveTo(s.x - Math.cos(s.angle) * trail, s.y - Math.sin(s.angle) * trail);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    };
    streak(1, 4, 'rgba(255,140,40,0.22)');
    streak(0.55, 2.8, 'rgba(255,190,100,0.45)');
    streak(0.25, 2.2, 'rgba(255,215,140,0.7)');
    ctx.globalAlpha = 0.75;
    for (const s of shells) if (!s.bullet && !s.flame && vis(s)) ctx.drawImage(glow, s.x - 16, s.y - 16, 32, 32);
    ctx.restore();
    ctx.fillStyle = '#fff8e0';
    for (const s of shells) {
      if (s.bullet || s.flame || !vis(s)) continue;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, s.kind === 'long' ? 7 : 5, s.hesh ? 3 : 2.4, s.angle, 0, TAU); ctx.fill();
    }
  }

  drawMissiles(ctx, v) {
    const tints = FxArt.tints;
    for (const m of this.game.missiles) {
      if (!this.inView(m, v)) continue;
      const ca = Math.cos(m.angle), sa = Math.sin(m.angle);
      // The guide wire pays out behind a wire-guided missile.
      if (m.wire && !m.cut && m.owner.alive) {
        const o = m.owner, ox = o.x + Math.cos(o.turret) * 10 * o.scale, oy = o.y + Math.sin(o.turret) * 10 * o.scale;
        const ex = m.x - ca * 9, ey = m.y - sa * 9, dx = ex - ox, dy = ey - oy, dl = Math.hypot(dx, dy) || 1;
        const sag = Math.sin(this.time * 6 + m.age * 4) * Math.min(14, dl * 0.04);
        ctx.strokeStyle = 'rgba(225,215,185,0.5)';
        ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.quadraticCurveTo((ox + ex) / 2 - dy / dl * sag, (oy + ey) / 2 + dx / dl * sag, ex, ey); ctx.stroke();
      }
      // Ground shadow sells the height.
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(m.x + 5, m.y + 8, 8, 3, m.angle, 0, TAU); ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const small = m.kind === 'salvo' ? 0.65 : m.wire ? 0.8 : 1;
      const tx = m.x - ca * 10, ty = m.y - sa * 10, f = (0.85 + Math.random() * 0.35) * small;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(tints.fire, tx - 13 * f, ty - 13 * f, 26 * f, 26 * f);
      ctx.drawImage(tints.glow, tx - 6, ty - 6, 12, 12);
      ctx.strokeStyle = 'rgba(255,210,140,0.8)';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx - ca * 12 * f, ty - sa * 12 * f); ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.angle);
      if (m.wire) ctx.drawImage(FxArt.wire, -11, -5.5, 22, 11);
      else if (m.kind === 'salvo') ctx.drawImage(FxArt.rocket, -6.5, -2.8, 13, 5.6);
      else if (m.rocket) ctx.drawImage(FxArt.rocket, -8, -3.5, 16, 7);
      else ctx.drawImage(FxArt.missile, -10, -4.5, 20, 9);
      ctx.restore();
      // Warning beacon, flashes with each beep.
      if (m.blink > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = m.blink;
        ctx.drawImage(tints.red, m.x - 14, m.y - 14, 28, 28);
        ctx.fillStyle = '#ffd0c8';
        ctx.beginPath(); ctx.arc(m.x + ca * 2, m.y + sa * 2, 1.8, 0, TAU); ctx.fill();
        ctx.restore();
      }
    }
  }

  // Sort the particles into their draw passes once a frame.
  bucketParticles() {
    const dust = this.pDust || (this.pDust = []);
    const ground = this.pGround || (this.pGround = []);
    const add = this.pAdd || (this.pAdd = []);
    dust.length = 0; ground.length = 0; add.length = 0;
    for (const p of this.fx.parts) {
      if (p.type === P_DUST) dust.push(p);
      else if (p.type === P_SMOKE || p.type === P_DEBRIS) ground.push(p);
      else add.push(p);
    }
  }

  drawParticles(ctx, v, list) {
    const tints = FxArt.tints;
    for (const p of list) {
      if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) continue;
      const k = p.life / p.max;
      if (p.type === P_DEBRIS) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, k * 3);
        ctx.translate(p.x, p.y - p.z * 0.25);
        ctx.rotate(p.rot);
        const s = p.size * (1 + p.z / 300);
        ctx.fillStyle = p.tint;
        ctx.fillRect(-s, -s * 0.6, s * 2, s * 1.2);
        ctx.restore();
        continue;
      }
      const size = p.size * (1 + (1 - k) * (p.grow - 1));
      ctx.globalAlpha = p.alpha * (k < 0.7 ? k / 0.7 : 1) * (p.type === P_SMOKE ? Math.min(1, (1 - k) * 8 + 0.2) : 1);
      ctx.drawImage(tints[p.tint || 'smoke'], p.x - size, p.y - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
  }

  drawAdditive(ctx, v, nightPass = false) {
    const fx = this.fx, tints = FxArt.tints;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (!nightPass) for (const l of fx.lights) {
      if (l.x < v.x0 - l.r || l.x > v.x1 + l.r || l.y < v.y0 - l.r || l.y > v.y1 + l.r) continue;
      ctx.globalAlpha = (l.life / l.max) * 0.5;
      ctx.drawImage(tints[l.c] || tints.glow, l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    for (const p of this.pAdd) {
      if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) continue;
      const k = p.life / p.max;
      if (p.type === P_FIRE) {
        const size = p.size * (1 + (1 - k) * (p.grow - 1));
        ctx.globalAlpha = k * 0.9;
        ctx.drawImage(k > 0.5 ? tints.glow : tints.fire, p.x - size, p.y - size, size * 2, size * 2);
      } else if (p.type === P_SPARK) {
        ctx.globalAlpha = k;
        ctx.strokeStyle = p.tint === 'blue' ? '#bfe6ff' : '#ffd890';
        ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
      } else if (p.type === P_FLASH) {
        ctx.globalAlpha = k;
        const size = p.size * (1.4 - k * 0.4);
        ctx.drawImage(tints.glow, p.x - size, p.y - size, size * 2, size * 2);
      } else if (p.type === P_REPAIR) {
        ctx.globalAlpha = Math.min(1, k * 1.6) * 0.9;
        ctx.fillStyle = p.tint || '#7dffa0';
        const s = p.size;
        ctx.fillRect(p.x - s, p.y - s * 0.3, s * 2, s * 0.6);
        ctx.fillRect(p.x - s * 0.3, p.y - s, s * 0.6, s * 2);
      } else if (p.type === P_RING) {
        const r = p.size + (1 - k) * (p.tint === 'blue' || p.tint === 'gold' ? 70 : 150);
        ctx.globalAlpha = k * 0.7;
        ctx.strokeStyle = p.tint === 'blue' ? '#9fdcff' : p.tint === 'gold' ? '#ffc850' : '#ffd9a0';
        ctx.lineWidth = 6 * k + 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
      }
    }
    if (fx.tracers.length) {
      ctx.strokeStyle = '#ffd890';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (const tr of fx.tracers) {
        ctx.globalAlpha = tr.life / tr.max;
        ctx.beginPath(); ctx.moveTo(tr.x1, tr.y1); ctx.lineTo(tr.x2, tr.y2); ctx.stroke();
      }
    }
    for (const f of fx.flashes) {
      const k = f.life / f.max;
      ctx.globalAlpha = k;
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.a);
      const s = 34 * f.s * (0.7 + 0.3 * k);
      ctx.drawImage(FxArt.flash, -s * 0.35, -s * 0.5, s, s);
      ctx.restore();
    }
    ctx.restore();
  }

  drawObstacles(ctx, v, canopies) {
    const sprites = this.terrain.sprites, obs = this.game.map.obstacles;
    for (let i = 0; i < sprites.length; i++) {
      const s = sprites[i];
      if (!!s.canopy !== canopies) continue;
      if (s.x > v.x1 || s.y > v.y1 || s.x + s.w < v.x0 || s.y + s.h < v.y0) continue;
      if (canopies) {
        // Fade canopies when a tank is hiding underneath.
        const o = obs[i];
        let under = false;
        const rr = (o.canopy + 10) ** 2;
        for (const t of this.game.tanks) if (t.alive && dist2(t.x, t.y, o.cx, o.cy) < rr) { under = true; break; }
        o._fade = lerp(o._fade === undefined ? 1 : o._fade, under ? 0.45 : 1, 0.15);
        ctx.globalAlpha = o._fade;
        if (this.quality >= 2) {
          const sway = Math.sin(this.time * 0.9 + o.seed) * 0.03;
          ctx.save();
          ctx.translate(o.cx, o.cy);
          ctx.rotate(sway);
          ctx.drawImage(s.canvas, s.x - o.cx, s.y - o.cy, s.w, s.h);
          ctx.restore();
        } else ctx.drawImage(s.canvas, s.x, s.y, s.w, s.h);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(s.canvas, s.x, s.y, s.w, s.h);
      }
    }
  }

  drawClouds(ctx, v) {
    const b = this.game.map.biome;
    if (!this.cloudPattern.setTransform || !this.Q.clouds) return;
    const ox = this.time * 14, oy = this.time * 6;
    this.cloudPattern.setTransform(new DOMMatrix().translate(ox, oy).scale(3.2));
    ctx.save();
    ctx.globalAlpha = b.cloud;
    ctx.fillStyle = this.cloudPattern;
    ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
    ctx.restore();
  }

  drawZone(ctx, v) {
    const g = this.game;
    if (!(g.mode instanceof BRMode)) return;
    const z = g.mode.zone, m = g.mode;
    ctx.save();
    ctx.fillStyle = 'rgba(96,40,170,0.26)';
    ctx.beginPath();
    ctx.rect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
    ctx.arc(z.x, z.y, Math.max(1, z.r), 0, TAU, true);
    ctx.fill('evenodd');
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(190,140,255,0.55)';
    ctx.lineWidth = 14;
    ctx.beginPath(); ctx.arc(z.x, z.y, Math.max(1, z.r), 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(235,215,255,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(z.x, z.y, Math.max(1, z.r), 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    if (m.state !== 'done' && z.tr < z.r - 2) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([16, 12]);
      ctx.lineDashOffset = -this.time * 25;
      ctx.beginPath(); ctx.arc(z.tx, z.ty, Math.max(1, z.tr), 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Escort: the convoy's remaining route and the extraction zone.
  drawEscortGround(ctx) {
    const m = this.game.mode;
    if (!(m instanceof EscortMode) || !m.route) return;
    const col = this.game.teams[m.defenders].color.ui, c = m.convoy;
    ctx.save();
    ctx.strokeStyle = rgba(col, 0.35);
    ctx.lineWidth = 4;
    ctx.setLineDash([4, 14]);
    ctx.lineDashOffset = -this.time * 18;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const from = c && c.alive ? Math.max(0, c.routeI - 1) : 0;
    if (c && c.alive) ctx.moveTo(c.x, c.y); else ctx.moveTo(m.route[0].x, m.route[0].y);
    for (let i = from + 1; i < m.route.length; i++) ctx.lineTo(m.route[i].x, m.route[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    const e = m.extraction, pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
    ctx.fillStyle = rgba(col, 0.1 + pulse * 0.06);
    ctx.beginPath(); ctx.arc(e.x, e.y, 95, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.8);
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 10]);
    ctx.lineDashOffset = this.time * 25;
    ctx.beginPath(); ctx.arc(e.x, e.y, 95, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rgba(col, 0.85);
    ctx.font = '700 15px "Barlow Condensed", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EXTRACTION', e.x, e.y);
    ctx.restore();
  }

  drawConvoy(ctx, c) {
    const sp = TankArt.getConvoy(c.color);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.drawImage(sp, -CONVOY_W / 2, -CONVOY_H / 2, CONVOY_W, CONVOY_H);
    if (c.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = c.flash * 0.5;
      ctx.drawImage(sp, -CONVOY_W / 2, -CONVOY_H / 2, CONVOY_W, CONVOY_H);
    }
    ctx.restore();
    // Rotating amber beacon on the cab roof.
    const bx = c.x + Math.cos(c.angle) * 24, by = c.y + Math.sin(c.angle) * 24;
    const k = 0.5 + 0.5 * Math.sin(this.time * 9);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + k * 0.4;
    ctx.drawImage(FxArt.tints.glow, bx - 22, by - 22, 44, 44);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffb347';
    ctx.beginPath(); ctx.arc(bx, by, 2.6, 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawMines(ctx, v, view) {
    const me = view.player, S = MINE.size;
    for (const m of this.game.mines) {
      if (!this.inView(m, v)) continue;
      const neutral = m.team === -1, enemy = me && m.team !== me.team && !neutral;
      ctx.save();
      ctx.globalAlpha = neutral ? 0.7 : enemy ? 0.42 : 1; // camouflaged to the other side
      ctx.translate(m.x, m.y);
      const spr = mineSprite(neutral), R = S * 1.8;
      ctx.drawImage(spr, -R, -R, R * 2, R * 2);
      if (neutral) {
        // Marked minefield: a faint warning ring so careful drivers can pick a way through.
        ctx.strokeStyle = `rgba(255,179,71,${0.22 + 0.12 * Math.sin(this.time * 3 + m.x)})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.arc(0, 0, S * 2.4, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
      const on = m.arm > 0 ? true : m.blink < 0.15;
      if (on) {
        ctx.globalCompositeOperation = 'lighter';
        const col = m.arm > 0 || neutral ? '#ffb347' : m.owner.color.ui;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, TAU); ctx.fill();
        ctx.globalAlpha *= 0.5;
        ctx.drawImage(FxArt.tints.red, -11, -11, 22, 22);
      }
      ctx.restore();
    }
  }

  // Artillery: target rings on the ground, shells arcing overhead with shadows.
  drawArtillery(ctx, v) {
    for (const s of this.game.artillery) {
      const k = Math.min(1, s.k), r = ARTY.radius * 0.7;
      ctx.save();
      ctx.strokeStyle = `rgba(255,80,60,${0.3 + k * 0.6})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.arc(s.tx, s.ty, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(s.tx, s.ty, r * (1 - k), 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.tx - 6, s.ty); ctx.lineTo(s.tx + 6, s.ty); ctx.moveTo(s.tx, s.ty - 6); ctx.lineTo(s.tx, s.ty + 6); ctx.stroke();
      ctx.restore();
      // Ground shadow shrinks as the shell climbs.
      const hk = s.h / s.peak;
      ctx.fillStyle = `rgba(0,0,0,${0.35 - hk * 0.2})`;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 6 - hk * 2, 3 - hk, 0, 0, TAU); ctx.fill();
      const ay = s.y - s.h * 0.6, sc = 1 + s.h / 420;
      const a = Math.atan2(s.ty - s.sy, s.tx - s.sx);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.8;
      ctx.drawImage(FxArt.tints.fire, s.x - Math.cos(a) * 6 * sc - 9, ay - Math.sin(a) * 6 * sc - 9, 18, 18);
      ctx.restore();
      ctx.save();
      ctx.translate(s.x, ay);
      ctx.rotate(a);
      ctx.scale(sc, sc);
      ctx.fillStyle = '#3a3935';
      ctx.beginPath(); ctx.ellipse(0, 0, 5, 2.4, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#c9a24a';
      ctx.fillRect(1.5, -2.2, 1.2, 4.4);
      ctx.restore();
    }
  }

  // Grenades: small olive bombs tumbling along the ground, fuse light blinking faster near the end.
  drawGrenades(ctx, v) {
    for (const g of this.game.grenades) {
      if (!this.inView(g, v)) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(g.x + 2.5, g.y + 3.5, 5.5, 3.5, 0, 0, TAU); ctx.fill();
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.spin);
      ctx.fillStyle = '#4f5334';
      ctx.beginPath(); ctx.ellipse(0, 0, 6, 4.2, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.fillStyle = '#80855a';
      ctx.beginPath(); ctx.ellipse(-1.2, -1.3, 2.8, 1.6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#c9a24a';
      ctx.fillRect(3.6, -1.8, 2.2, 3.6);
      ctx.restore();
      if ((g.fuse * (g.fuse < 0.5 ? 14 : 6)) % 1 < 0.5) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.8;
        ctx.drawImage(FxArt.tints.red, g.x - 9, g.y - 9, 18, 18);
        ctx.restore();
      }
    }
  }

  // Airstrike: a dashed red run line on the ground until the bombs fall.
  drawStrikeMarks(ctx) {
    for (const s of this.game.airstrikes) {
      const k = clamp(1 - (s.t - AIRSTRIKE.delay) / 1.2, 0, 1) * clamp(s.t * 3, 0, 1);
      if (k <= 0) continue;
      const L = AIRSTRIKE.length / 2 + 20, ca = Math.cos(s.a), sa = Math.sin(s.a);
      ctx.save();
      ctx.globalAlpha = k * (0.5 + 0.2 * Math.sin(this.time * 8));
      ctx.strokeStyle = '#ff5a3c';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.setLineDash([14, 12]);
      ctx.lineDashOffset = -this.time * 60;
      ctx.beginPath(); ctx.moveTo(s.x - ca * L, s.y - sa * L); ctx.lineTo(s.x + ca * L, s.y + sa * L); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const f of [-0.6, 0, 0.6]) {
        const cx = s.x + ca * L * f, cy = s.y + sa * L * f;
        ctx.moveTo(cx - ca * 8 - sa * 10, cy - sa * 8 + ca * 10); ctx.lineTo(cx + ca * 4, cy + sa * 4); ctx.lineTo(cx - ca * 8 + sa * 10, cy - sa * 8 - ca * 10);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // Airstrike: the fighter-bomber and its shadow sweeping across the field.
  drawPlanes(ctx, v) {
    for (const s of this.game.airstrikes) {
      if (s.along === undefined) continue;
      const ca = Math.cos(s.a), sa = Math.sin(s.a), px = s.x + ca * s.along, py = s.y + sa * s.along;
      if (px < v.x0 - 260 || px > v.x1 + 260 || py < v.y0 - 260 || py > v.y1 + 260) continue;
      const bank = Math.sin(s.t * 1.7) * 0.05;
      ctx.save();
      ctx.globalAlpha = 0.26;
      ctx.translate(px + 80, py + 110);
      ctx.rotate(s.a + bank);
      ctx.drawImage(FxArt.planeShadow, -60, -50, 120, 100);
      ctx.restore();
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(s.a + bank);
      ctx.scale(1.15, 1.15);
      ctx.drawImage(FxArt.plane, -60, -50, 120, 100);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#e6e2d6';
      ctx.beginPath(); ctx.ellipse(30.5, 0, 1.4, 10, 0, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      for (const y of [-32, 32]) {
        ctx.fillStyle = '#e8e4d8';
        ctx.beginPath(); ctx.arc(2, y, 4.4, 0, TAU); ctx.fill();
        ctx.fillStyle = s.owner.color.ui;
        ctx.beginPath(); ctx.arc(2, y, 2.9, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  // Smokescreens: dense, slowly churning clouds drawn over the tanks.
  drawSmokes(ctx, v) {
    const tints = FxArt.tints;
    for (const s of this.game.smokes) {
      if (s.x + s.r < v.x0 || s.x - s.r > v.x1 || s.y + s.r < v.y0 || s.y - s.r > v.y1) continue;
      const age = s.max - s.life, grow = easeOutCubic(clamp(age / 0.9, 0, 1)), fade = clamp(s.life / 1.6, 0, 1);
      const R = new RNG(s.seed);
      ctx.save();
      for (let i = 0; i < 30; i++) {
        const a = R.float(0, TAU) + this.time * R.float(-0.08, 0.08), d = Math.sqrt(R.next()) * s.r * 0.8 * grow;
        const size = R.float(55, 100) * (0.6 + 0.4 * grow);
        const x = s.x + Math.cos(a) * d + Math.sin(this.time * 0.4 + i) * 8, y = s.y + Math.sin(a) * d + Math.cos(this.time * 0.35 + i) * 8;
        ctx.globalAlpha = (i % 4 === 0 ? 0.42 : 0.55) * fade;
        ctx.drawImage(i % 4 === 0 ? tints.smoke : tints.screen, x - size, y - size, size * 2, size * 2);
      }
      ctx.restore();
    }
  }

  drawCrown(ctx, x, y, k) {
    ctx.save();
    ctx.translate(x, y + Math.sin(this.time * 3) * 2);
    ctx.scale(k, k);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.moveTo(-10, 7); ctx.lineTo(-11, -5); ctx.lineTo(-5, 1); ctx.lineTo(1, -8); ctx.lineTo(6, 1); ctx.lineTo(12, -5); ctx.lineTo(11, 7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffc850';
    ctx.beginPath(); ctx.moveTo(-11, 6); ctx.lineTo(-12, -6); ctx.lineTo(-6, 0); ctx.lineTo(0, -9); ctx.lineTo(6, 0); ctx.lineTo(12, -6); ctx.lineTo(11, 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff1c2';
    ctx.fillRect(-11, 3, 22, 2);
    ctx.restore();
  }

  // Drifting ambient particles (snow, petals, dust, pollen). Positions are a
  // pure function of time and index over a repeating world tile: no state.
  drawAmbient(ctx, v) {
    const kind = this.game.map.biome.ambient;
    const cfg = {
      snow: { n: 60, vx: 16, vy: 34, sway: 10 },
      petals: { n: 30, vx: 34, vy: 20, sway: 14 },
      dust: { n: 18, vx: 70, vy: 6, sway: 4 },
      pollen: { n: 14, vx: 10, vy: -4, sway: 8 },
      leaves: { n: 26, vx: 28, vy: 24, sway: 22 },
      drizzle: { n: 110, vx: -60, vy: 520, sway: 0 },
    }[kind];
    if (!cfg) return;
    const T = 640, t = this.time, count = Math.round(cfg.n * this.Q.ambient);
    ctx.save();
    for (let tx = Math.floor(v.x0 / T); tx <= Math.floor(v.x1 / T); tx++) {
      for (let ty = Math.floor(v.y0 / T); ty <= Math.floor(v.y1 / T); ty++) {
        for (let i = 0; i < count; i++) {
          const h1 = AMB_HASH[i * 3], h2 = AMB_HASH[i * 3 + 1], h3 = AMB_HASH[i * 3 + 2];
          const sp = 0.6 + h3 * 0.8;
          const px = ((h1 * T + cfg.vx * sp * t + Math.sin(t * 1.3 + i) * cfg.sway) % T + T) % T;
          const py = ((h2 * T + cfg.vy * sp * t) % T + T) % T;
          const x = tx * T + px, y = ty * T + py;
          if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
          if (kind === 'snow') {
            ctx.fillStyle = `rgba(255,255,255,${0.55 + h3 * 0.4})`;
            ctx.beginPath(); ctx.arc(x, y, 1 + h3 * 1.8, 0, TAU); ctx.fill();
          } else if (kind === 'petals') {
            ctx.fillStyle = h1 < 0.5 ? 'rgba(248,190,212,0.9)' : 'rgba(255,232,240,0.85)';
            ctx.beginPath(); ctx.ellipse(x, y, 3.2, 1.7, t * (1 + h2 * 2) + h1 * 6, 0, TAU); ctx.fill();
          } else if (kind === 'leaves') {
            ctx.fillStyle = LEAF_COLS[Math.floor(h1 * 4)];
            const rot = t * (0.8 + h2 * 2.2) + h1 * 6, flip = Math.abs(Math.sin(t * (1.5 + h3 * 2) + i));
            ctx.beginPath(); ctx.ellipse(x, y, 3.6, 1.9 * (0.35 + flip * 0.65), rot, 0, TAU); ctx.fill();
          } else if (kind === 'drizzle') {
            ctx.strokeStyle = `rgba(200,215,225,${0.18 + h3 * 0.2})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 2.2, y - 13); ctx.stroke();
            // Ripple rings where drops land (a pure function of time, like the drops).
            const rk = (t * 1.3 + h2) % 1;
            if (i % 4 === 0) {
              ctx.strokeStyle = `rgba(200,215,225,${(1 - rk) * 0.22})`;
              ctx.beginPath(); ctx.ellipse(tx * T + h3 * T, ty * T + h1 * T, 2 + rk * 7, (2 + rk * 7) * 0.6, 0, 0, TAU); ctx.stroke();
            }
          } else if (kind === 'dust') {
            ctx.globalAlpha = 0.18 + h3 * 0.12;
            const r = 5 + h3 * 7;
            ctx.drawImage(FxArt.tints.dust, x - r, y - r, r * 2, r * 2);
            ctx.globalAlpha = 1;
          } else {
            ctx.fillStyle = 'rgba(255,240,170,0.5)';
            ctx.fillRect(x, y, 1.5, 1.5);
          }
        }
      }
    }
    ctx.restore();
  }

  // Health bars, names and floating damage numbers. viewPlayer's own tank is
  // skipped (its HUD panel already shows that).
  // Name tag, rank chevrons, level badge and ACE plate, baked once per tank (and per zoom step).
  labelSprite(t, col, S) {
    const lv = this.game.leveling ? t.level : 0, sk = t.skill ? t.skill.id : 0;
    const key = t.name + '|' + col + '|' + sk + '|' + lv + '|' + (t.ace ? 1 : 0) + '|' + S + '|' + LABEL_GEN;
    if (t._lblKey === key) return t._lbl;
    const m = this.measureCtx || (this.measureCtx = makeCanvas(4, 4).getContext('2d'));
    m.font = '600 12px "Barlow Condensed", "Arial Narrow", sans-serif';
    const tw = m.measureText(t.name).width, half = Math.ceil(tw / 2 + 30);
    const c = makeCanvas(Math.ceil(half * 2 * S), Math.ceil(LABEL_H * S)), ctx = c.getContext('2d');
    ctx.scale(S, S);
    ctx.translate(half, LABEL_TOP);   // origin = top of the health bar, centred on the tank
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (t.ace) {
      ctx.font = '700 10px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.fillStyle = 'rgba(10,12,10,0.75)';
      roundRectPath(ctx, -15, -31, 30, 12, 3); ctx.fill();
      ctx.fillStyle = '#ffc850';
      ctx.fillText('★ ACE', 0, -22);
    }
    if (lv) {
      ctx.font = '700 10px "Barlow Condensed", "Arial Narrow", sans-serif';
      const bx = -tw / 2 - 16;
      ctx.fillStyle = 'rgba(10,12,10,0.7)';
      roundRectPath(ctx, bx - 8, -16, 16, 11, 3); ctx.fill();
      ctx.fillStyle = '#ffc850';
      ctx.fillText(lv, bx, -7.5);
    }
    ctx.font = '600 12px "Barlow Condensed", "Arial Narrow", sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(t.name, 1, -5);
    ctx.fillStyle = shade(col, 0.45);
    ctx.fillText(t.name, 0, -6);
    for (let i = 0; i < sk; i++) {
      const cx = tw / 2 + 6 + i * 4.5, cy = -10;
      ctx.fillStyle = '#e8c35a';
      ctx.beginPath(); ctx.moveTo(cx - 2, cy + 2); ctx.lineTo(cx, cy - 2); ctx.lineTo(cx + 2, cy + 2); ctx.closePath(); ctx.fill();
    }
    t._lbl = c; t._lblKey = key; t._lblHalf = half;
    return c;
  }

  drawLabels(ctx, v, viewPlayer, view) {
    const g = this.game, coop = this.views.length > 1;
    const labelRes = Math.min(4, Math.max(1, Math.ceil(view.cam.zoom * this.dpr * 2) / 2));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const t of g.tanks) {
      if (!t.alive || !this.inView(t, v) || t === viewPlayer || !this.visibleTo(t, view) || !this.litAtNight(t, view)) continue;
      if (t.isConvoy) {
        const w = 96, y = t.y - 48, hpf = clamp(t.hp / t.maxHp, 0, 1);
        ctx.fillStyle = 'rgba(10,12,10,0.7)';
        roundRectPath(ctx, t.x - w / 2 - 2, y - 2, w + 4, 9, 3); ctx.fill();
        ctx.fillStyle = hpf < 0.3 ? '#ff6b52' : t.color.ui;
        ctx.fillRect(t.x - w / 2, y, w * hpf, 5);
        ctx.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillText('SUPPLY CONVOY', t.x + 1, y - 5);
        ctx.fillStyle = shade(t.color.ui, 0.45);
        ctx.fillText('SUPPLY CONVOY', t.x, y - 6);
        continue;
      }
      const col = t.isPlayer && coop ? PLAYER_COLORS[t.humanIndex] : t.color.ui;
      const w = 46 * Math.sqrt(t.scale), h = 5, x = t.x - w / 2, y = t.y - 42 * t.scale, hpf = clamp(t.hp / t.maxHp, 0, 1);
      if (!g.oneShot) {
        ctx.fillStyle = 'rgba(10,12,10,0.65)';
        roundRectPath(ctx, x - 1.5, y - 1.5, w + 3, h + 3, 3);
        ctx.fill();
        ctx.fillStyle = t.jug ? '#ffc850' : col;
        ctx.fillRect(x, y, w * hpf, h);
        if (t.repairing) {
          ctx.fillStyle = `rgba(125,255,160,${0.35 + 0.25 * Math.sin(this.time * 8)})`;
          ctx.fillRect(x, y, w * hpf, h);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(x, y, w * hpf, 1.5);
      }
      if (t.jug) this.drawCrown(ctx, t.x, y - 24, 1);
      const L = this.labelSprite(t, col, labelRes);
      ctx.drawImage(L, t.x - t._lblHalf, y - LABEL_TOP, t._lblHalf * 2, LABEL_H);
    }
    for (const n of this.fx.numbers) {
      if (n.x < v.x0 || n.x > v.x1 || n.y < v.y0 || n.y > v.y1) continue;
      const k = n.life / n.max, grow = 1 + (1 - k) * 0.1, spr = this.numberSprite(n, labelRes);
      ctx.globalAlpha = Math.min(1, k * 2.5);
      ctx.drawImage(spr, n.x - n._half * grow, n.y - n._top * grow, n._half * 2 * grow, n._h * grow);
    }
    ctx.globalAlpha = 1;
  }

  // Floating damage numbers are baked once per value (a merged, climbing number re-bakes when it changes).
  numberSprite(n, S) {
    const key = n.text + '|' + n.label + '|' + n.color + '|' + S + '|' + LABEL_GEN;
    if (n._key === key) return n._spr;
    const size = n.big ? 22 : n.mine ? 17 : 14, font = '"Barlow Condensed", "Arial Narrow", sans-serif';
    const m = this.measureCtx || (this.measureCtx = makeCanvas(4, 4).getContext('2d'));
    m.font = '700 ' + size + 'px ' + font;
    const tw = m.measureText(n.text).width;
    let lw = 0;
    if (n.label) { m.font = '700 11px ' + font; lw = m.measureText(n.label).width; }
    const half = Math.ceil(Math.max(tw, lw) / 2 + 3), top = Math.ceil(size + (n.label ? 12 : 2)), h = top + 6;
    const c = makeCanvas(Math.ceil(half * 2 * S), Math.ceil(h * S)), ctx = c.getContext('2d');
    ctx.scale(S, S);
    ctx.translate(half, top);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 ' + size + 'px ' + font;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(n.text, 1.5, 1.5);
    ctx.fillStyle = n.color;
    ctx.fillText(n.text, 0, 0);
    if (n.label) {
      ctx.font = '700 11px ' + font;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(n.label, 1, -size + 1);
      ctx.fillStyle = n.color;
      ctx.fillText(n.label, 0, -size);
    }
    n._spr = c; n._key = key; n._half = half; n._top = top; n._h = h;
    return c;
  }
}
