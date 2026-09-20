'use strict';
// ---------------------------------------------------------------------------
// Game mode rules. Each mode owns scoring, win conditions, spawn choice and
// the strategic goal it hands to bots.
// ---------------------------------------------------------------------------

class ModeBase {
  constructor(game) {
    this.game = game;
    this.overtime = false;
  }

  spawnPoint(tank) {
    const g = this.game, m = g.map;
    if (!g.def.teams || !m.spawnZones) return this.freePoint(m.spawns[0], tank);
    // Respawn in a zone away from the fighting, with some randomness so
    // respawns fan out across the lanes.
    const zones = m.spawnZones[tank.team];
    let pick = 0, bestScore = -Infinity;
    zones.forEach((pts, i) => {
      if (!pts.length) return;
      let md = 1e9;
      for (const e of g.tanks) if (e.alive && e.team !== tank.team) md = Math.min(md, dist(e.x, e.y, pts[0].x, pts[0].y));
      const score = Math.min(md, 900) + g.rng.float(0, 500);
      if (score > bestScore) { bestScore = score; pick = i; }
    });
    tank.spawnZone = pick;
    return this.freePoint(zones[pick], tank);
  }

  freePoint(pts, tank) {
    const g = this.game;
    let best = pts[0], bestD = -1;
    for (let i = 0; i < Math.min(pts.length, 14); i++) {
      const p = pts[i];
      let md = Infinity;
      for (const o of g.tanks) if (o.alive && o !== tank) md = Math.min(md, dist2(o.x, o.y, p.x, p.y));
      if (md > 70 * 70) return p;
      if (md > bestD) { bestD = md; best = p; }
    }
    return best;
  }

  // Long trips go through the bot's lane so a team spreads over the map
  // instead of funnelling down one shortest path.
  route(t, brain, gx, gy) {
    const m = this.game.map, c = brain.ctx;
    if (m.layout !== 'teams' || c.laneDone) return null;
    const mid = m.w / 2, side = Math.sign(t.x - mid), goalSide = Math.sign(gx - mid) || -side;
    if (side === goalSide || dist(t.x, t.y, gx, gy) < 800) { c.laneDone = true; return null; }
    if (!c.laneWp) {
      const zoneY = t.spawnZone !== undefined && m.spawnCenters[t.team][t.spawnZone] ? m.spawnCenters[t.team][t.spawnZone].y : m.h / 2;
      const laneY = clamp((brain.rng.chance(0.7) ? zoneY : brain.rng.pick(m.lanes)) + brain.rng.float(-90, 90), 120, m.h - 120);
      const wx = lerp(m.bases[t.team].x, gx, 0.55);
      const cell = m.nearestFreeCell(wx, laneY, 20);
      c.laneWp = cell >= 0 ? m.cellCenter(cell) : { x: wx, y: laneY };
    }
    const wp = c.laneWp;
    if (dist(t.x, t.y, wp.x, wp.y) < 180 || Math.abs(t.x - gx) < Math.abs(wp.x - gx)) { c.laneDone = true; return null; }
    return wp;
  }

  leader() {
    const t = this.game.teams;
    const a = Math.floor(t[0].score), b = Math.floor(t[1].score);
    return a > b ? 0 : b > a ? 1 : -1;
  }

  onTimeUp() {
    const lead = this.leader();
    if (lead >= 0) return this.game.endMatch(lead);
    if (!this.overtime) {
      this.overtime = true;
      this.game.clock = 60;
      this.game.announce('OVERTIME', 'Next point wins', '#ffcf5a');
    } else this.game.endMatch(null);
  }

  checkOvertime() {
    if (!this.overtime) return;
    const lead = this.leader();
    if (lead >= 0) this.game.endMatch(lead);
  }

  // Score limit: a campaign mission can set its own.
  ruleLimit(key) {
    const r = this.game.settings.rules;
    return (r && r.limit) || TEAM_RULES[this.game.settings.size][key];
  }

  onKill() {}
  update() {}
  hud() { return { kind: 'teams' }; }

  nearestEnemy(t, maxD = Infinity) {
    let best = null, bd = maxD * maxD;
    for (const e of this.game.tanks) {
      if (!e.alive || e.team === t.team) continue;
      const d = dist2(t.x, t.y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
}

// ---- Team Deathmatch ------------------------------------------------------------
class TDMMode extends ModeBase {
  constructor(game) {
    super(game);
    this.limit = this.ruleLimit('tdm');
  }
  onKill(victim, killer) {
    const g = this.game;
    if (killer && killer.team !== victim.team) {
      g.teams[killer.team].score++;
      if (g.teams[killer.team].score >= this.limit) g.endMatch(killer.team);
      else this.checkOvertime();
    }
  }
  botGoal(t, brain) {
    const e = this.nearestEnemy(t);
    if (e) {
      const wp = this.route(t, brain, e.x, e.y);
      if (wp) return { x: wp.x, y: wp.y, r: 90, combat: 'free' };
      // Small arrival radius: keep flanking around cover until there's line of sight.
      return { x: e.x, y: e.y, r: 40, combat: 'free' };
    }
    const g = this.game, enemyBase = g.map.bases[1 - t.team];
    return { x: lerp(g.map.w / 2, enemyBase.x, 0.3), y: g.map.h / 2, r: 160, combat: 'free' };
  }
  hud() { return { kind: 'teams', target: this.limit, label: 'kills' }; }
}

// ---- King of the Hill -------------------------------------------------------------
class KOTHMode extends ModeBase {
  constructor(game) {
    super(game);
    this.limit = this.ruleLimit('koth');
    this.hill = game.map.hill;
    this.owner = -1;       // team holding the hill
    this.capTeam = -1;     // team currently filling progress
    this.progress = 0;     // 0..1
    this.contested = false;
    this.counts = [0, 0];
  }
  update(dt) {
    const g = this.game, h = this.hill;
    const counts = [0, 0];
    for (const t of g.tanks) {
      if (t.alive && dist2(t.x, t.y, h.x, h.y) < h.r * h.r) counts[t.team]++;
    }
    this.counts = counts;
    this.contested = counts[0] > 0 && counts[1] > 0;
    const present = counts[0] > 0 && !this.contested ? 0 : counts[1] > 0 && !this.contested ? 1 : -1;
    if (present >= 0) {
      const rate = (1 / 3.2) * Math.min(2, 1 + 0.3 * (counts[present] - 1));
      if (this.owner === present) {
        this.progress = Math.min(1, this.progress + rate * dt);
      } else if (this.capTeam !== present && this.progress > 0) {
        this.progress = Math.max(0, this.progress - rate * dt);
        if (this.progress === 0) {
          if (this.owner >= 0) g.events.push({ type: 'hill', action: 'lost', team: this.owner });
          this.owner = -1;
          this.capTeam = present;
        }
      } else {
        this.capTeam = present;
        this.progress = Math.min(1, this.progress + rate * dt);
        if (this.progress >= 1 && this.owner !== present) {
          this.owner = present;
          g.events.push({ type: 'hill', action: 'captured', team: present });
          g.announce(g.teams[present].name + ' captured the hill', null, g.teams[present].color.ui);
        }
      }
    }
    for (const t of g.tanks) {
      if (t.alive && dist2(t.x, t.y, h.x, h.y) < h.r * h.r) { t.stats.hill += dt; g.award(t, XP.hill * dt); }
    }
    if (this.owner >= 0 && !this.contested && g.phase === 'live') {
      g.teams[this.owner].score += dt;
      if (g.teams[this.owner].score >= this.limit) {
        g.teams[this.owner].score = this.limit;
        g.endMatch(this.owner);
      }
    }
    this.checkOvertime();
  }
  botGoal(t, brain, arrived) {
    const h = this.hill;
    const wp = this.route(t, brain, h.x, h.y);
    if (wp) return { x: wp.x, y: wp.y, r: 90, combat: 'free' };
    if (!brain.ctx.hillPt || arrived || brain.rng.chance(0.03)) brain.ctx.hillPt = this.game.map.randomWalkable(brain.rng, h.x, h.y, h.r * 0.7);
    return { x: brain.ctx.hillPt.x, y: brain.ctx.hillPt.y, r: 40, combat: 'hold', areaX: h.x, areaY: h.y, areaR: h.r, patrol: true };
  }
  hud() { return { kind: 'teams', target: this.limit, label: 'points' }; }
}

// ---- Capture the Flag ---------------------------------------------------------------
class CTFMode extends ModeBase {
  constructor(game) {
    super(game);
    this.limit = this.ruleLimit('ctf');
    this.respawnTime = { 1: 4, 2: 5, 4: 6, 10: 8 }[game.settings.size];
    this.flags = game.map.bases.map((b, i) => ({
      team: i, homeX: b.x, homeY: b.y, x: b.x, y: b.y, state: 'home', carrier: null, dropT: 0,
    }));
  }
  returnFlag(f) {
    f.state = 'home'; f.carrier = null; f.x = f.homeX; f.y = f.homeY;
  }
  update(dt) {
    const g = this.game;
    for (const f of this.flags) {
      if (f.state === 'carried') {
        if (!f.carrier || !f.carrier.alive) { this.drop(f); continue; }
        f.x = f.carrier.x; f.y = f.carrier.y;
      } else if (f.state === 'dropped') {
        f.dropT -= dt;
        if (f.dropT <= 0) {
          this.returnFlag(f);
          g.events.push({ type: 'flag', action: 'return', team: f.team });
          g.announce(g.teams[f.team].name + ' flag returned', null, g.teams[f.team].color.ui);
        }
      }
    }
    for (const t of g.tanks) {
      if (!t.alive) continue;
      for (const f of this.flags) {
        if (f.state === 'carried' || dist2(t.x, t.y, f.x, f.y) > 46 * 46) continue;
        if (t.team !== f.team && !t.carrying) {
          f.state = 'carried'; f.carrier = t; t.carrying = f;
          g.award(t, XP.flagTake);
          g.events.push({ type: 'flag', action: 'take', team: f.team, tank: t });
          g.announce(t.name + ' has the ' + g.teams[f.team].name + ' flag', null, g.teams[t.team].color.ui);
        } else if (t.team === f.team && f.state === 'dropped') {
          this.returnFlag(f);
          g.award(t, XP.flagReturn);
          g.events.push({ type: 'flag', action: 'return', team: f.team, tank: t });
          g.announce(t.name + ' returned the flag', null, g.teams[t.team].color.ui);
        }
      }
      // Capture: carrier reaches home while own flag is safe.
      const own = this.flags[t.team];
      if (t.carrying && own.state === 'home' && dist2(t.x, t.y, own.homeX, own.homeY) < 55 * 55) {
        const f = t.carrying;
        t.carrying = null;
        this.returnFlag(f);
        t.stats.caps++;
        g.award(t, XP.flagCap);
        g.teams[t.team].score++;
        g.events.push({ type: 'flag', action: 'capture', team: f.team, tank: t });
        g.announce(g.teams[t.team].name + ' scores!', t.name + ' captured the flag', g.teams[t.team].color.ui);
        if (g.teams[t.team].score >= this.limit) g.endMatch(t.team);
        else this.checkOvertime();
      }
    }
  }
  drop(f) {
    const g = this.game, c = f.carrier;
    if (c) c.carrying = null;
    const p = { x: f.x, y: f.y };
    if (!g.map.walkable(p.x, p.y)) {
      const cell = g.map.nearestFreeCell(p.x, p.y);
      if (cell >= 0) Object.assign(p, g.map.cellCenter(cell));
    }
    f.state = 'dropped'; f.carrier = null; f.x = p.x; f.y = p.y; f.dropT = 15;
    g.events.push({ type: 'flag', action: 'drop', team: f.team });
  }
  onKill(victim) {
    if (victim.carrying) {
      const f = victim.carrying;
      f.x = victim.x; f.y = victim.y;
      this.drop(f);
      this.game.announce(this.game.teams[f.team].name + ' flag dropped', null, this.game.teams[f.team].color.ui);
    }
  }
  botGoal(t, brain) {
    const g = this.game, own = this.flags[t.team], enemy = this.flags[1 - t.team];
    const home = { x: own.homeX, y: own.homeY };
    const small = g.settings.size <= 2;
    if (t.carrying) {
      if (own.state !== 'home' && dist(t.x, t.y, home.x, home.y) < 260) {
        // Can't score yet: hold near home while teammates recover our flag.
        return { x: home.x, y: home.y, r: 140, combat: 'hold', areaX: home.x, areaY: home.y, areaR: 260 };
      }
      return { x: home.x, y: home.y, r: 20, combat: 'none' };
    }
    if (own.state === 'carried' && own.carrier) {
      const d = dist(t.x, t.y, own.carrier.x, own.carrier.y);
      if (brain.role === 'defend' || small || d < 900) return { x: own.carrier.x, y: own.carrier.y, r: 60, combat: 'none' };
    }
    if (own.state === 'dropped') {
      const d = dist(t.x, t.y, own.x, own.y);
      if (brain.role === 'defend' || small || d < 800) return { x: own.x, y: own.y, r: 10, combat: 'none' };
    }
    const c = brain.ctx;
    if (brain.role === 'defend') {
      if (!c.guardPt || brain.rng.chance(0.04)) {
        const dir = t.team === 0 ? 1 : -1;
        c.guardPt = g.map.randomWalkable(brain.rng, home.x + dir * 170, home.y, 200);
      }
      return { x: c.guardPt.x, y: c.guardPt.y, r: 50, combat: 'hold', areaX: home.x + (t.team === 0 ? 150 : -150), areaY: home.y, areaR: 360, patrol: true, lookX: g.map.w / 2, lookY: g.map.h / 2 };
    }
    if (enemy.state === 'carried' && enemy.carrier) {
      const k = enemy.carrier;
      return { x: k.x + Math.cos(brain.t.id) * 70, y: k.y + Math.sin(brain.t.id) * 70, r: 60, combat: 'free' };
    }
    const threat = this.nearestEnemy(t, 480);
    const fightOr = (fallback) => (threat || brain.aggro ? 'free' : fallback);

    // Attackers pick a lane, regroup on their own side, then push together.
    if (!c.lane) {
      // Lanes run between the enemy's flank bunkers and its flag, not through the bunkers.
      c.lane = t.spawnZone !== undefined && brain.rng.chance(0.7) ? [0.36, 0.64][t.spawnZone] : brain.rng.pick([0.36, 0.5, 0.64]);
      c.stage = small ? 'push' : 'rally';
      c.waitT = 0;
      c.via = false;
    }
    const m = g.map, laneY = m.h * c.lane;
    if (c.stage === 'rally') {
      if (!c.rally) {
        const p = { x: lerp(home.x, m.w / 2, 0.55), y: laneY };
        const cell = m.nearestFreeCell(p.x, p.y, 20);
        c.rally = cell >= 0 ? m.cellCenter(cell) : p;
      }
      if (dist(t.x, t.y, c.rally.x, c.rally.y) < 160) {
        c.waitT += 0.2;
        let mates = 0, attackers = 0;
        for (const o of g.tanks) {
          if (!o.alive || o.team !== t.team || !o.brain || o.brain.role !== 'attack') continue;
          attackers++;
          if (dist(o.x, o.y, c.rally.x, c.rally.y) < 300) mates++;
        }
        const group = g.settings.size >= 10 ? 4 : 2;
        if (mates >= Math.min(group, attackers) || c.waitT > 9) c.stage = 'push';
      }
      return { x: c.rally.x, y: c.rally.y, r: 70, combat: fightOr('none') };
    }
    if (!c.via) {
      const p = { x: lerp(enemy.homeX, m.w / 2, 0.45), y: laneY };
      if (dist(t.x, t.y, p.x, p.y) < 170 || Math.abs(t.x - enemy.homeX) < Math.abs(p.x - enemy.homeX)) c.via = true;
      else return { x: p.x, y: p.y, r: 60, combat: fightOr('none') };
    }
    // Fight through defenders, but beeline once the flag is within reach.
    const nearFlag = dist(t.x, t.y, enemy.x, enemy.y) < 280;
    return { x: enemy.x, y: enemy.y, r: 8, combat: nearFlag ? 'none' : fightOr('none') };
  }
  hud() { return { kind: 'teams', target: this.limit, label: 'captures' }; }
}

// ---- Battle Royale ------------------------------------------------------------------
const BR_PHASES = [
  { wait: 22, shrink: 20, size: 0.62, dps: 3 },
  { wait: 16, shrink: 16, size: 0.38, dps: 5 },
  { wait: 13, shrink: 14, size: 0.2, dps: 8 },
  { wait: 10, shrink: 12, size: 0.085, dps: 12 },
  { wait: 8, shrink: 30, size: 0, dps: 20 },
];

class BRMode extends ModeBase {
  constructor(game) {
    super(game);
    const m = game.map;
    const R0 = Math.hypot(m.w, m.h) / 2 + 60;
    this.R0 = R0;
    this.zone = { x: m.w / 2, y: m.h / 2, r: R0, fromX: m.w / 2, fromY: m.h / 2, fromR: R0, tx: m.w / 2, ty: m.h / 2, tr: R0 };
    this.phase = -1;
    this.state = 'wait';
    this.timer = 0;
    this.dps = 0;
    this.rng = new RNG(m.seed ^ 0x5bd1e995);
    this.vision = 470; // bots spot each other later, so fights start gradually
    this.nextPhase();
  }
  nextPhase() {
    const z = this.zone, m = this.game.map;
    this.phase++;
    const p = BR_PHASES[this.phase];
    if (!p) { this.state = 'done'; return; }
    // A big lobby needs longer early phases: more ground to cross, more tanks to thin out.
    this.stretch = this.game.tanks.length >= 30 && this.phase < 2 ? 1.5 : 1;
    const nr = p.size * Math.min(m.w, m.h) * 0.9;
    const slack = Math.max(0, z.r - nr) * (this.phase === 0 ? 0.3 : 0.85);
    let c = m.randomWalkable(this.rng, z.x, z.y, slack);
    c.x = clamp(c.x, Math.min(m.w / 2, nr * 0.5 + 100), Math.max(m.w / 2, m.w - nr * 0.5 - 100));
    c.y = clamp(c.y, Math.min(m.h / 2, nr * 0.5 + 100), Math.max(m.h / 2, m.h - nr * 0.5 - 100));
    z.fromX = z.x; z.fromY = z.y; z.fromR = z.r;
    z.tx = c.x; z.ty = c.y; z.tr = nr;
    this.state = 'wait';
    this.timer = p.wait * this.stretch;
  }
  update(dt) {
    const g = this.game, z = this.zone;
    if (g.phase !== 'live') return;
    const p = BR_PHASES[this.phase];
    if (this.state === 'wait') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.state = 'shrink';
        this.timer = p.shrink * this.stretch;
        this.dps = p.dps;
        g.events.push({ type: 'zone', action: 'shrink' });
        g.announce('The zone is closing', 'Get inside the white circle', '#e9d7ff');
      }
    } else if (this.state === 'shrink') {
      this.timer -= dt;
      const k = easeOutCubic(1 - clamp(this.timer / p.shrink, 0, 1));
      z.x = lerp(z.fromX, z.tx, k); z.y = lerp(z.fromY, z.ty, k); z.r = lerp(z.fromR, z.tr, k);
      if (this.timer <= 0) this.nextPhase();
    }
    for (const t of g.tanks) if (t.alive) g.award(t, XP.survive * dt);
    if (this.phase > 0 || this.state === 'shrink') {
      for (const t of g.tanks) {
        if (!t.alive || t.shield > 0) continue;
        if (dist2(t.x, t.y, z.x, z.y) > z.r * z.r) g.zoneDamage(t, Math.max(this.dps, 3) * dt);
      }
    }
  }
  aliveCount() { return this.game.tanks.filter(t => t.alive).length; }
  onKill(victim) {
    const g = this.game;
    victim.eliminated = true;
    const alive = g.tanks.filter(t => t.alive);
    victim.place = alive.length + 1;
    // Over when only one team is left standing (a co-op duo counts as one team).
    if (new Set(alive.map(t => t.team)).size <= 1) {
      for (const t of alive) t.place = 1;
      g.endMatch(alive.length ? alive[0].team : victim.team);
    }
  }
  botGoal(t, brain, arrived) {
    const z = this.zone, g = this.game;
    const safeR = z.tr * 0.8;
    const outside = dist(t.x, t.y, z.tx, z.ty) > z.tr - 30;
    if (outside && (this.state === 'shrink' || this.timer < 12 || dist(t.x, t.y, z.x, z.y) > z.r - 40)) {
      const urgent = dist(t.x, t.y, z.x, z.y) > z.r - 20;
      return { x: z.tx, y: z.ty, r: Math.max(40, z.tr * 0.5), combat: urgent ? 'none' : 'free' };
    }
    // Nobody goes hunting until the zone first starts to close.
    const early = this.phase === 0 && this.state === 'wait';
    const e = !early && brain.aggro && t.hp > t.maxHp * 0.5 ? this.nearestEnemy(t, 650) : null;
    if (e && dist(e.x, e.y, z.tx, z.ty) < z.tr) return { x: e.x, y: e.y, r: 50, combat: 'free' };
    // Linger at each spot for a while before roaming on.
    const c = brain.ctx;
    if (arrived && c.wander && c.lingerUntil === undefined) c.lingerUntil = g.time + brain.rng.float(3, 8);
    const lingering = c.lingerUntil !== undefined && g.time < c.lingerUntil;
    if (!c.wander || (arrived && !lingering) || dist(c.wander.x, c.wander.y, z.tx, z.ty) > z.tr) {
      c.lingerUntil = undefined;
      // Roam locally so the field stays spread out until the zone squeezes it.
      let p = g.map.randomWalkable(brain.rng, t.x, t.y, 420, 140);
      if (dist(p.x, p.y, z.tx, z.ty) > safeR) p = g.map.randomWalkable(brain.rng, lerp(t.x, z.tx, 0.4), lerp(t.y, z.ty, 0.4), 200);
      brain.ctx.wander = p;
    }
    // Cautious crews shoot from where they are instead of chasing.
    const w = brain.ctx.wander;
    return brain.aggro && !early ? { x: w.x, y: w.y, r: 60, combat: 'free', patrol: true }
      : { x: w.x, y: w.y, r: 60, combat: 'hold', areaX: w.x, areaY: w.y, areaR: 260, patrol: true };
  }
  onTimeUp() {}
  hud() { return { kind: 'br' }; }
}

// ---- One Shot -----------------------------------------------------------------------
// Team deathmatch where any hit kills (see Game.damage) and reloads are fast.
class OneShotMode extends TDMMode {
  constructor(game) {
    super(game);
    this.limit = this.ruleLimit('oneshot');
  }
}

// ---- Juggernaut ---------------------------------------------------------------------
// One oversized tank (team 1) against everyone else (team 0). Destroying it
// passes the crown; only the Juggernaut earns points (per second and per kill).
class JuggernautMode extends ModeBase {
  constructor(game) {
    super(game);
    this.jug = null;
    this.rng = new RNG(game.map.seed ^ 0x2468ace);
  }

  afterSpawn() { this.crown(this.rng.pick(this.game.tanks), true); }

  crown(t, first) {
    const g = this.game;
    if (this.jug && this.jug !== t) this.uncrown(this.jug);
    this.jug = t;
    t.jug = true;
    t.jugHpMul = JUGGERNAUT.hpMul + Math.max(0, g.tanks.length - 4) * JUGGERNAUT.hpPerTank;
    t.recalc(g.baseHp);
    t.hp = t.maxHp;
    t.shield = Math.max(t.shield, 1.5);
    for (const o of g.tanks) o.team = o === t ? 1 : 0;
    g.events.push({ type: 'jug', tank: t, first });
    g.announce(first ? t.name + ' starts as the Juggernaut' : t.name + ' is the Juggernaut', first ? 'Destroy it to take its place' : null, t.color.ui);
  }

  uncrown(t) {
    const g = this.game;
    t.jug = false;
    t.recalc(g.baseHp);
    t.team = 0;
  }

  update(dt) {
    const j = this.jug;
    if (j && j.alive) { j.score += JUGGERNAUT.pointsPerSec * dt; this.game.award(j, XP.jug * dt); }
    // Crown was left vacant (nobody alive to take it): give it to someone now.
    if (!j) {
      const alive = this.game.tanks.filter(t => t.alive);
      if (alive.length) this.crown(this.rng.pick(alive));
    }
  }

  onKill(victim, killer) {
    if (victim === this.jug) {
      this.uncrown(victim);
      const heir = killer && killer !== victim && killer.alive ? killer : null;
      if (heir) { this.game.award(heir, XP.jugKill); this.crown(heir); }
      else {
        const alive = this.game.tanks.filter(t => t.alive);
        this.jug = null;
        if (alive.length) this.crown(this.rng.pick(alive));
      }
    } else if (killer && killer === this.jug) {
      killer.score += JUGGERNAUT.pointsPerKill;
    }
  }

  // Respawn as far as possible from everyone, the Juggernaut most of all.
  spawnPoint(tank) {
    const g = this.game, pts = g.map.spawns[0];
    let best = pts[0], bestScore = -1;
    for (const p of pts) {
      let md = Infinity;
      for (const o of g.tanks) if (o.alive && o !== tank) md = Math.min(md, dist(o.x, o.y, p.x, p.y) * (o.jug ? 0.6 : 1));
      const score = Math.min(md, 1200) + g.rng.float(0, 300);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  ranking() {
    return this.game.tanks.slice().sort((a, b) => b.score - a.score || b.stats.kills - a.stats.kills);
  }

  onTimeUp() {
    const g = this.game, ranked = this.ranking();
    if (!this.overtime && ranked.length > 1 && Math.floor(ranked[0].score) === Math.floor(ranked[1].score)) {
      this.overtime = true;
      g.clock = 30;
      g.announce('OVERTIME', 'Scores are tied', '#ffcf5a');
      return;
    }
    ranked.forEach((t, i) => (t.place = i + 1));
    g.winnerTank = ranked[0];
    g.endMatch(ranked[0].team);
  }

  botGoal(t) {
    const g = this.game;
    // The Juggernaut hunts for kills; everyone else hunts the Juggernaut.
    const e = t.jug ? this.nearestEnemy(t) : this.jug && this.jug.alive ? this.jug : null;
    if (e) return { x: e.x, y: e.y, r: 40, combat: 'free' };
    return { x: g.map.w / 2, y: g.map.h / 2, r: 200, combat: 'free' };
  }

  hud() { return { kind: 'jug' }; }
}

// ---- Escort / Convoy -------------------------------------------------------------------
// Round 1: Cobalt escorts a supply truck to extraction while Ember ambushes it.
// Round 2: roles swap. Destroying the enemy convoy (faster) beats not
// destroying it; otherwise the team that dealt more damage to it wins.
class EscortMode extends ModeBase {
  constructor(game) {
    super(game);
    this.round = 0;
    this.results = [];
    this.state = 'round';      // 'round' | 'break'
    this.breakT = 0;
    this.convoy = null;
    this.roundTime = 0;
    this.eta = ESCORT.duration;
    this.convoyHp = ESCORT.hpBase + ESCORT.hpPerTank * game.settings.size;
  }

  get defenders() { return this.round === 0 ? 0 : 1; }
  get attackers() { return 1 - this.defenders; }

  afterSpawn() { this.startRound(true); }

  // Start just outside the defenders' base; extraction is near the attackers' side.
  buildRoute(team) {
    const m = this.game.map, own = m.bases[team], other = m.bases[1 - team];
    const pick = (x, y) => { const c = m.nearestFreeCell(x, y, 30); return c >= 0 ? m.cellCenter(c) : { x, y }; };
    let start = pick(lerp(own.x, other.x, 0.07), own.y);
    let end = pick(lerp(own.x, other.x, 0.86), other.y);
    let path;
    if (m.convoyRoute) {
      // Campaign maps lay a road for the convoy: follow it (mirrored for the other side).
      const pts = team === 0 ? m.convoyRoute : m.convoyRoute.map(p => ({ x: m.w - p.x, y: m.h - p.y }));
      start = pick(pts[0].x, pts[0].y);
      path = [];
      let from = start;
      for (const q of pts.slice(1)) {
        const to = pick(q.x, q.y), leg = m.findPath(from.x, from.y, to.x, to.y, 80000) || [to];
        path.push(...leg);
        from = to;
      }
      end = from;
    } else path = m.findPath(start.x, start.y, end.x, end.y, 80000) || [end];
    // Densify so the truck turns smoothly.
    const out = [start];
    let prev = start;
    for (const p of path) {
      const d = dist(prev.x, prev.y, p.x, p.y), n = Math.max(1, Math.ceil(d / 60));
      for (let i = 1; i <= n; i++) out.push({ x: lerp(prev.x, p.x, i / n), y: lerp(prev.y, p.y, i / n) });
      prev = p;
    }
    return out;
  }

  startRound(first) {
    const g = this.game, def = this.defenders;
    g.shells.length = 0; g.missiles.length = 0; g.artillery.length = 0; g.smokes.length = 0; g.grenades.length = 0; g.airstrikes.length = 0;
    g.mines = g.mines.filter(m => m.team === -1); // a mission minefield stays put
    if (this.convoy) g.tanks.splice(g.tanks.indexOf(this.convoy), 1);
    const route = this.buildRoute(def);
    let len = 0;
    for (let i = 1; i < route.length; i++) len += dist(route[i - 1].x, route[i - 1].y, route[i].x, route[i].y);
    const c = new Convoy(def, g.teams[def].color, this.convoyHp, route, len / ESCORT.duration);
    c.spawn(route[0].x, route[0].y, Math.atan2(route[1].y - route[0].y, route[1].x - route[0].x));
    g.tanks.push(c);
    this.convoy = c;
    this.route = route;
    this.extraction = route[route.length - 1];
    this.roundTime = 0;
    if (!first) {
      for (const t of g.tanks) {
        if (t.isConvoy) continue;
        const p = this.spawnPoint(t);
        t.spawn(p.x, p.y, p.angle);
        if (t.brain) t.brain.reset();
      }
    }
    this.state = 'round';
    g.events.push({ type: 'escort_round', round: this.round });
    g.announce(`Round ${this.round + 1}: ${g.teams[def].name} escort the convoy`, `${g.teams[1 - def].name} must destroy it before it reaches extraction`, g.teams[def].color.ui);
  }

  update(dt) {
    const g = this.game;
    if (this.state === 'break') {
      this.breakT -= dt;
      if (this.breakT <= 0) { this.round++; this.startRound(false); }
      return;
    }
    const c = this.convoy;
    this.roundTime += dt;
    this.eta = Math.max(0, (c.routeLen - c.travelled) / c.cruise);
    for (const t of g.tanks) {
      if (t.alive && !t.isConvoy && t.team === this.defenders && dist2(t.x, t.y, c.x, c.y) < 350 * 350) g.award(t, XP.escort * dt);
    }
    if (c.alive && c.arrived) this.endRound(false);
  }

  onKill(victim, killer) {
    if (victim === this.convoy && this.state === 'round') {
      if (killer) this.game.award(killer, XP.convoyKill);
      this.endRound(true);
    }
  }

  endRound(destroyed) {
    const g = this.game, c = this.convoy, atk = this.attackers;
    const res = { attackers: atk, destroyed, time: this.roundTime, damage: Math.round(c.maxHp - Math.max(0, c.hp)) };
    this.results.push(res);
    g.teams[atk].score = res.damage;
    g.teams[atk].destroyedIn = destroyed ? res.time : null;
    c.invuln = 1e9;
    g.events.push({ type: 'escort_end', destroyed, round: this.round });
    if (destroyed) g.announce(`${g.teams[atk].name} destroyed the convoy`, `in ${fmtTime(res.time)}`, g.teams[atk].color.ui);
    else g.announce('Convoy extracted', `${g.teams[this.defenders].name} delivered the supplies · ${res.damage} damage taken`, g.teams[this.defenders].color.ui);
    if (this.round === 0) { this.state = 'break'; this.breakT = ESCORT.breakTime; }
    else this.finish();
  }

  finish() {
    const score = r => (r.destroyed ? 1e6 - r.time : r.damage);
    const [a, b] = this.results;
    const winner = score(a) === score(b) ? null : score(a) > score(b) ? a.attackers : b.attackers;
    this.game.endMatch(winner);
  }

  onTimeUp() {}

  botGoal(t, brain) {
    const g = this.game, c = this.convoy;
    if (!c || !c.alive || this.state === 'break') {
      const b = g.map.bases[t.team];
      return { x: b.x, y: b.y, r: 300, combat: 'free' };
    }
    if (t.team === this.defenders) {
      // Escort: ring the truck, fight anything that comes close.
      const a = (t.id * 2.39996) % TAU;
      return { x: c.x + Math.cos(a) * 130, y: c.y + Math.sin(a) * 130, r: 50, combat: 'hold', areaX: c.x, areaY: c.y, areaR: 380 };
    }
    // Attackers: some set up an ambush further along the route, the rest chase.
    const ctx = brain.ctx;
    if (ctx.ambush === undefined) ctx.ambush = brain.rng.chance(0.5);
    if (ctx.ambush && dist(t.x, t.y, c.x, c.y) > 650) {
      const i = Math.min(this.route.length - 1, c.routeI + 10 + (t.id % 8));
      const p = this.route[i];
      return { x: p.x + Math.cos(t.id) * 120, y: p.y + Math.sin(t.id) * 120, r: 60, combat: 'free' };
    }
    return { x: c.x, y: c.y, r: 260, combat: 'free' };
  }

  hud() { return { kind: 'escort' }; }
}

// ---- Hardcore ---------------------------------------------------------------------------
// Team elimination rounds with no respawns. Wiping out the other squad takes
// the round; first to three rounds wins. A round that runs out of time goes to
// the side with more tanks left, then more armor left.
class HardcoreMode extends ModeBase {
  constructor(game) {
    super(game);
    const r = game.settings.rules;
    this.limit = (r && r.limit) || HARDCORE.rounds;
    this.round = 0;
    this.state = 'round';      // 'round' | 'break'
    this.breakT = 0;
    this.roundTime = HARDCORE.time[game.settings.size] || 160;
    this.history = [];         // winner of each round (null = drawn)
  }

  afterSpawn() { this.game.clock = this.roundTime; }

  alive(team) { return this.game.tanks.filter(t => t.alive && t.team === team); }

  update(dt) {
    if (this.state !== 'break') return;
    const g = this.game;
    this.breakT -= dt;
    g.clock = this.roundTime + dt; // hold the clock between rounds
    if (this.breakT <= 0) this.startRound();
  }

  onKill() {
    if (this.state !== 'round') return;
    const a = this.alive(0).length, b = this.alive(1).length;
    if (a && b) return;
    this.endRound(a ? 0 : b ? 1 : null, 'wipe');
  }

  onTimeUp() {
    if (this.state !== 'round') return;
    const A = this.alive(0), B = this.alive(1);
    const armor = list => list.reduce((s, t) => s + t.hp / t.maxHp, 0);
    let w = A.length > B.length ? 0 : B.length > A.length ? 1 : null;
    if (w === null && Math.abs(armor(A) - armor(B)) > 0.01) w = armor(A) > armor(B) ? 0 : 1;
    this.endRound(w, 'time');
  }

  endRound(w, why) {
    const g = this.game;
    this.state = 'break';
    this.breakT = HARDCORE.breakTime;
    this.history.push(w);
    g.events.push({ type: 'round_end', winner: w, round: this.round });
    if (w === null) {
      g.announce('Round drawn', 'Nobody scores', '#f3ecd6');
    } else {
      g.teams[w].score++;
      for (const t of g.tanks) if (t.team === w) g.award(t, XP.round);
      const tm = g.teams[w], other = g.teams[1 - w];
      const sub = why === 'time' ? 'More tanks left when time ran out' : `${tm.score} – ${other.score}`;
      g.announce(`${tm.name} take round ${this.round + 1}`, sub, tm.color.ui);
      if (tm.score >= this.limit) g.endMatch(w);
    }
  }

  // Everyone back to their bunkers with full armor; the battlefield is cleared.
  startRound() {
    const g = this.game;
    this.round++;
    g.shells.length = 0; g.missiles.length = 0; g.artillery.length = 0; g.smokes.length = 0; g.grenades.length = 0; g.airstrikes.length = 0;
    g.mines = g.mines.filter(m => m.team === -1);
    for (const t of g.tanks) { t.eliminated = false; t.missileCharge = Math.min(t.missileCharge, g.specialCost(t)); }
    g.spawnAll();
    g.clock = this.roundTime;
    this.state = 'round';
    g.events.push({ type: 'round_start', round: this.round });
    const [a, b] = g.teams;
    g.announce(`Round ${this.round + 1}`, `${a.name} ${a.score} – ${b.score} ${b.name}`, '#f3ecd6');
  }

  botGoal(t, brain) { return TDMMode.prototype.botGoal.call(this, t, brain); }
  hud() { return { kind: 'teams', target: this.limit, label: 'rounds' }; }
}

const MODE_CLASSES = { tdm: TDMMode, koth: KOTHMode, ctf: CTFMode, oneshot: OneShotMode, escort: EscortMode, hardcore: HardcoreMode, br: BRMode, jug: JuggernautMode };
