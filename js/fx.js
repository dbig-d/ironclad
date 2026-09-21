'use strict';
// ---------------------------------------------------------------------------
// Visual effects: pooled particles, floating numbers, wrecks and camera shake.
// Consumes game events; purely cosmetic.
// ---------------------------------------------------------------------------

const P_SMOKE = 0, P_FIRE = 1, P_SPARK = 2, P_DEBRIS = 3, P_DUST = 4, P_FLASH = 5, P_RING = 6, P_EMBER = 7, P_REPAIR = 8;

class FX {
  constructor(terrain) {
    FxArt.init();
    this.terrain = terrain;
    this.parts = [];
    this.pool = [];
    this.numbers = [];
    this.wrecks = [];
    this.flashes = [];   // muzzle flashes (sprite, short lived)
    this.lights = [];    // additive light pools
    this.shake = [0, 0];   // per split-screen view
    this.viewers = [];     // [{ cam, player }] set by the renderer each frame
    this.trackState = new Map();
    this.hitMarker = [0, 0];  // per human player
    this.killMarker = [0, 0];
    this.damageDirs = [];
    this.density = 1;                       // set by the renderer's quality tier
    this.maxParts = LOW_MEM ? 900 : 1800;
    this.tracers = [];   // anti-air tracer lines
    this.markers = [];   // airstrike marking smoke
  }

  spawn(type, x, y, vx, vy, life, size, extra) {
    if (this.parts.length > this.maxParts) return null;
    // Lower quality tiers thin out the cosmetic smoke, dust, sparks and debris.
    if (this.density < 1 && type <= P_DUST && type !== P_FIRE && Math.random() > this.density) return null;
    const p = this.pool.pop() || {};
    p.type = type; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.max = life; p.size = size;
    p.rot = rand(0, TAU); p.vr = rand(-4, 4);
    p.grow = 1; p.drag = 2; p.alpha = 1; p.tint = null; p.z = 0; p.vz = 0;
    if (extra) Object.assign(p, extra);
    this.parts.push(p);
    return p;
  }

  // Shake every view near (x, y), or only the view following onlyTank.
  addShake(amount, x, y, onlyTank) {
    this.viewers.forEach((v, i) => {
      if (onlyTank && v.player !== onlyTank) return;
      let a = amount;
      if (x !== undefined) a *= clamp(1 - dist(x, y, v.cam.x, v.cam.y) / 1100, 0, 1);
      this.shake[i] = Math.min(1, this.shake[i] + a);
    });
  }

  // ---- event handlers --------------------------------------------------------------
  handle(e) {
    switch (e.type) {
      case 'shot': this.muzzle(e); break;
      case 'impact': this.impact(e); break;
      case 'hit': this.hit(e); break;
      case 'kill': this.explode(e.victim); break;
      case 'respawn': this.respawnFx(e.tank); break;
      case 'missile_launch': this.missileLaunch(e); break;
      case 'missile_boom': this.missileBoom(e); break;
      case 'mine_boom': this.blast(e.x, e.y, 0.9); break;
      case 'arty_boom': this.blast(e.x, e.y, 1); break;
      case 'arty_launch': this.puff(e.x, e.y, 5, 0.45); break;
      case 'mine_drop': this.puff(e.x, e.y, 3, 0.3); break;
      case 'smoke': this.smokeBurst(e); break;
      case 'levelup': this.levelFx(e.tank, '#ffc850'); break;
      case 'upgrade': this.levelFx(e.tank, '#8fd0ff'); break;
      case 'overheat': this.puff(e.tank.muzzleX, e.tank.muzzleY, 6, 0.5); break;
      case 'ram': this.ram(e); break;
      case 'repair_kit': this.levelFx(e.tank, '#7dffa0'); break;
      case 'overdrive': this.overdrive(e.tank); break;
      case 'grenade_launch':
        this.flashes.push({ x: e.x, y: e.y, a: e.tank.turret, life: 0.06, max: 0.06, s: 0.5 });
        this.puff(e.x, e.y, 3, 0.35);
        break;
      case 'grenade_bounce': {
        const p = this.spawn(P_DUST, e.x, e.y, rand(-20, 20), rand(-20, 20), rand(0.4, 0.7), rand(4, 6));
        if (p) { p.grow = 2; p.alpha = 0.35; p.tint = this.terrain.biome.id === 'snow' ? 'snow' : 'dust'; }
        break;
      }
      case 'grenade_boom': this.blast(e.x, e.y, 0.8); break;
      case 'salvo_launch': this.salvoLaunch(e); break;
      case 'flak_on': this.spawn(P_RING, e.tank.x, e.tank.y, 0, 0, 0.5, 16, { tint: 'gold' }); break;
      case 'intercept': this.intercept(e); break;
      case 'air_call': this.markers.push({ s: e.strike || { x: e.x, y: e.y }, life: AIRSTRIKE.delay + 1.2 }); break;
      case 'air_boom': this.blast(e.x, e.y, 1.3); break;
    }
  }

  salvoLaunch(e) {
    const ca = Math.cos(e.angle), sa = Math.sin(e.angle);
    this.flashes.push({ x: e.x + ca * 4, y: e.y + sa * 4, a: e.angle, life: 0.06, max: 0.06, s: 0.55 });
    this.lights.push({ x: e.x, y: e.y, r: 70, life: 0.12, max: 0.12, c: 'fire' });
    for (let i = 0; i < 5; i++) {
      const a = e.angle + Math.PI + rand(-0.5, 0.5), sp = rand(60, 180);
      const p = this.spawn(P_SMOKE, e.x - ca * 10, e.y - sa * 10, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 0.9), rand(6, 9));
      if (p) { p.grow = 2.4; p.drag = 3; p.alpha = 0.45; p.tint = 'smoke'; }
    }
    if (e.tank.isPlayer) this.addShake(0.08, undefined, undefined, e.tank);
  }

  // Anti-air rounds: a tracer out to the target and a black flak burst where it dies.
  intercept(e) {
    this.tracers.push({ x1: e.fx, y1: e.fy, x2: e.x, y2: e.y, life: 0.1, max: 0.1 });
    this.flashes.push({ x: e.fx, y: e.fy, a: Math.atan2(e.y - e.fy, e.x - e.fx), life: 0.05, max: 0.05, s: 0.4 });
    this.lights.push({ x: e.x, y: e.y, r: e.kill ? 70 : 40, life: 0.15, max: 0.15, c: 'fire' });
    if (e.kill) this.spawn(P_FLASH, e.x, e.y, 0, 0, 0.12, 20);
    for (let i = 0; i < 4; i++) {
      const p = this.spawn(P_SMOKE, e.x + rand(-6, 6), e.y + rand(-6, 6), rand(-25, 25), rand(-25, 25), rand(0.8, 1.3), rand(6, 10));
      if (p) { p.grow = 2.2; p.drag = 2.5; p.alpha = 0.7; p.tint = 'dark'; }
    }
    for (let i = 0; i < 6; i++) {
      const a = rand(0, TAU), sp = rand(120, 300);
      this.spawn(P_SPARK, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.1, 0.25), 1.2);
    }
  }

  ram(e) {
    this.lights.push({ x: e.x, y: e.y, r: 80, life: 0.18, max: 0.18, c: 'fire' });
    for (let i = 0; i < 16; i++) {
      const a = e.angle + rand(-1.4, 1.4), sp = rand(150, 420);
      this.spawn(P_SPARK, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.15, 0.35), rand(1.3, 2.2));
    }
    for (let i = 0; i < 6; i++) {
      const a = rand(0, TAU), sp = rand(30, 110);
      const p = this.spawn(P_DUST, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.6, 1), rand(8, 12));
      if (p) { p.grow = 2.2; p.alpha = 0.45; p.tint = this.terrain.biome.id === 'snow' ? 'snow' : 'dust'; }
    }
    this.addShake(0.4, e.x, e.y);
  }

  overdrive(t) {
    const ca = Math.cos(t.angle), sa = Math.sin(t.angle);
    for (let i = 0; i < 12; i++) {
      const a = t.angle + Math.PI + rand(-0.5, 0.5), sp = rand(60, 200);
      const p = this.spawn(P_SMOKE, t.x - ca * 26, t.y - sa * 26, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.6, 1.1), rand(7, 11));
      if (p) { p.grow = 2.6; p.drag = 3; p.alpha = 0.55; p.tint = 'dark'; }
    }
    this.spawn(P_RING, t.x, t.y, 0, 0, 0.5, 16, { tint: 'gold' });
    if (t.isPlayer) this.addShake(0.2, undefined, undefined, t);
  }

  muzzle(e) {
    if (e.weapon === 'flame') {
      if (Math.random() < 0.3) this.lights.push({ x: e.x, y: e.y, r: 70, life: 0.1, max: 0.1, c: 'fire' });
      return;
    }
    if (e.weapon === 'coaxmg') {
      this.flashes.push({ x: e.x, y: e.y, a: e.angle, life: 0.035, max: 0.035, s: 0.35 });
      return;
    }
    if (e.weapon === 'mg') {
      // Small, quick flashes for the machine gun.
      this.flashes.push({ x: e.x, y: e.y, a: e.angle, life: 0.04, max: 0.04, s: 0.45 });
      if (Math.random() < 0.4) {
        const p = this.spawn(P_SMOKE, e.x, e.y, Math.cos(e.angle) * 60, Math.sin(e.angle) * 60, 0.4, 4);
        if (p) { p.grow = 2; p.alpha = 0.25; p.tint = 'smoke'; }
      }
      if (e.tank.isPlayer) this.addShake(0.03, undefined, undefined, e.tank);
      return;
    }
    if (e.muzzles && e.muzzles.length > 1) {
      for (const [x, y, a] of e.muzzles.slice(1)) this.flashes.push({ x: x + Math.cos(a) * 6, y: y + Math.sin(a) * 6, a, life: 0.08, max: 0.08, s: 0.9 });
    }
    if (e.weapon === 'bazooka' || e.weapon === 'wire') {
      const t = e.tank, ca2 = Math.cos(e.angle), sa2 = Math.sin(e.angle);
      for (let i = 0; i < 8; i++) {
        const a = e.angle + Math.PI + rand(-0.5, 0.5), sp = rand(60, 200);
        const p = this.spawn(P_SMOKE, t.x - ca2 * 14, t.y - sa2 * 14, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.6, 1), rand(7, 11));
        if (p) { p.grow = 2.4; p.drag = 3; p.alpha = 0.45; p.tint = 'smoke'; }
      }
    }
    const ca = Math.cos(e.angle), sa = Math.sin(e.angle), long = e.weapon === 'longgun' || e.weapon === 'hesh';
    this.flashes.push({ x: e.x + ca * 6, y: e.y + sa * 6, a: e.angle, life: long ? 0.1 : 0.08, max: long ? 0.1 : 0.08, s: rand(0.9, 1.15) * (long ? 1.35 : 1) });
    this.lights.push({ x: e.x, y: e.y, r: long ? 150 : 110, life: 0.12, max: 0.12, c: 'glow' });
    for (let i = 0; i < 6; i++) {
      const sp = rand(40, 170), a = e.angle + rand(-0.5, 0.5);
      const p = this.spawn(P_SMOKE, e.x + ca * 4, e.y + sa * 4, Math.cos(a) * sp + e.tank.vx * 0.5, Math.sin(a) * sp + e.tank.vy * 0.5, rand(0.5, 0.9), rand(7, 12));
      if (p) { p.grow = 2.4; p.drag = 3.5; p.alpha = 0.45; p.tint = 'smoke'; }
    }
    // Side blast from the muzzle brake.
    for (const s of [-1, 1]) {
      const a = e.angle + s * 1.35;
      const p = this.spawn(P_SMOKE, e.x, e.y, Math.cos(a) * 120, Math.sin(a) * 120, 0.4, 6);
      if (p) { p.grow = 2.2; p.drag = 5; p.alpha = 0.35; p.tint = 'smoke'; }
    }
    if (e.tank.isPlayer) this.addShake(long ? 0.24 : 0.16, undefined, undefined, e.tank);
  }

  impact(e) {
    if (e.kind === 'flame') {
      const p = this.spawn(P_FIRE, e.x, e.y, rand(-20, 20), rand(-20, 20), rand(0.2, 0.35), rand(8, 12));
      if (p) p.grow = 1.8;
      if (Math.random() < 0.4) this.puff(e.x, e.y, 1, 0.35);
      return;
    }
    if (e.kind === 'hesh') {
      // Squash-head: the charge splats flat and bursts.
      this.blast(e.x, e.y, 0.5);
      return;
    }
    if (e.kind === 'fizzle') {
      for (let i = 0; i < 4; i++) {
        const p = this.spawn(P_DUST, e.x, e.y, rand(-30, 30), rand(-30, 30), rand(0.5, 0.9), rand(6, 10));
        if (p) { p.grow = 1.8; p.alpha = 0.35; p.tint = this.terrain.biome.id === 'snow' ? 'snow' : 'dust'; }
      }
      return;
    }
    if (e.small) {
      for (let i = 0; i < 4; i++) {
        const a = e.angle + rand(-1.2, 1.2), sp = rand(100, 260);
        this.spawn(P_SPARK, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.08, 0.18), 1);
      }
      return;
    }
    if (e.kind === 'shield') {
      this.lights.push({ x: e.x, y: e.y, r: 60, life: 0.2, max: 0.2, c: 'blue' });
      for (let i = 0; i < 8; i++) {
        const a = e.angle + rand(-1, 1), sp = rand(120, 280);
        const p = this.spawn(P_SPARK, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.15, 0.3), 1.5);
        if (p) p.tint = 'blue';
      }
      return;
    }
    // Wall hit: sparks, chips, dust puff, small scorch.
    this.lights.push({ x: e.x, y: e.y, r: 70, life: 0.15, max: 0.15, c: 'fire' });
    for (let i = 0; i < 10; i++) {
      const a = e.angle + rand(-1.2, 1.2), sp = rand(120, 380);
      this.spawn(P_SPARK, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.12, 0.3), rand(1, 2));
    }
    for (let i = 0; i < 5; i++) {
      const a = e.angle + rand(-1, 1), sp = rand(30, 110);
      const p = this.spawn(P_SMOKE, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 1), rand(6, 10));
      if (p) { p.grow = 2.2; p.alpha = 0.5; p.tint = this.terrain.biome.id === 'snow' ? 'snow' : 'dust'; }
    }
    for (let i = 0; i < 4; i++) {
      const a = e.angle + rand(-1, 1), sp = rand(60, 200);
      const p = this.spawn(P_DEBRIS, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.4, 0.8), rand(1.5, 3));
      if (p) { p.tint = '#5a5550'; p.vz = rand(60, 140); }
    }
    this.terrain.scorch(e.x, e.y, 10, 0.45);
  }

  // Continuous fire (flames, burning) merges into one climbing number per target.
  mergeNumber(e) {
    const t = e.target, byHuman = e.shooter && e.shooter.isPlayer;
    let n = this.numbers.find(q => q.target === t && q.merge && q.life > 0.55);
    if (!n) {
      n = { x: t.x + rand(-10, 10), y: t.y - 58, vy: -40, life: 1, max: 1, value: 0, merge: true, target: t,
        color: byHuman ? '#ffb347' : t.isPlayer ? '#ff7a6a' : '#ffd0a0', mine: byHuman || t.isPlayer, label: '' };
      this.numbers.push(n);
    }
    n.value += e.dmg;
    n.text = '-' + Math.round(n.value);
    n.life = Math.max(n.life, 0.9);
  }

  hit(e) {
    const t = e.target, s = e.shooter;
    if (e.kind === 'burn' || e.kind === 'flame') {
      const p = this.spawn(P_FIRE, e.x + rand(-8, 8), e.y + rand(-8, 8), rand(-20, 20), rand(-30, 0), rand(0.2, 0.4), rand(6, 10));
      if (p) p.grow = 1.6;
      this.mergeNumber(e);
      if (s && s.isPlayer) this.hitMarker[s.humanIndex] = Math.max(this.hitMarker[s.humanIndex], 0.5);
      if (s && s.isPlayer && e.lethal) this.killMarker[s.humanIndex] = 1;
      if (t.isPlayer && e.kind === 'flame' && s) this.damageDirs.push({ a: Math.atan2(s.y - t.y, s.x - t.x), life: 0.6, player: t });
      return;
    }
    this.lights.push({ x: e.x, y: e.y, r: 90, life: 0.18, max: 0.18, c: 'fire' });
    for (let i = 0; i < 14; i++) {
      const a = e.angle + Math.PI + rand(-1.1, 1.1), sp = rand(150, 420);
      this.spawn(P_SPARK, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.15, 0.35), rand(1.2, 2.2));
    }
    for (let i = 0; i < 3; i++) {
      const p = this.spawn(P_FIRE, e.x, e.y, rand(-40, 40), rand(-40, 40), rand(0.15, 0.3), rand(7, 12));
      if (p) p.grow = 1.8;
    }
    for (let i = 0; i < 3; i++) {
      const p = this.spawn(P_SMOKE, e.x, e.y, rand(-30, 30), rand(-30, 30), rand(0.6, 1), rand(7, 11));
      if (p) { p.grow = 2; p.alpha = 0.5; p.tint = 'dark'; }
    }
    const byHuman = s && s.isPlayer, direct = e.quality >= 0.85, glancing = e.quality <= 0.15;
    this.numbers.push({
      x: t.x + rand(-10, 10), y: t.y - 58, vy: -55, life: 1, max: 1, text: '-' + Math.round(e.dmg),
      big: e.lethal || (byHuman && direct),
      label: e.kind === 'ram' ? 'RAMMED' : e.deflect === 1 && (byHuman || t.isPlayer) ? 'ANGLED' : e.deflect === -1 && byHuman ? 'REAR HIT' : byHuman ? (direct ? 'DIRECT HIT' : glancing ? 'GLANCING' : '') : '',
      color: byHuman ? (direct ? '#ffb347' : glancing ? '#d8d2c0' : '#ffe28a') : t.isPlayer ? '#ff7a6a' : '#ffffff',
      mine: byHuman || t.isPlayer,
    });
    if (byHuman) {
      this.hitMarker[s.humanIndex] = 1;
      if (e.lethal) this.killMarker[s.humanIndex] = 1;
    }
    if (t.isPlayer) {
      this.addShake(0.35, undefined, undefined, t);
      if (s) this.damageDirs.push({ a: Math.atan2(s.y - t.y, s.x - t.x), life: 1.2, player: t });
    }
  }

  explode(t) {
    const { x, y } = t;
    this.lights.push({ x, y, r: 260, life: 0.5, max: 0.5, c: 'fire' });
    this.spawn(P_RING, x, y, 0, 0, 0.45, 20, { grow: 0 });
    this.spawn(P_FLASH, x, y, 0, 0, 0.22, 90);
    for (let i = 0; i < 22; i++) {
      const a = rand(0, TAU), sp = rand(30, 190);
      const p = this.spawn(P_FIRE, x + rand(-8, 8), y + rand(-8, 8), Math.cos(a) * sp, Math.sin(a) * sp, rand(0.35, 0.8), rand(10, 20));
      if (p) { p.grow = 1.6; p.drag = 3.5; }
    }
    for (let i = 0; i < 20; i++) {
      const a = rand(0, TAU), sp = rand(20, 120);
      const p = this.spawn(P_SMOKE, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(1.4, 2.6), rand(14, 24));
      if (p) { p.grow = 2.6; p.drag = 2.2; p.alpha = 0.7; p.tint = 'dark'; }
    }
    for (let i = 0; i < 26; i++) {
      const a = rand(0, TAU), sp = rand(200, 560);
      this.spawn(P_SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.3, 0.7), rand(1.5, 2.6));
    }
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), sp = rand(80, 320);
      const p = this.spawn(P_DEBRIS, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.9, 1.8), rand(2.5, 5));
      if (p) { p.tint = rand() < 0.5 ? t.color.dark : '#2b2724'; p.vz = rand(150, 380); }
    }
    this.terrain.scorch(x, y, 56, 0.9);
    this.terrain.crater(x, y, 18, 0.45);
    this.wrecks.push({ x, y, a: t.angle, ta: t.turret + rand(-0.6, 0.6), life: 14, max: 14, burn: 6 });
    this.addShake(0.75, x, y);
  }

  missileLaunch(e) {
    const ca = Math.cos(e.angle), sa = Math.sin(e.angle), t = e.tank;
    this.flashes.push({ x: e.x + ca * 4, y: e.y + sa * 4, a: e.angle, life: 0.1, max: 0.1, s: 0.8 });
    this.lights.push({ x: e.x, y: e.y, r: 130, life: 0.2, max: 0.2, c: 'fire' });
    // Backblast out of the rear of the turret.
    for (let i = 0; i < 10; i++) {
      const a = e.angle + Math.PI + rand(-0.6, 0.6), sp = rand(60, 220);
      const p = this.spawn(P_SMOKE, t.x - ca * 12, t.y - sa * 12, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.6, 1.1), rand(8, 13));
      if (p) { p.grow = 2.6; p.drag = 3; p.alpha = 0.5; p.tint = 'smoke'; }
    }
    if (t.isPlayer) this.addShake(0.22, undefined, undefined, t);
  }

  missileBoom(e) {
    if (e.kind === 'salvo') { this.blast(e.x, e.y, 0.72); return; }
    if (e.rocket) { this.blast(e.x, e.y, 0.7); return; }
    const { x, y } = e;
    this.lights.push({ x, y, r: 230, life: 0.4, max: 0.4, c: 'fire' });
    this.spawn(P_RING, x, y, 0, 0, 0.4, 16, { grow: 0 });
    this.spawn(P_FLASH, x, y, 0, 0, 0.18, 70);
    for (let i = 0; i < 18; i++) {
      const a = rand(0, TAU), sp = rand(40, 220);
      const p = this.spawn(P_FIRE, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.3, 0.65), rand(9, 16));
      if (p) { p.grow = 1.7; p.drag = 3.5; }
    }
    for (let i = 0; i < 12; i++) {
      const a = rand(0, TAU), sp = rand(20, 110);
      const p = this.spawn(P_SMOKE, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(1.1, 2), rand(12, 20));
      if (p) { p.grow = 2.4; p.drag = 2.4; p.alpha = 0.65; p.tint = 'dark'; }
    }
    for (let i = 0; i < 22; i++) {
      const a = rand(0, TAU), sp = rand(220, 520);
      this.spawn(P_SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.25, 0.55), rand(1.4, 2.4));
    }
    for (let i = 0; i < 8; i++) {
      const a = rand(0, TAU), sp = rand(80, 260);
      const p = this.spawn(P_DEBRIS, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.6, 1.2), rand(1.5, 3.5));
      if (p) { p.tint = '#3a3632'; p.vz = rand(120, 300); }
    }
    this.terrain.scorch(x, y, 44, 0.8);
    this.terrain.crater(x, y, 14, 0.4);
    this.addShake(0.55, x, y);
  }

  // Generic explosion scaled by k (mines, artillery, bazooka rockets).
  blast(x, y, k) {
    this.lights.push({ x, y, r: 200 * k, life: 0.35, max: 0.35, c: 'fire' });
    this.spawn(P_RING, x, y, 0, 0, 0.35, 12 * k, { grow: 0 });
    this.spawn(P_FLASH, x, y, 0, 0, 0.16, 60 * k);
    for (let i = 0; i < 14 * k; i++) {
      const a = rand(0, TAU), sp = rand(40, 200) * k;
      const p = this.spawn(P_FIRE, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.3, 0.6), rand(8, 14) * k);
      if (p) { p.grow = 1.7; p.drag = 3.5; }
    }
    for (let i = 0; i < 10 * k; i++) {
      const a = rand(0, TAU), sp = rand(20, 100);
      const p = this.spawn(P_SMOKE, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(1, 1.8), rand(10, 18) * k);
      if (p) { p.grow = 2.4; p.drag = 2.4; p.alpha = 0.6; p.tint = 'dark'; }
    }
    for (let i = 0; i < 16 * k; i++) {
      const a = rand(0, TAU), sp = rand(200, 480);
      this.spawn(P_SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.2, 0.45), rand(1.2, 2.2));
    }
    for (let i = 0; i < 6 * k; i++) {
      const a = rand(0, TAU), sp = rand(80, 240);
      const p = this.spawn(P_DEBRIS, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 1), rand(1.5, 3));
      if (p) { p.tint = '#3a3632'; p.vz = rand(120, 280); }
    }
    this.terrain.scorch(x, y, 40 * k, 0.8);
    this.terrain.crater(x, y, 13 * k, 0.4);
    this.addShake(0.45 * k, x, y);
  }

  puff(x, y, n, alpha) {
    for (let i = 0; i < n; i++) {
      const p = this.spawn(P_SMOKE, x, y, rand(-40, 40), rand(-40, 40), rand(0.5, 0.9), rand(6, 10));
      if (p) { p.grow = 2.2; p.drag = 3; p.alpha = alpha; p.tint = 'smoke'; }
    }
  }

  smokeBurst(e) {
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), sp = rand(80, 260);
      const p = this.spawn(P_SMOKE, e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.8, 1.4), rand(12, 20));
      if (p) { p.grow = 3; p.drag = 3; p.alpha = 0.55; p.tint = 'smoke'; }
    }
  }

  levelFx(t, col) {
    if (!t.alive) return;
    this.spawn(P_RING, t.x, t.y, 0, 0, 0.7, 20, { tint: col === '#ffc850' ? 'gold' : 'blue' });
    this.lights.push({ x: t.x, y: t.y, r: 140, life: 0.6, max: 0.6, c: 'glow' });
    for (let i = 0; i < 16; i++) {
      const a = rand(0, TAU), sp = rand(60, 180);
      const p = this.spawn(P_REPAIR, t.x + Math.cos(a) * 10, t.y + Math.sin(a) * 10, Math.cos(a) * sp, Math.sin(a) * sp - 30, rand(0.6, 1), rand(3, 4.5));
      if (p) { p.drag = 2.5; p.tint = col; }
    }
  }

  respawnFx(t) {
    this.spawn(P_RING, t.x, t.y, 0, 0, 0.6, 10, { tint: 'blue' });
    this.lights.push({ x: t.x, y: t.y, r: 120, life: 0.5, max: 0.5, c: 'blue' });
  }

  // ---- per-frame --------------------------------------------------------------------
  update(dt, game) {
    const biome = this.terrain.biome;
    for (const p of this.parts) {
      p.life -= dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.type === P_SMOKE) { p.vx += 6 * dt; p.vy -= 4 * dt; }
      if (p.type === P_DEBRIS) {
        p.vz -= 900 * dt; p.z += p.vz * dt;
        if (p.z < 0) { p.z = 0; p.vz *= -0.35; p.vx *= 0.6; p.vy *= 0.6; p.vr *= 0.5; }
      }
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      if (this.parts[i].life <= 0) { this.pool.push(this.parts[i]); this.parts[i] = this.parts[this.parts.length - 1]; this.parts.pop(); }
    }
    for (const n of this.numbers) { n.life -= dt; n.y += n.vy * dt; n.vy *= Math.exp(-3 * dt); }
    this.numbers = this.numbers.filter(n => n.life > 0);
    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter(f => f.life > 0);
    for (const l of this.lights) l.life -= dt;
    this.lights = this.lights.filter(l => l.life > 0);
    for (const tr of this.tracers) tr.life -= dt;
    if (this.tracers.length) this.tracers = this.tracers.filter(tr => tr.life > 0);
    // Airstrike marking smoke: a column of red smoke on the target until the bombs land.
    for (const m of this.markers) {
      m.life -= dt;
      if (Math.random() < dt * 14) {
        const p = this.spawn(P_SMOKE, m.s.x + rand(-4, 4), m.s.y + rand(-4, 4), rand(4, 22), rand(-26, -8), rand(1.2, 2), rand(6, 10));
        if (p) { p.grow = 3; p.drag = 0.8; p.alpha = 0.6; p.tint = 'marker'; }
      }
    }
    if (this.markers.length) this.markers = this.markers.filter(m => m.life > 0);
    for (const d of this.damageDirs) d.life -= dt;
    this.damageDirs = this.damageDirs.filter(d => d.life > 0);
    for (let i = 0; i < 2; i++) {
      this.hitMarker[i] = Math.max(0, this.hitMarker[i] - dt * 5);
      this.killMarker[i] = Math.max(0, this.killMarker[i] - dt * 1.6);
      this.shake[i] = Math.max(0, this.shake[i] - dt * 1.8);
    }

    // Wrecks burn, then smoulder, then fade.
    for (const w of this.wrecks) {
      w.life -= dt; w.burn -= dt;
      if (w.burn > 0 && Math.random() < dt * 22) {
        const p = this.spawn(P_FIRE, w.x + rand(-10, 10), w.y + rand(-8, 8), rand(-10, 10), rand(-30, -10), rand(0.3, 0.6), rand(6, 11));
        if (p) { p.grow = 0.6; p.drag = 1; }
      }
      if (w.life > 3 && Math.random() < dt * (w.burn > 0 ? 14 : 5)) {
        const p = this.spawn(P_SMOKE, w.x + rand(-8, 8), w.y + rand(-8, 8), rand(5, 25), rand(-25, -5), rand(1.5, 2.8), rand(8, 13));
        if (p) { p.grow = 3; p.drag = 0.6; p.alpha = w.burn > 0 ? 0.55 : 0.3; p.tint = 'dark'; }
      }
    }
    this.wrecks = this.wrecks.filter(w => w.life > 0);

    // Missile smoke trails: puffs laid along the path show its curve.
    for (const m of game.missiles) {
      m.trailT = (m.trailT || 0) - dt;
      const ca = Math.cos(m.angle), sa = Math.sin(m.angle), back = m.rocket ? 8 : 10, salvo = m.kind === 'salvo';
      while (m.trailT <= 0) {
        m.trailT += salvo ? 0.03 : m.rocket ? 0.022 : 0.016;
        const p = this.spawn(P_SMOKE, m.x - ca * back + rand(-1.5, 1.5), m.y - sa * back + rand(-1.5, 1.5), rand(-8, 8) - ca * 20, rand(-8, 8) - sa * 20, rand(0.7, 1.3) * (salvo ? 0.7 : 1), m.rocket ? rand(3, 4) : rand(3.5, 5));
        if (p) { p.grow = 3; p.drag = 2.2; p.alpha = m.rocket ? 0.26 : 0.32; p.tint = biome.id === 'snow' ? 'dark' : 'smoke'; }
      }
    }
    // Artillery shells trail smoke high in the air.
    for (const s of game.artillery) {
      if (Math.random() > dt * 40) continue;
      const p = this.spawn(P_SMOKE, s.x + rand(-2, 2), s.y - s.h * 0.6 + rand(-2, 2), rand(-6, 6), rand(-6, 6), rand(0.5, 0.9), rand(3, 5));
      if (p) { p.grow = 2.6; p.drag = 2; p.alpha = 0.28; p.tint = 'smoke'; }
    }

    // Tank-driven effects: tread marks, dust, damage smoke.
    for (const t of game.tanks) {
      if (!t.alive) { this.trackState.delete(t.id); continue; }
      let st = this.trackState.get(t.id);
      if (!st) { st = { x: t.x, y: t.y, dust: 0 }; this.trackState.set(t.id, st); }
      const moved = dist(st.x, st.y, t.x, t.y);
      const speed = Math.hypot(t.vx, t.vy);
      // Gatling barrels spin up while firing and wind down after.
      if (t.loadout.weapon === 'mg') {
        t.spinV = lerp(t.spinV || 0, t.input.fire && t.overheatT <= 0 ? 38 : 0, damp(4, dt));
        t.spin = (t.spin || 0) + t.spinV * dt;
      }
      const wet = !t.isConvoy && this.terrain.map.onWater(t.x, t.y);
      if (moved > 5) {
        if (!wet) this.terrain.track(t.x, t.y, t.angle, t.isConvoy ? 0.07 : 0.05, t.isConvoy ? 'convoy' : t.loadout.tires, t.scale);
        st.x = t.x; st.y = t.y;
      }
      // Wading through marsh water: spray and ripples.
      if (wet && speed > 40 && Math.random() < dt * 18) {
        const side = rand() < 0.5 ? -1 : 1, ca = Math.cos(t.angle), sa = Math.sin(t.angle);
        const px = t.x + ca * rand(-20, 20) - sa * 18 * side, py = t.y + sa * rand(-20, 20) + ca * 18 * side;
        const p = this.spawn(P_DUST, px, py, -sa * side * 40 + rand(-15, 15), ca * side * 40 + rand(-15, 15), rand(0.4, 0.7), rand(4, 7));
        if (p) { p.grow = 2.2; p.alpha = 0.5; p.tint = 'screen'; }
        for (let k = 0; k < 2; k++) {
          const q = this.spawn(P_SPARK, px, py, -sa * side * rand(60, 140), ca * side * rand(60, 140), rand(0.15, 0.3), 1.3);
          if (q) q.tint = 'blue';
        }
      }
      // On fire: flames and black smoke pour off the hull.
      if (t.burnT > 0 && Math.random() < dt * 30) {
        const p = this.spawn(P_FIRE, t.x + rand(-14, 14), t.y + rand(-12, 12), rand(-10, 10), rand(-40, -10), rand(0.25, 0.5), rand(6, 11));
        if (p) { p.grow = 0.7; p.drag = 1; }
        if (Math.random() < 0.4) {
          const q = this.spawn(P_SMOKE, t.x + rand(-8, 8), t.y + rand(-8, 8), rand(5, 20), rand(-30, -8), rand(0.8, 1.4), rand(6, 9));
          if (q) { q.grow = 2.6; q.drag = 1; q.alpha = 0.55; q.tint = 'dark'; }
        }
      }
      // Repair kit: welding sparks and green crosses.
      if (t.repairT > 0 && Math.random() < dt * 24) {
        const a = rand(0, TAU), px = t.x + Math.cos(a) * rand(8, 20), py = t.y + Math.sin(a) * rand(6, 16);
        const q = this.spawn(P_SPARK, px, py, rand(-120, 120), rand(-160, 20), rand(0.1, 0.25), 1.2);
        if (q) q.tint = 'blue';
        if (Math.random() < 0.4) this.lights.push({ x: px, y: py, r: 30, life: 0.06, max: 0.06, c: 'blue' });
        if (Math.random() < 0.3) {
          const p = this.spawn(P_REPAIR, px, py, rand(-6, 6), rand(-45, -25), rand(0.6, 1), rand(3, 4.5));
          if (p) p.drag = 1;
        }
      }
      // Overdrive: exhaust flames out of both stacks.
      if (t.boostT > 0 && Math.random() < dt * 40) {
        const ca = Math.cos(t.angle), sa = Math.sin(t.angle), side = rand() < 0.5 ? -1 : 1, s = t.scale;
        const px = t.x - ca * 27 * s - sa * 8.5 * side * s, py = t.y - sa * 27 * s + ca * 8.5 * side * s;
        const p = this.spawn(P_FIRE, px, py, -ca * 90 + rand(-15, 15), -sa * 90 + rand(-15, 15), rand(0.1, 0.2), rand(4, 6));
        if (p) { p.grow = 1.5; p.drag = 4; }
        if (Math.random() < 0.5) {
          const q = this.spawn(P_SMOKE, px, py, -ca * 50 + rand(-10, 10), -sa * 50 + rand(-10, 10), rand(0.5, 0.9), rand(4, 6));
          if (q) { q.grow = 2.5; q.drag = 2; q.alpha = 0.4; q.tint = 'dark'; }
        }
      }
      st.dust += dt * (wet ? 0 : speed > 60 ? speed / 40 : Math.abs(t.turnVel) > 1 ? 3 : 0);
      while (st.dust > 1) {
        st.dust -= 1;
        const side = rand() < 0.5 ? -1 : 1, back = -26;
        const ca = Math.cos(t.angle), sa = Math.sin(t.angle);
        const px = t.x + ca * back - sa * 16 * side, py = t.y + sa * back + ca * 16 * side;
        const p = this.spawn(P_DUST, px, py, -t.vx * 0.2 + rand(-15, 15), -t.vy * 0.2 + rand(-15, 15), rand(0.5, 1.1), rand(5, 9));
        if (p) { p.grow = 2.2; p.alpha = biome.id === 'snow' ? 0.5 : 0.32; p.tint = biome.id === 'snow' ? 'snow' : 'dust'; }
      }
      // Field repairs: little green sparks drifting up off the hull.
      if (t.repairing && Math.random() < dt * 7) {
        const p = this.spawn(P_REPAIR, t.x + rand(-16, 16), t.y + rand(-12, 12), rand(-6, 6), rand(-40, -25), rand(0.7, 1.1), rand(3, 4.5));
        if (p) p.drag = 1;
      }
      const hpf = t.hp / t.maxHp;
      if (hpf < 0.55 && Math.random() < dt * (hpf < 0.3 ? 16 : 7)) {
        const p = this.spawn(P_SMOKE, t.x + rand(-6, 6) - Math.cos(t.angle) * 10, t.y + rand(-6, 6) - Math.sin(t.angle) * 10, rand(5, 20), rand(-25, -5), rand(0.8, 1.5), rand(5, 8));
        if (p) { p.grow = 2.6; p.drag = 1; p.alpha = hpf < 0.3 ? 0.6 : 0.4; p.tint = 'dark'; }
      }
      if (hpf < 0.3 && Math.random() < dt * 10) {
        const p = this.spawn(P_FIRE, t.x + rand(-8, 8), t.y + rand(-8, 8), rand(-10, 10), rand(-20, 0), rand(0.2, 0.4), rand(4, 7));
        if (p) p.grow = 0.5;
      }
    }
  }
}
