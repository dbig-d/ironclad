'use strict';
// ---------------------------------------------------------------------------
// Screen-space canvas HUD. Per-view: vignette, hit direction, objective
// markers, crosshair / co-op lock-on. Shared: minimap and split divider.
// Text-heavy HUD panels live in the DOM (ui.js).
// ---------------------------------------------------------------------------

class HudPainter {
  constructor(renderer) {
    this.r = renderer;
    this.overlays = new Map(); // "w×h" -> { vignette, hurt }
    this.mini = null;
  }

  resize() {
    const r = this.r;
    if (!r.w) return;
    this.overlays.clear();
    this.miniSize = LOW_MEM ? clamp(Math.min(r.w, r.h) * 0.27, 100, 170) : clamp(Math.min(r.w, r.h) * 0.24, 130, 220);
    if (this.game) this.buildMinimap();
  }

  overlaysFor(w, h) {
    const key = Math.round(w) + 'x' + Math.round(h);
    let o = this.overlays.get(key);
    if (o) return o;
    const make = (inner, outer) => {
      const c = makeCanvas(w, h), ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return c;
    };
    o = { vignette: make('rgba(8,10,6,0)', 'rgba(8,10,6,0.55)'), hurt: make('rgba(160,20,10,0)', 'rgba(160,20,10,0.6)') };
    this.overlays.set(key, o);
    return o;
  }

  setGame(game) {
    this.game = game;
    this.buildMinimap();
  }

  buildMinimap() {
    const m = this.game.map, b = m.biome;
    const S = this.miniSize;
    const sc = S / Math.max(m.w, m.h);
    this.miniScale = sc;
    this.miniW = m.w * sc; this.miniH = m.h * sc;
    const dpr = this.r.dpr;
    this.mini = makeCanvas(this.miniW * dpr, this.miniH * dpr);
    const ctx = this.mini.getContext('2d');
    ctx.scale(dpr * sc, dpr * sc);
    ctx.fillStyle = shade(b.ground[1], -0.35);
    ctx.fillRect(0, 0, m.w, m.h);
    ctx.strokeStyle = rgba(b.dirt, 0.5);
    ctx.lineWidth = 50;
    ctx.lineCap = 'round';
    for (const road of m.roads) {
      ctx.beginPath();
      road.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    for (const p of m.pools) {
      ctx.fillStyle = 'rgba(80,130,140,0.75)';
      ctx.beginPath();
      for (const [bx, by, rx, ry, a] of p.blobs) { ctx.moveTo(bx + rx * Math.cos(a), by + rx * Math.sin(a)); ctx.ellipse(bx, by, rx, ry, a, 0, TAU); }
      ctx.fill();
    }
    for (const o of m.obstacles) {
      ctx.fillStyle = o.kind === 'tree' ? rgba(b.tree[0], 0.9) : o.kind === 'hedge' ? 'rgba(80,120,60,0.9)' : o.kind === 'rock' ? shade(b.rock, -0.1) : o.kind === 'wreck' ? 'rgba(60,55,50,0.9)' : 'rgba(215,210,195,0.85)';
      if (o.shape === 'rect') ctx.fillRect(o.x, o.y, o.w, o.h);
      else { ctx.beginPath(); ctx.arc(o.cx, o.cy, o.kind === 'tree' ? o.canopy * 0.8 : o.r, 0, TAU); ctx.fill(); }
    }
  }

  accent(t) {
    return this.r.views.length > 1 ? PLAYER_COLORS[t.humanIndex] : t.color.ui;
  }

  // ---- per view ---------------------------------------------------------------------
  drawView(ctx, v, opts) {
    const r = this.r, g = this.game, player = v.player;
    const ov = this.overlaysFor(v.w, v.h);
    ctx.drawImage(ov.vignette, v.x, v.y, v.w, v.h);
    if (opts.demo) return;

    // Low-health / zone pulse.
    if (player && player.alive) {
      const hpf = player.hp / player.maxHp;
      const inZone = player.zoneT !== undefined && g.time - player.zoneT < 0.25;
      let a = hpf < 0.35 ? (0.35 - hpf) / 0.35 * (0.6 + 0.4 * Math.sin(r.time * 6)) : 0;
      if (g.time - player.lastHitT < 0.3) a = Math.max(a, 0.45);
      if (inZone) a = Math.max(a, 0.45 + 0.2 * Math.sin(r.time * 8));
      if (a > 0.01) {
        ctx.globalAlpha = clamp(a, 0, 1);
        ctx.drawImage(ov.hurt, v.x, v.y, v.w, v.h);
        ctx.globalAlpha = 1;
      }
    }

    this.drawIndicators(ctx, v, player);
    this.drawDamageDirs(ctx, v, player);
    if (player && player.alive) this.drawMissileWarnings(ctx, v, player);
    const lock = opts.locks && opts.locks[v.idx];
    if (lock && lock.alive && player && player.alive) this.drawLock(ctx, v, lock, player);
    if (opts.preview && opts.preview.tank.alive && r.views.length === 1) this.drawMissileMark(ctx, v, opts.preview.tank, opts.preview.label);
    if (opts.showCrosshair && r.views.length === 1) this.drawCrosshair(ctx, opts.mouse, player);
    if (opts.aimLine) this.drawAimLine(ctx, v, opts.aimLine);
  }

  // Arrows at the view edge pointing to off-screen objectives.
  drawIndicators(ctx, v, player) {
    const r = this.r, g = this.game;
    const marks = [];
    if (g.mode instanceof KOTHMode) {
      const k = g.mode;
      marks.push({ x: k.hill.x, y: k.hill.y, color: k.owner >= 0 ? g.teams[k.owner].color.ui : '#f3ecd6', icon: 'crown' });
    } else if (g.mode instanceof CTFMode) {
      for (const f of g.mode.flags) marks.push({ x: f.x, y: f.y, color: g.teams[f.team].color.ui, icon: 'flag' });
    } else if (g.mode instanceof BRMode && player && player.alive) {
      const z = g.mode.zone;
      if (dist(player.x, player.y, z.tx, z.ty) > z.tr) marks.push({ x: z.tx, y: z.ty, color: '#d9c2ff', icon: 'zone' });
    }
    // Escort: the convoy (and, for the escorting side, where it's heading).
    if (g.mode instanceof EscortMode && g.mode.convoy && g.mode.state === 'round') {
      const c = g.mode.convoy, col = g.teams[c.team].color.ui;
      if (c.alive) marks.push({ x: c.x, y: c.y, color: col, icon: 'convoy' });
      marks.push({ x: g.mode.extraction.x, y: g.mode.extraction.y, color: col, icon: 'zone' });
    }
    // Campaign Ace: intel always tracks the boss.
    if (g.ace && g.ace.alive && player && g.ace.team !== player.team) marks.push({ x: g.ace.x, y: g.ace.y, color: '#ff7a52', icon: 'ace' });
    // Juggernaut: hunters always know where the big tank is.
    if (g.mode instanceof JuggernautMode) {
      const j = g.mode.jug;
      if (j && j.alive && j !== player) marks.push({ x: j.x, y: j.y, color: '#ffc850', icon: 'crown' });
    }
    // Co-op: always show where your partner is (not in versus: they're the enemy).
    if (r.views.length > 1 && player && !g.settings.versus) {
      for (const p of g.players) if (p !== player && p.alive) marks.push({ x: p.x, y: p.y, color: this.accent(p), icon: 'mate', label: p.name });
    }
    const m = 46;
    for (const k of marks) {
      const s = r.worldToScreen(k.x, k.y, v);
      if (s.x > v.x + m && s.x < v.x + v.w - m && s.y > v.y + m && s.y < v.y + v.h - m) continue;
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      const dx = s.x - cx, dy = s.y - cy;
      const t = Math.min((v.w / 2 - m) / Math.abs(dx || 1e-6), (v.h / 2 - m) / Math.abs(dy || 1e-6));
      const x = cx + dx * t, y = cy + dy * t, a = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = 'rgba(12,14,12,0.7)';
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.fill();
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.save();
      ctx.rotate(a);
      ctx.fillStyle = k.color;
      ctx.beginPath(); ctx.moveTo(25, 0); ctx.lineTo(18, -6); ctx.lineTo(18, 6); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = k.color;
      if (k.icon === 'flag') {
        ctx.fillRect(-5, -8, 1.8, 16);
        ctx.beginPath(); ctx.moveTo(-3.2, -8); ctx.lineTo(7, -4.5); ctx.lineTo(-3.2, -1); ctx.closePath(); ctx.fill();
      } else if (k.icon === 'crown') {
        ctx.beginPath(); ctx.moveTo(-8, 5); ctx.lineTo(-9, -5); ctx.lineTo(-4, 0); ctx.lineTo(0, -7); ctx.lineTo(4, 0); ctx.lineTo(9, -5); ctx.lineTo(8, 5); ctx.closePath(); ctx.fill();
      } else if (k.icon === 'ace') {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 3.4 : 8; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
        ctx.closePath(); ctx.fill();
      } else if (k.icon === 'convoy') {
        ctx.fillRect(-8, -4, 11, 8);
        ctx.fillRect(4, -3.5, 5, 7);
      } else if (k.icon === 'mate') {
        ctx.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(k.label, 0, 1);
      } else {
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 7, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 2, 0, TAU); ctx.fill();
      }
      if (player && player.alive) {
        ctx.font = '600 11px "Barlow Condensed", "Arial Narrow", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(240,235,220,0.9)';
        ctx.fillText(Math.round(dist(player.x, player.y, k.x, k.y) / 10) + 'm', 0, 31);
      }
      ctx.restore();
    }
  }

  drawDamageDirs(ctx, v, player) {
    if (!player || !player.alive) return;
    const r = this.r, s = r.worldToScreen(player.x, player.y, v);
    ctx.save();
    ctx.lineCap = 'round';
    for (const d of r.fx.damageDirs) {
      if (d.player !== player) continue;
      ctx.strokeStyle = `rgba(255,70,50,${Math.min(1, d.life) * 0.85})`;
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(s.x, s.y, 78, d.a - 0.35, d.a + 0.35); ctx.stroke();
    }
    ctx.restore();
  }

  // Red chevrons around your tank pointing at missiles homing on you; they
  // pulse faster as the missile closes in.
  drawMissileWarnings(ctx, v, player) {
    const r = this.r, s = r.worldToScreen(player.x, player.y, v);
    for (const m of this.game.missiles) {
      if (m.target !== player || !m.alive) continue;
      const d = dist(player.x, player.y, m.x, m.y);
      const a = Math.atan2(m.y - player.y, m.x - player.x);
      const pulse = 0.55 + 0.45 * Math.sin(r.time * (8 + (1 - clamp(d / 900, 0, 1)) * 22));
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(a);
      ctx.fillStyle = `rgba(255,72,52,${pulse})`;
      for (const off of [0, 12]) {
        ctx.beginPath();
        ctx.moveTo(96 + off + 12, 0); ctx.lineTo(96 + off, -10); ctx.lineTo(100 + off, 0); ctx.lineTo(96 + off, 10);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      ctx.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(255,120,100,${0.6 + pulse * 0.4})`;
      ctx.fillText('MISSILE ' + Math.round(d / 10) + 'm', s.x + Math.cos(a) * 140, s.y + Math.sin(a) * 140);
    }
  }

  // Single player: amber diamond over the tank a right-click missile would lock onto.
  drawMissileMark(ctx, v, target, label) {
    const r = this.r, s = r.worldToScreen(target.x, target.y, v);
    const y = s.y - 62 * v.cam.zoom, k = 0.5 + 0.5 * Math.sin(r.time * 6);
    ctx.save();
    ctx.translate(s.x, y);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = `rgba(255,176,71,${0.6 + k * 0.4})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(-6, -6, 12, 12);
    ctx.restore();
    ctx.font = '700 10px "Barlow Condensed", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffb347';
    ctx.fillText(label, s.x, y - 13);
  }

  // Co-op aim assist: brackets around the tank your turret is locked onto.
  drawLock(ctx, v, target, player) {
    const r = this.r, s = r.worldToScreen(target.x, target.y, v), fx = r.fx;
    const col = this.accent(player);
    const hm = Math.max(fx.hitMarker[player.humanIndex] || 0, fx.killMarker[player.humanIndex] || 0);
    const size = (30 + Math.sin(r.time * 6) * 2 + hm * 6) * v.cam.zoom, L = 9;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.strokeStyle = hm > 0 ? '#ffffff' : col;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(dx * size, dy * (size - L)); ctx.lineTo(dx * size, dy * size); ctx.lineTo(dx * (size - L), dy * size);
    }
    ctx.stroke();
    // A charged missile (or artillery strike) will go to this target: mark it.
    const lsp = player.loadout.special;
    if (player.missileCharge >= this.game.specialCost(player) && (lsp === 'missile' || lsp === 'artillery' || lsp === 'airstrike')) {
      ctx.fillStyle = '#ffb347';
      ctx.font = '700 10px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(lsp === 'missile' ? 'MISSILE' : lsp === 'airstrike' ? 'AIRSTRIKE' : 'ARTILLERY', 0, -size - 6);
    }
    ctx.restore();
  }

  // Touch: a dotted sight line out of the gun so you can see where you're aiming.
  drawAimLine(ctx, v, p) {
    const r = this.r, s = r.worldToScreen(p.muzzleX, p.muzzleY, v), z = v.cam.zoom;
    const { range } = weaponBallistics(p.loadout.weapon), L = Math.min(range, 520) * z;
    const ca = Math.cos(p.turret), sa = Math.sin(p.turret);
    ctx.save();
    ctx.strokeStyle = 'rgba(244,239,226,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 9]);
    ctx.beginPath(); ctx.moveTo(s.x + ca * 14, s.y + sa * 14); ctx.lineTo(s.x + ca * L, s.y + sa * L); ctx.stroke();
    ctx.setLineDash([]);
    const ready = 1 - p.reload / p.reloadTime;
    ctx.strokeStyle = ready >= 1 ? 'rgba(244,239,226,0.85)' : 'rgba(232,181,74,0.8)';
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(s.x + ca * L, s.y + sa * L, 9, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(ready, 0, 1)); ctx.stroke();
    ctx.restore();
  }

  drawCrosshair(ctx, mouse, player) {
    if (!mouse) return;
    const fx = this.r.fx, { x, y } = mouse;
    const hitM = fx.hitMarker[0], killM = fx.killMarker[0];
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';
    const col = killM > 0 ? '#ff5a45' : '#f4efe2';
    // Outer ring with reload progress.
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(244,239,226,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.stroke();
    const mgLike = player && (player.loadout.weapon === 'mg' || player.loadout.weapon === 'flame');
    const ready = player && player.alive ? (mgLike ? (player.overheatT > 0 ? 0 : 1 - player.heat / 100) : 1 - player.reload / player.reloadTime) : 0;
    ctx.strokeStyle = ready >= 1 ? col : '#e8b54a';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(0, 0, 15, -Math.PI / 2, -Math.PI / 2 + TAU * ready); ctx.stroke();
    // Ticks.
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(dx * 6, dy * 6); ctx.lineTo(dx * 10, dy * 10); }
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, TAU); ctx.fill();
    // Special ready: four amber diamonds around the ring.
    if (player && player.alive && (player.missileCharge >= this.game.specialCost(player) || player.grenadeAmmo > 0)) {
      const k = 0.6 + 0.4 * Math.sin(this.r.time * 6);
      ctx.fillStyle = `rgba(255,176,71,${k})`;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * Math.PI / 2, x0 = Math.cos(a) * 21, y0 = Math.sin(a) * 21;
        ctx.beginPath(); ctx.moveTo(x0, y0 - 3); ctx.lineTo(x0 + 3, y0); ctx.lineTo(x0, y0 + 3); ctx.lineTo(x0 - 3, y0); ctx.closePath(); ctx.fill();
      }
    }
    // Hit marker.
    const hm = Math.max(hitM, killM);
    if (hm > 0) {
      const s = 8 + (1 - hm) * 6;
      ctx.strokeStyle = killM > 0 ? `rgba(255,80,60,${hm})` : `rgba(255,255,255,${hm})`;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { ctx.moveTo(dx * s, dy * s); ctx.lineTo(dx * (s + 7), dy * (s + 7)); }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- shared -------------------------------------------------------------------------
  drawShared(ctx, opts) {
    const r = this.r;
    if (r.views.length > 1) {
      const v = r.views[1];
      ctx.fillStyle = '#0b0d0a';
      ctx.fillRect(v.x - 4, 0, 4, r.h);
      ctx.fillStyle = 'rgba(236,230,214,0.12)';
      ctx.fillRect(v.x - 2.5, 0, 1, r.h);
    }
    if (!opts.demo) this.drawMinimap(ctx);
  }

  drawMinimap(ctx) {
    const r = this.r, g = this.game, m = g.map, sc = this.miniScale;
    const pad = 16, W = this.miniW, H = this.miniH;
    const coop = r.views.length > 1;
    const x0 = coop ? (r.w - W) / 2 : r.w - W - pad, y0 = r.touchUI ? (r.w <= 700 ? 72 : pad + 40) : r.h - H - pad;
    ctx.save();
    ctx.fillStyle = 'rgba(12,14,11,0.72)';
    roundRectPath(ctx, x0 - 6, y0 - 6, W + 12, H + 12, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,220,190,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath(); ctx.rect(x0, y0, W, H); ctx.clip();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.mini, x0, y0, W, H);
    ctx.globalAlpha = 1;
    const P = (x, y) => [x0 + x * sc, y0 + y * sc];

    if (g.mode instanceof KOTHMode) {
      const k = g.mode, [hx, hy] = P(k.hill.x, k.hill.y);
      ctx.strokeStyle = k.contested ? '#ffd35a' : k.owner >= 0 ? g.teams[k.owner].color.ui : '#f3ecd6';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, k.hill.r * sc, 0, TAU); ctx.stroke();
    }
    if (m.layout === 'teams') {
      m.spawnCenters.forEach((cs, t) => cs.forEach(c => {
        const [bx, by] = P(c.x + (t === 0 ? 20 : -20), c.y);
        ctx.fillStyle = rgba(g.teams[t].color.ui, 0.25);
        ctx.fillRect(bx - 150 * sc, by - 165 * sc, 300 * sc, 330 * sc);
      }));
    }
    if (g.mode instanceof BRMode) {
      const z = g.mode.zone, [zx, zy] = P(z.x, z.y);
      ctx.fillStyle = 'rgba(110,50,190,0.35)';
      ctx.beginPath(); ctx.rect(x0, y0, W, H); ctx.arc(zx, zy, Math.max(0.5, z.r * sc), 0, TAU, true); ctx.fill('evenodd');
      ctx.strokeStyle = '#e4d2ff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(zx, zy, Math.max(0.5, z.r * sc), 0, TAU); ctx.stroke();
      const [tx, ty] = P(z.tx, z.ty);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(tx, ty, Math.max(0.5, z.tr * sc), 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Enemies show when you or a teammate can see them.
    const humans = g.players.filter(p => p.alive);
    const myTeam = g.players.length ? g.players[0].team : -1;
    // Smoke clouds.
    for (const s of g.smokes) {
      const [x, y] = P(s.x, s.y);
      ctx.fillStyle = 'rgba(200,200,195,0.45)';
      ctx.beginPath(); ctx.arc(x, y, s.r * sc * 0.85, 0, TAU); ctx.fill();
    }
    // Escort: remaining route, extraction and the convoy itself.
    if (g.mode instanceof EscortMode && g.mode.route) {
      const m2 = g.mode, col = g.teams[m2.defenders].color.ui;
      ctx.strokeStyle = rgba(col, 0.6);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      m2.route.forEach((p, i) => { const [x, y] = P(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      ctx.setLineDash([]);
      const [ex, ey] = P(m2.extraction.x, m2.extraction.y);
      ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(ex, ey, 5, 0, TAU); ctx.stroke();
    }
    // Versus: both players share this screen, so everything is shown.
    const seeR = g.night ? 420 : 750;
    const spotted = t => {
      if (t.isConvoy || t === g.ace) return true;
      if (g.inSmoke(t.x, t.y)) return false;
      if (g.settings.versus || g.mode instanceof JuggernautMode) return true;
      for (const a of g.tanks) if (a.alive && a.team === myTeam && dist2(a.x, a.y, t.x, t.y) < seeR * seeR) return true;
      return false;
    };
    for (const t of g.tanks) {
      if (!t.alive || t.isPlayer) continue;
      const ally = t.team === myTeam;
      if (!ally && myTeam >= 0 && !spotted(t)) continue;
      const [x, y] = P(t.x, t.y);
      if (t.isConvoy) {
        ctx.save();
        ctx.translate(x, y); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = t.color.ui;
        ctx.fillRect(-4, -4, 8, 8);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1; ctx.strokeRect(-4, -4, 8, 8);
        ctx.restore();
        continue;
      }
      if (t.jug || t.ace) {
        ctx.fillStyle = t.ace ? '#ff7a52' : '#ffc850';
        ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke();
        continue;
      }
      ctx.fillStyle = t.color.ui;
      ctx.beginPath(); ctx.arc(x, y, ally ? 2.6 : 3, 0, TAU); ctx.fill();
      if (!ally) { ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke(); }
    }
    if (g.mode instanceof CTFMode) {
      for (const f of g.mode.flags) {
        const [x, y] = P(f.x, f.y);
        ctx.fillStyle = '#f1ead8';
        ctx.fillRect(x - 1, y - 7, 1.5, 9);
        ctx.fillStyle = g.teams[f.team].color.ui;
        ctx.beginPath(); ctx.moveTo(x + 0.5, y - 7); ctx.lineTo(x + 7, y - 4.5); ctx.lineTo(x + 0.5, y - 2); ctx.closePath(); ctx.fill();
      }
    }
    for (const m of g.missiles) {
      const [x, y] = P(m.x, m.y);
      ctx.fillStyle = '#ff5a40';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    // View rectangles, then player arrows on top.
    for (const v of r.views) {
      const vr = r.viewRect(0, v);
      const [vx, vy] = P(vr.x0, vr.y0);
      ctx.strokeStyle = v.player && coop ? rgba(this.accent(v.player), 0.5) : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(vx, vy, (vr.x1 - vr.x0) * sc, (vr.y1 - vr.y0) * sc);
    }
    for (const p of humans) {
      const [px, py] = P(p.x, p.y);
      if (p.jug) { ctx.strokeStyle = '#ffc850'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, 7, 0, TAU); ctx.stroke(); }
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(p.angle);
      ctx.fillStyle = coop ? this.accent(p) : '#ffffff';
      ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-5, -5); ctx.lineTo(-2, 0); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}
