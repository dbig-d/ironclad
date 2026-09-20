'use strict';
// ---------------------------------------------------------------------------
// Bot brain: target selection, aiming with lead, dodging, path following.
// The active game mode supplies the strategic goal (hill, flag, zone...).
// ---------------------------------------------------------------------------

const ENGAGE_RANGE = 820;

class BotBrain {
  constructor(tank, skill, seed) {
    this.t = tank;
    this.s = skill;
    this.rng = new RNG(seed);
    this.role = 'attack';
    this.aggro = this.rng.chance(0.35);
    this.reset();
  }

  reset() {
    this.target = null;
    this.targetLOS = false;
    this.reactT = 0;
    this.thinkT = this.rng.float(0, 0.2);
    this.path = null;
    this.pathI = 0;
    this.pathGoal = null;
    this.pathT = 0;
    this.goal = null;
    this.mode = 'goal';
    this.aimOff = 0;
    this.aimOffTarget = 0;
    this.aimOffT = 0;
    this.holdFireT = 0;
    this.strafeDir = this.rng.sign();
    this.strafeT = 0;
    this.dodgeT = 0;
    this.dodgeAngle = 0;
    this.unstickT = 0;
    this.jukeT = 0;
    this.jukeDir = 1;
    this.unstickTurn = 1;
    this.checkT = 0.8;
    this.checkX = this.t.x;
    this.checkY = this.t.y;
    this.wantMove = false;
    this.ctx = {}; // per-life scratch space for the game mode
    this.retreat = null;
    this.blind = null;
    this.cooling = false;
  }

  update(dt, game) {
    this.dt = dt;
    const t = this.t;
    if (!t.alive) return;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.16 + this.rng.float(0, 0.1);
      this.think(game);
    }
    this.aim(dt, game);
    this.drive(dt, game);
  }

  // ---- perception & decisions ------------------------------------------------
  think(game) {
    const t = this.t, map = game.map;
    let best = null, bestScore = Infinity, bestLOS = false;
    // Night missions: crews only see what their headlights and flares reach.
    const vision = Math.min(game.mode.vision || 1300, game.visionLimit);
    // The objective (an escort truck, say) outranks a closer, easier target.
    const focus = this.goal && this.goal.focus;
    for (const e of game.tanks) {
      if (!e.alive || e.team === t.team) continue;
      const d = dist(t.x, t.y, e.x, e.y);
      if (d > vision) continue;
      // Smoke hides tanks (unless they're right on top of us) and blocks sight lines.
      if (d > 110 && game.inSmoke(e.x, e.y)) continue;
      const los = map.lineOfSight(t.x, t.y, e.x, e.y, 3) && !game.smokeBlocks(t.x, t.y, e.x, e.y);
      if (!los && d > 520) continue;
      let score = d * (los ? 1 : 2.2);
      if (e.carrying) score -= 450;
      if (e.isConvoy) score -= 250;
      if (focus && e === focus) score -= 700;
      score -= (1 - e.hp / e.maxHp) * 140;
      if (e.shield > 0) score += 350;
      if (e === this.target) score -= 160;
      if (score < bestScore) { bestScore = score; best = e; bestLOS = los; }
    }
    // Lost a target into smoke: keep firing blind at where it vanished.
    if (this.target && this.target.alive && best !== this.target && game.inSmoke(this.target.x, this.target.y)) {
      this.blind = { x: this.target.x, y: this.target.y, until: game.time + 1.8 };
    }
    if (best !== this.target) this.reactT = this.s.reaction * this.rng.float(0.75, 1.3);
    this.target = best;
    this.targetLOS = bestLOS;

    this.goal = game.mode.botGoal(t, this);
    const g = this.goal;
    const d = best ? dist(t.x, t.y, best.x, best.y) : Infinity;
    if (best && bestLOS && d < ENGAGE_RANGE && g.combat !== 'none') this.mode = g.combat === 'hold' ? 'hold' : 'fight';
    else this.mode = 'goal';

    // Badly damaged crews with some sense pull back out of the fight to repair.
    const hpf = t.hp / t.maxHp;
    if (this.retreat && (hpf > 0.8 || game.time > this.retreat.until || g.combat === 'none')) this.retreat = null;
    if (!this.retreat && hpf < 0.3 && best && g.combat !== 'none' && !t.carrying && this.rng.chance(this.s.retreat * 0.3)) {
      const away = Math.atan2(t.y - best.y, t.x - best.x);
      const p = map.randomWalkable(this.rng, t.x + Math.cos(away) * 460, t.y + Math.sin(away) * 460, 160);
      this.retreat = { x: p.x, y: p.y, until: game.time + 9 };
    }
    if (this.retreat) this.mode = 'retreat';

    // Evade incoming shells.
    if (this.dodgeT <= 0 && this.s.dodge > 0) {
      for (const sh of game.shells) {
        if (!sh.alive || sh.team === t.team || sh.flame) continue;
        if (!sh.seenBy) sh.seenBy = new Set();
        if (sh.seenBy.has(t.id)) continue;
        const rx = t.x - sh.x, ry = t.y - sh.y;
        const vv = sh.vx * sh.vx + sh.vy * sh.vy;
        const tc = (rx * sh.vx + ry * sh.vy) / vv;
        if (tc < 0 || tc > 0.75) continue;
        const cx = sh.x + sh.vx * tc - t.x, cy = sh.y + sh.vy * tc - t.y;
        if (cx * cx + cy * cy > (t.radius + 16) ** 2) continue;
        sh.seenBy.add(t.id);
        if (!this.rng.chance(this.s.dodge)) continue;
        const cross = sh.vx * ry - sh.vy * rx;
        const side = cross >= 0 ? 1 : -1;
        this.dodgeAngle = Math.atan2(sh.vy, sh.vx) + side * Math.PI / 2;
        this.dodgeT = 0.42;
        break;
      }
    }

    if (this.rng.chance(0.08)) this.strafeDir *= -1;
  }

  // ---- aiming & firing ------------------------------------------------------------
  aim(dt, game) {
    const t = this.t, s = this.s, e = this.target;
    this.reactT -= dt;
    this.holdFireT -= dt;
    this.aimOffT -= dt;
    if (this.aimOffT <= 0) {
      this.aimOffT = this.rng.float(0.35, 0.9);
      this.aimOffTarget = this.rng.gauss() * s.aimError;
    }
    this.aimOff = lerp(this.aimOff, this.aimOffTarget, damp(s.aimDrift, dt));
    t.input.fire = false;
    if (!e || !e.alive) this.idleSpecial(dt, game);

    if (e && e.alive) {
      const d = dist(t.x, t.y, e.x, e.y);
      const w = t.loadout.weapon;
      const { speed: pSpeed, range } = weaponBallistics(w);
      let px = e.x, py = e.y;
      for (let i = 0; i < 2; i++) {
        const tt = dist(t.muzzleX, t.muzzleY, px, py) / pSpeed;
        px = e.x + e.vx * tt * s.lead;
        py = e.y + e.vy * tt * s.lead;
      }
      const want = Math.atan2(py - t.y, px - t.x) + this.aimOff;
      t.input.aim = want;
      this.useSpecial(dt, game, e, d);
      // Anti-air rounds: switch them on when explosives come our way.
      if (t.loadout.special === 'flak' && t.flakT <= 0 && t.missileCharge >= game.specialCost(t) && this.incoming(game, 520)) t.input.missile = true;
      // Machine gun / flamethrower: ease off before it overheats.
      if (w === 'mg' || w === 'flame') {
        if (t.heat > 82) this.cooling = true;
        else if (t.heat < 25) this.cooling = false;
        if (this.cooling || t.overheatT > 0) return;
      }
      if (!this.targetLOS || this.reactT > 0 || this.holdFireT > 0 || t.reload > 0) return;
      if (d > range * 0.93 || e.shield > 0.3 || e.invuln > 0.3) return;
      const cone = Math.max(s.fireCone, Math.atan2(e.radius * 0.8, d));
      if (Math.abs(angDiff(t.turret, want)) > cone) return;
      // Don't shoot straight into a wall that is in the way of the lead point.
      if (!game.map.lineOfSight(t.muzzleX, t.muzzleY, px, py, 2) && !game.map.lineOfSight(t.muzzleX, t.muzzleY, e.x, e.y, 2)) return;
      t.input.fire = true;
      if (s.fireRate < 1 && w !== 'mg' && w !== 'flame') this.holdFireT = t.reloadTime + this.rng.float(0, (1 / s.fireRate - 1) * 1.4);
    } else if (this.blind && game.time < this.blind.until) {
      // Shooting blind into smoke at the last known position.
      const b = this.blind;
      t.input.aim = Math.atan2(b.y - t.y, b.x - t.x) + this.aimOff * 3;
      if (t.reload <= 0 && t.overheatT <= 0 && this.rng.chance(0.6)) t.input.fire = true;
    } else if (this.goal) {
      // Idle turret: look where we are heading, or pre-aim at the objective.
      const lookX = this.goal.lookX !== undefined ? this.goal.lookX : this.goal.x;
      const lookY = this.goal.lookY !== undefined ? this.goal.lookY : this.goal.y;
      if (dist(t.x, t.y, lookX, lookY) > 80) t.input.aim = Math.atan2(lookY - t.y, lookX - t.x);
      else t.input.aim = t.angle;
    }
  }

  // Specials: each one has its own sensible moment.
  useSpecial(dt, game, e, d) {
    const t = this.t, s = this.s;
    const loaded = t.loadout.special === 'grenades' && t.grenadeAmmo > 0;
    if ((t.missileCharge < game.specialCost(t) && !loaded) || this.reactT > 0) return;
    const rate = dt * (0.5 + s.id * 0.4);
    const go = target => { t.input.missile = true; t.input.missileTarget = target; };
    switch (t.loadout.special) {
      case 'missile':
        if (this.targetLOS && d > 220 && d < 850 && this.rng.chance(rate)) go(e);
        break;
      case 'artillery':
        // Great against targets behind cover.
        if (d > 350 && d < ARTY.range && this.rng.chance(rate * (this.targetLOS ? 0.6 : 1.5))) go(e);
        break;
      case 'mine':
        if ((this.mode === 'retreat' || d < 320) && this.rng.chance(rate * 1.5)) go(e);
        break;
      case 'smoke':
        if (t.hp < t.maxHp * 0.45 && d < 650 && this.rng.chance(rate * 2)) {
          go(e);
          const away = Math.atan2(t.y - e.y, t.x - e.x);
          const p = game.map.randomWalkable(this.rng, t.x + Math.cos(away) * 420, t.y + Math.sin(away) * 420, 160);
          this.retreat = { x: p.x, y: p.y, until: game.time + 7 };
        }
        break;
      case 'repair':
        if ((t.hp < t.maxHp * 0.4 || t.burnT > 1) && this.rng.chance(rate * 3)) go(e);
        break;
      case 'airstrike':
        if (d > 300 && d < AIRSTRIKE.range && this.rng.chance(rate * (this.targetLOS ? 0.7 : 1.4))) go(e);
        break;
      case 'grenades':
        // Lob them round corners at close range, or finish off a hurt target.
        if (d < 420 && (loaded || !this.targetLOS || e.hp < e.maxHp * 0.5) && this.rng.chance(rate * (loaded ? 3 : 1.5))) go(e);
        break;
      case 'salvo':
        if (this.targetLOS && d < 520 && Math.abs(angDiff(t.angle, Math.atan2(e.y - t.y, e.x - t.x))) < 0.2 && this.rng.chance(rate * 3)) go(e);
        break;
      case 'overdrive':
        // Punch it to close on a target (rammers, flamers) or to get out.
        if ((this.mode === 'retreat' || (d > 260 && d < 700 && (t.loadout.hull === 'dozer' || t.loadout.weapon === 'flame'))) && this.rng.chance(rate * 2)) go(e);
        break;
    }
  }

  // Specials that don't need an enemy in sight.
  idleSpecial(dt, game) {
    const t = this.t;
    if (t.missileCharge < game.specialCost(t)) return;
    const sp = t.loadout.special, rate = dt * (0.5 + this.s.id * 0.4);
    if (sp === 'flak' && t.flakT <= 0 && this.incoming(game, 520)) { t.input.missile = true; return; }
    if (sp === 'repair' && t.hp < t.maxHp * 0.6 && this.rng.chance(rate * 2)) t.input.missile = true;
    else if (sp === 'overdrive' && this.mode === 'goal' && this.goal && dist(t.x, t.y, this.goal.x, this.goal.y) > 900 && this.rng.chance(rate * 0.4)) t.input.missile = true;
    else if (sp === 'overdrive' && t.carrying && this.rng.chance(rate * 2)) t.input.missile = true;
  }

  // Is a hostile missile, rocket, grenade or shell coming in near us?
  incoming(game, r) {
    const t = this.t, r2 = r * r;
    for (const m of game.missiles) if (m.alive && m.team !== t.team && dist2(m.x, m.y, t.x, t.y) < r2) return true;
    for (const g of game.grenades) if (g.alive && g.team !== t.team && dist2(g.x, g.y, t.x, t.y) < r2) return true;
    for (const s of game.artillery) if (s.team !== t.team && dist2(s.tx, s.ty, t.x, t.y) < r2) return true;
    return false;
  }

  // ---- movement ------------------------------------------------------------------------
  drive(dt, game) {
    const t = this.t, map = game.map;
    const inp = t.input;

    // Missile evasion: slam the throttle the other way just before it commits.
    if (this.jukeT > 0) {
      this.jukeT -= dt;
      inp.throttle = this.jukeDir;
      inp.turn = 0;
      return;
    }
    for (const m of game.missiles) {
      if (m.target !== t || m.committed) continue;
      const d = dist(t.x, t.y, m.x, m.y);
      if (d > 210 || d < 120) continue;
      if (!m.seenBy) m.seenBy = new Set();
      if (m.seenBy.has(t.id)) continue;
      m.seenBy.add(t.id);
      if (this.rng.chance(this.s.dodge)) {
        this.jukeT = 0.45;
        this.jukeDir = t.speed > 20 ? -1 : 1;
        return;
      }
    }

    if (this.unstickT > 0) {
      this.unstickT -= dt;
      inp.throttle = -0.9;
      inp.turn = this.unstickTurn;
      return;
    }

    let dirA = null, allowReverse = false, speed = 1;
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      dirA = this.dodgeAngle;
      allowReverse = true;
      const ax = t.x + Math.cos(dirA) * 60, ay = t.y + Math.sin(dirA) * 60;
      if (!map.walkable(ax, ay)) { this.dodgeAngle += Math.PI; dirA = this.dodgeAngle; }
    } else if (this.mode === 'retreat') {
      if (dist(t.x, t.y, this.retreat.x, this.retreat.y) > 40) {
        dirA = this.followPath(this.retreat.x, this.retreat.y, game);
        allowReverse = true;
      }
    } else if ((this.mode === 'fight' || this.mode === 'hold') && this.target) {
      dirA = this.combatDirection(game);
      allowReverse = true;
      if (dirA !== null && Math.abs(angDiff(t.angle, dirA)) > 2) speed = 0.8;
    }
    if (dirA === null && (this.mode === 'goal' || this.mode === 'approach')) {
      const g = this.goal;
      if (g && dist(t.x, t.y, g.x, g.y) > (g.r || 40)) dirA = this.followPath(g.x, g.y, game);
      else if (g && g.patrol) {
        this.goal = game.mode.botGoal(t, this, true);
      }
    }

    // Keep a little space from teammates so convoys don't jam, and steer
    // around the mines of a marked minefield.
    if (dirA !== null) {
      let sx = Math.cos(dirA), sy = Math.sin(dirA);
      for (const o of game.tanks) {
        if (o === t || !o.alive || o.team !== t.team) continue;
        const dx = t.x - o.x, dy = t.y - o.y, d2 = dx * dx + dy * dy;
        if (d2 < 75 * 75 && d2 > 1) {
          const d = Math.sqrt(d2), f = (75 - d) / 75 * 0.9;
          sx += dx / d * f; sy += dy / d * f;
        }
      }
      for (const m of game.mines) {
        if (m.team !== -1) continue;
        const dx = t.x - m.x, dy = t.y - m.y, d2 = dx * dx + dy * dy;
        if (d2 < 95 * 95 && d2 > 1) {
          const d = Math.sqrt(d2), f = (95 - d) / 95 * 1.6;
          sx += dx / d * f; sy += dy / d * f;
        }
      }
      dirA = Math.atan2(sy, sx);
    }

    this.wantMove = dirA !== null;
    if (dirA === null) {
      inp.throttle = 0;
      inp.turn = 0;
    } else {
      this.steer(dirA, allowReverse, speed);
    }

    // Stuck detection: intending to move but not getting anywhere.
    this.checkT -= dt;
    if (this.checkT <= 0) {
      const moved = dist(t.x, t.y, this.checkX, this.checkY);
      if (this.wantMove && Math.abs(inp.throttle) > 0.3 && moved < 12) {
        this.unstickT = this.rng.float(0.45, 0.8);
        this.unstickTurn = this.rng.sign();
        this.path = null;
      }
      this.checkT = 0.7;
      this.checkX = t.x; this.checkY = t.y;
    }
  }

  steer(dirA, allowReverse, speed) {
    const t = this.t, inp = this.t.input;
    const diff = angDiff(t.angle, dirA);
    if (allowReverse && Math.abs(diff) > 1.9) {
      const diffB = angDiff(t.angle + Math.PI, dirA);
      inp.turn = clamp(diffB * 2.6, -1, 1);
      inp.throttle = -clamp(Math.cos(diffB) * 1.2, 0.2, 1) * speed;
      return;
    }
    inp.turn = clamp(diff * 2.6, -1, 1);
    inp.throttle = Math.abs(diff) > 1.15 ? 0.12 : clamp(Math.cos(diff) * 1.25, 0.3, 1) * speed;
  }

  followPath(gx, gy, game) {
    const t = this.t, map = game.map, dry = t.loadout.tires !== 'quad';
    // Direct line when nothing is in the way (re-checked a few times a second, or when the goal jumps).
    this.lineT = (this.lineT || 0) - this.dt;
    if (this.lineT <= 0 || (gx - this.lineX) ** 2 + (gy - this.lineY) ** 2 > 40 * 40) {
      this.lineT = 0.1 + this.rng.float(0, 0.05);
      this.lineX = gx; this.lineY = gy;
      this.lineOK = dist(t.x, t.y, gx, gy) < 700 && map.clearPath(t.x, t.y, gx, gy, dry) && map.walkable(gx, gy);
      this.skipOK = null;
    }
    if (this.lineOK) {
      this.path = null;
      return Math.atan2(gy - t.y, gx - t.x);
    }
    this.pathT -= this.dt;
    const stale = !this.path || this.pathI >= this.path.length || this.pathT <= 0 ||
      !this.pathGoal || dist2(this.pathGoal.x, this.pathGoal.y, gx, gy) > 90 * 90;
    // Only a few bots may plan a route each step, so a wave of respawns can't stall a frame.
    if (stale && game.pathBudget <= 0) {
      if (!this.path || this.pathI >= this.path.length) return Math.atan2(gy - t.y, gx - t.x);
    } else if (stale) {
      game.pathBudget--;
      this.path = map.findPath(t.x, t.y, gx, gy, undefined, dry);
      this.skipOK = null;
      this.pathI = 0;
      this.pathGoal = { x: gx, y: gy };
      this.pathT = 1.6 + this.rng.float(0, 0.8);
      if (!this.path) return Math.atan2(gy - t.y, gx - t.x);
    }
    let wp = this.path[this.pathI];
    while (wp && dist(t.x, t.y, wp.x, wp.y) < 34 && this.pathI < this.path.length - 1) {
      this.pathI++;
      wp = this.path[this.pathI];
    }
    // Skip ahead when a later waypoint is already reachable in a straight line.
    if (this.pathI + 1 < this.path.length && this.skipOK !== this.pathI) {
      const nx = this.path[this.pathI + 1];
      if (map.clearPath(t.x, t.y, nx.x, nx.y, dry)) { this.pathI++; wp = nx; }
      else if (this.lineT > 0.05) this.skipOK = this.pathI; // not yet: look again after the next line check
    }
    return Math.atan2(wp.y - t.y, wp.x - t.x);
  }

  combatDirection(game) {
    const t = this.t, s = this.s, e = this.target, map = game.map, g = this.goal;
    const d = dist(t.x, t.y, e.x, e.y);
    const toE = Math.atan2(e.y - t.y, e.x - t.x);

    // "hold" = defend an area: return to it if we drift out.
    if (this.mode === 'hold' && g) {
      const ax = g.areaX !== undefined ? g.areaX : g.x, ay = g.areaY !== undefined ? g.areaY : g.y;
      const ar = g.areaR || g.r || 120;
      if (dist(t.x, t.y, ax, ay) > ar * 0.85) return this.followPath(g.x, g.y, game);
    }

    // Dozer crews ram whatever they're fighting while they still have armor to spare.
    if (t.loadout.hull === 'dozer' && d < 460 && t.hp > t.maxHp * 0.35 && !e.isConvoy && this.mode !== 'hold') {
      return this.followPath(e.x, e.y, game);
    }
    const w = t.loadout.weapon;
    let desired = w === 'flame' ? 150 : w === 'longgun' || w === 'wire' ? s.range + 170 : s.range;
    // Pressing the objective: close in rather than plinking at it from the back.
    if (g && g.focus && e === g.focus) desired = Math.min(desired, 300);
    if (t.hp < t.maxHp * 0.4 && this.rng.next() < s.retreat) desired += 220;
    if (d > desired + (w === 'flame' ? 60 : 130) && this.mode !== 'hold') {
      return this.followPath(e.x, e.y, game);
    }
    if (d < desired - 110) {
      const away = toE + Math.PI;
      if (map.walkable(t.x + Math.cos(away) * 70, t.y + Math.sin(away) * 70)) return away;
    }
    this.strafeT -= this.dt;
    if (s.strafe < 0.3 && this.strafeT > 0) return null;
    if (this.strafeT <= 0) {
      this.strafeT = this.rng.float(1.2, 3.2);
      if (this.rng.next() > s.strafe) { this.strafeT *= 0.6; return null; }
      if (this.rng.chance(0.4)) this.strafeDir *= -1;
    }
    const a = toE + this.strafeDir * (Math.PI / 2 + (d < desired ? 0.35 : -0.25));
    if (!map.walkable(t.x + Math.cos(a) * 80, t.y + Math.sin(a) * 80)) {
      this.strafeDir *= -1;
      return toE + this.strafeDir * Math.PI / 2;
    }
    return a;
  }
}
