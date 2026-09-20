'use strict';
// ---------------------------------------------------------------------------
// Match simulation. Owns the map, tanks, projectiles, specials and mode; emits
// events that the renderer, audio and HUD consume. No DOM access here.
// ---------------------------------------------------------------------------

class Game {
  // settings: { mode, size, difficulty, biome, seed, demo, autopilot, playerName, players,
  //             versus, hits, progression: 'standard'|'leveling'|'freeplay'|'campaign', loadout, botLoadout,
  //             campaign missions add: teamSizes [a, b], skills { ally, enemy }, botTier { ally, enemy },
  //             playerUp { hp, dmg }, twists { night, noRegen, minefield, ace, barrage, enemyHull, enemyRespawn },
  //             rules { limit, time }, mission }
  constructor(settings) {
    this.settings = Object.assign({
      mode: 'tdm', size: 4, difficulty: 'normal', biome: 'grassland',
      seed: (Math.random() * 1e9) >>> 0, demo: false, autopilot: false, playerName: 'You',
      players: 1, versus: false, hits: HITS.default, p2Name: 'P2',
      progression: 'standard', loadout: null, botLoadout: 'standard', recipe: null,
      teamSizes: null, skills: null, botTier: null, playerUp: null, twists: null, rules: null, mission: null,
    }, settings);
    const s = this.settings;
    this.def = MODES[s.mode];
    // Uneven teams play by the rules (map size, limits) of the bigger side.
    if (s.teamSizes && this.def.teams) s.size = rulesSize(Math.max(s.teamSizes[0], s.teamSizes[1]));
    this.oneShot = s.mode === 'oneshot';
    this.leveling = s.progression === 'leveling';
    this.campaign = s.progression === 'campaign';
    this.twists = s.twists || {};
    // Limited visibility: night, fog or sandstorm (one at a time).
    const tw = this.twists;
    this.visibility = tw.night ? 'night' : tw.fog ? 'fog' : tw.sandstorm ? 'sandstorm' : null;
    this.night = !!this.visibility;
    this.visionLimit = { night: 560, fog: 470, sandstorm: 520 }[this.visibility] || Infinity;
    this.liveTime = 0;    // seconds of actual play (for mission timers)
    this.aceKills = 0;    // times a human destroyed the enemy Ace
    this.ace = null;
    this.rng = new RNG(s.seed);
    this.events = [];
    this.tanks = [];
    this.shells = [];
    this.missiles = [];   // guided missiles and bazooka rockets
    this.mines = [];
    this.artillery = [];  // shells in flight
    this.smokes = [];
    this.grenades = [];   // bouncing grenades
    this.airstrikes = []; // called-in strafing runs
    this.time = 0;
    this.phase = 'intro';
    this.introT = s.demo ? 0.01 : 3.2;
    this.overT = 0;
    this.winner = undefined;
    this.player = null;   // player one (kept for single-player code paths)
    this.players = [];    // every human-controlled tank

    this.buildMap();
    this.buildTeams();
    this.mode = new MODE_CLASSES[s.mode](this);
    this.clock = this.def.teams && s.mode !== 'escort' ? TEAM_RULES[s.size].time : s.mode === 'jug' ? JUGGERNAUT.time : Infinity;
    if (s.rules && s.rules.time && isFinite(this.clock)) this.clock = s.rules.time;
    this.respawnTime = this.mode.respawnTime || this.def.respawn;
    this.spawnAll();
    if (this.twists.minefield) this.layMinefield(this.twists.minefield);
    if (this.mode.afterSpawn) this.mode.afterSpawn();
  }

  // Neutral mines scattered over the middle of the map: they hurt everyone.
  // With a convoy road, most of them are buried along it.
  layMinefield(n) {
    const m = this.map, R = new RNG(m.seed ^ 0x3c3c3c), road = m.convoyRoute;
    for (let i = 0, tries = 0; i < n && tries < n * 60; tries++) {
      let x = R.float(m.w * 0.24, m.w * 0.76), y = R.float(90, m.h - 90);
      if (road && R.chance(0.65)) {
        const k = R.int(1, road.length - 1), a = road[k - 1], b = road[k], f = R.next();
        const px = lerp(a.x, b.x, f), py = lerp(a.y, b.y, f), side = R.sign() * R.float(10, 110);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        x = px - Math.sin(ang) * side; y = py + Math.cos(ang) * side;
        if (R.chance(0.5)) { x = m.w - x; y = m.h - y; }
        if (x < m.w * 0.22 || x > m.w * 0.78) continue;
      }
      if (!m.walkable(x, y) || m.pointBlocked(x, y, 30)) continue;
      if (this.mines.some(o => dist2(o.x, o.y, x, y) < 150 * 150)) continue;
      this.mines.push({ x, y, owner: null, team: -1, arm: 0, alive: true, blink: R.float(0, 1.2), age: 5 });
      i++;
    }
  }

  buildMap() {
    const s = this.settings;
    const opts = { seed: s.seed, biome: s.biome, mode: s.mode, recipe: s.recipe || null };
    if (this.def.teams) {
      const [w, h] = TEAM_RULES[s.size].map;
      Object.assign(opts, { w, h, layout: 'teams', hillR: { 1: 150, 2: 175, 4: 210, 10: 260 }[s.size] });
    } else {
      // Juggernaut respawns, so it wants plenty of spread-out spawn points.
      const jug = s.mode === 'jug';
      const w = jug ? JUGGERNAUT.map[s.size] || 2600 : BR_MAP[s.size];
      Object.assign(opts, { w, h: Math.round(w * 0.8), layout: 'ffa', spawnCount: jug ? Math.max(12, s.size * 2) : s.size });
    }
    this.map = new GameMap(opts);
  }

  pickSkill(side) {
    const s = this.settings;
    if (s.skills) return SKILLS[this.rng.pick(s.skills[side] || s.skills.enemy) - 1];
    const d = DIFFICULTIES.find(x => x.id === s.difficulty) || DIFFICULTIES[1];
    return SKILLS[this.rng.pick(d.tiers) - 1];
  }

  // Freeplay: humans use the custom loadout; bots use standard, the same, or random parts.
  // Campaign: the player's hangar build; bots get parts and upgrades from the mission's tech tier.
  loadoutFor(isPlayer, side) {
    const s = this.settings;
    if (this.campaign) {
      if (isPlayer) return Object.assign({}, DEFAULT_LOADOUT, s.loadout || {});
      const L = campaignBotLoadout(this.rng, (s.botTier && s.botTier[side]) || 0);
      if (side === 'enemy' && this.twists.barrage) L.special = 'artillery';
      if (side === 'enemy' && this.twists.enemyHull) L.hull = this.twists.enemyHull;
      return L;
    }
    if (s.progression !== 'freeplay') return Object.assign({}, DEFAULT_LOADOUT);
    const custom = Object.assign({}, DEFAULT_LOADOUT, s.loadout || {});
    if (isPlayer || s.botLoadout === 'player') return custom;
    if (s.botLoadout === 'random') return randomLoadout(this.rng);
    return Object.assign({}, DEFAULT_LOADOUT);
  }

  buildTeams() {
    const s = this.settings;
    const names = this.rng.shuffle(CALLSIGNS.slice());
    let ni = 0;
    const humans = s.demo ? 0 : clamp(s.players | 0, 1, 2);
    // One Shot: a single armor segment and any hit kills (see damage()).
    this.baseHp = this.oneShot ? TANK.shellDamage : clamp(s.hits, HITS.min, HITS.max) * TANK.shellDamage;
    // Campaign: which side a tank fights on decides its skill and tech tier.
    const makeTank = (team, color, isPlayer, roleIdx) => {
      const side = this.def.teams ? (team === 0 ? 'ally' : 'enemy') : 'enemy';
      const skill = isPlayer ? null : this.pickSkill(side);
      const pi = this.players.length;
      const name = isPlayer ? (humans > 1 ? (pi === 0 ? s.playerName : s.p2Name) || 'P' + (pi + 1) : s.playerName) : names[ni++ % names.length];
      const t = new Tank({ name, team, color, isPlayer, skill });
      t.loadout = this.loadoutFor(isPlayer, side);
      if (this.campaign) {
        const up = isPlayer ? s.playerUp || {} : t.loadout.up || {};
        t.hpUp = up.hp || 1;
        t.dmgUp = up.dmg || 1;
        delete t.loadout.up;
      }
      t.recalc(this.baseHp);
      if (isPlayer) { t.humanIndex = pi; this.players.push(t); }
      if (!isPlayer || s.autopilot) {
        t.brain = new BotBrain(t, skill || SKILLS[2], this.rng.int(1, 1e9));
        const every = s.size >= 10 ? 5 : 3;
        if (roleIdx % every === every - 1) t.brain.role = 'defend';
      }
      if (isPlayer && !this.player) this.player = t;
      this.tanks.push(t);
      return t;
    };
    if (this.def.teams) {
      this.teams = TEAM_COLORS.map((c, i) => ({ id: i, name: c.name, color: c, score: 0 }));
      for (let team = 0; team < 2; team++) {
        const count = s.teamSizes ? s.teamSizes[team] : s.size;
        for (let i = 0; i < count; i++) {
          // Co-op: both players on team 0. Versus: P1 leads team 0, P2 leads team 1.
          const isPlayer = s.versus ? i === 0 && team < humans : team === 0 && i < humans;
          makeTank(team, TEAM_COLORS[team], isPlayer, i);
        }
      }
    } else {
      this.teams = [];
      for (let i = 0; i < s.size; i++) {
        const color = ffaColor(i);
        this.teams.push({ id: i, name: 'Solo', color, score: 0 });
        // Battle royale co-op players share team 0 (a duo) and its livery.
        const duo = s.mode === 'br' && !s.versus && i < humans && i > 0;
        makeTank(duo ? 0 : i, duo ? ffaColor(0) : color, i < humans, 0);
      }
    }
    if (this.twists.ace) this.crownAce(this.twists.ace);
  }

  // Campaign boss: one enemy bot becomes a named Ace with a veteran crew,
  // heavier armor and its own signature build.
  crownAce(spec) {
    const pool = this.tanks.filter(t => t.brain && !t.isPlayer && (this.def.teams ? t.team === 1 : true));
    if (!pool.length) return;
    const t = pool[0];
    t.ace = true;
    t.name = spec.name || 'Ace';
    t.skill = SKILLS[(spec.skill || 4) - 1];
    t.brain.s = t.skill;
    t.brain.aggro = true;
    if (spec.loadout) t.loadout = Object.assign({}, DEFAULT_LOADOUT, spec.loadout);
    t.scaleMul = spec.scale || 1;
    t.hpUp *= spec.hp || 1.8;
    t.dmgUp *= spec.dmg || 1.15;
    t.recalc(this.baseHp);
    this.ace = t;
  }

  spawnAll() {
    if (this.def.teams) {
      // Shuffle who goes where so players don't always start in the same zone.
      const idx = [0, 0];
      for (const t of this.rng.shuffle(this.tanks.slice())) {
        const pts = this.map.spawns[t.team];
        const p = pts[idx[t.team]++ % pts.length];
        t.spawnZone = p.zone;
        t.spawn(p.x, p.y, p.angle);
      }
    } else {
      const pts = this.rng.shuffle(this.map.spawns[0].slice());
      let k = 0;
      this.tanks.forEach(t => {
        if (t.humanIndex > 0 && !this.settings.versus) {
          // Duo partner starts next to player one.
          const p1 = this.players[0], p = this.map.randomWalkable(this.rng, p1.x, p1.y, 150, 70);
          t.spawn(p.x, p.y, p1.angle);
          return;
        }
        const p = pts[k++ % pts.length];
        t.spawn(p.x, p.y, p.angle);
      });
    }
  }

  announce(text, sub, color) {
    this.events.push({ type: 'announce', text, sub, color });
  }

  endMatch(team) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.overT = 0;
    this.winner = team;
    if (this.settings.mode === 'br') for (const t of this.tanks) if (t.alive && team === t.team) t.place = 1;
    this.events.push({ type: 'match_over', winner: team });
  }

  // ---- simulation --------------------------------------------------------------
  update(dt) {
    this.time += dt;
    if (this.phase === 'intro') {
      this.introT -= dt;
      if (this.introT <= 0) {
        this.phase = 'live';
        this.events.push({ type: 'go' });
      }
    } else if (this.phase === 'over') this.overT += dt;
    if (this.phase === 'live') this.liveTime += dt;

    this.pathBudget = 3;
    const frozen = this.phase === 'intro';
    // Once the match is decided the battle stops: crews hold fire and coast to a halt.
    const ended = this.phase === 'over';
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.brain && !ended) t.brain.update(dt, this);
      if (frozen || ended) { t.input.throttle = 0; t.input.turn = 0; }
      if (ended) { t.input.fire = false; t.input.missile = false; if (t.isConvoy) continue; }
      if (!t.isConvoy) {
        const tire = PARTS.tires[t.loadout.tires];
        t.surfaceMul = this.map.onWater(t.x, t.y) ? tire.water : this.map.onRoad(t.x, t.y) ? tire.road : tire.off;
      }
      t.move(dt);
    }
    this.collideTanks();
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (!t.isConvoy) this.map.resolveCircle(t, t.radius);
      t.settle(dt);
      if (t.input.fire && t.reload <= 0 && !frozen && !ended) this.fire(t);
      if (t.input.missile && !frozen && !ended) this.useSpecial(t, t.input.missileTarget, t.input.specialPoint);
      t.input.missile = false;
      t.input.specialPoint = null;
    }
    this.updateOffers();
    this.updateShells(dt);
    this.updateMissiles(dt);
    this.updateMines(dt);
    this.updateArtillery(dt);
    this.updateGrenades(dt);
    this.updateAirstrikes(dt);
    this.updateSalvos();
    this.updateFlak(dt);
    this.updateCoax(dt, ended || frozen);
    for (const s of this.smokes) s.life -= dt;
    this.smokes = this.smokes.filter(s => s.life > 0);
    this.updateBurning(dt);

    // Field repairs: a tank that hasn't been hit for a while patches itself up.
    // (Repair kits work regardless; some campaign missions cut the supply lines.)
    for (const t of this.tanks) {
      t.repairing = false;
      if (t.alive && t.repairT > 0) {
        t.repairT = Math.max(0, t.repairT - dt);
        t.hp = Math.min(t.maxHp, t.hp + t.maxHp * REPAIR.amount / REPAIR.time * dt);
        t.repairing = true;
        continue;
      }
      if (!t.alive || t.isConvoy || t.hp >= t.maxHp || frozen || this.twists.noRegen || t.burnT > 0) continue;
      if (this.time - t.lastHitT < TANK.regenDelay) continue;
      if (t.zoneT !== undefined && this.time - t.zoneT < 1) continue;
      t.hp = Math.min(t.maxHp, t.hp + t.maxHp * TANK.regenRate * t.regenMul * dt);
      t.repairing = true;
    }

    if (this.respawnTime) {
      for (const t of this.tanks) {
        if (t.alive || t.isConvoy) continue;
        t.respawnT -= dt;
        if (t.respawnT <= 0 && this.phase === 'live') {
          const p = this.mode.spawnPoint(t);
          t.spawn(p.x, p.y, p.angle);
          this.events.push({ type: 'respawn', tank: t });
        }
      }
    }

    if (this.phase === 'live') {
      this.mode.update(dt);
      if (this.phase === 'live') {
        this.clock -= dt;
        if (this.clock <= 0) { this.clock = 0; this.mode.onTimeUp(); }
      }
    }
  }

  collideTanks() {
    const ts = this.tanks;
    for (let i = 0; i < ts.length; i++) {
      const a = ts[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < ts.length; j++) {
        const b = ts[j];
        if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy, r2 = a.radius + b.radius;
        if (d2 >= r2 * r2) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = r2 - d;
        const nx = d2 ? dx / d : 1, ny = d2 ? dy / d : 0;
        // The convoy is immovable: whoever bumps it gets pushed the whole way.
        const ka = a.isConvoy ? 0 : b.isConvoy ? 1 : 0.5, kb = b.isConvoy ? 0 : a.isConvoy ? 1 : 0.5;
        a.x -= nx * push * ka; a.y -= ny * push * ka;
        b.x += nx * push * kb; b.y += ny * push * kb;
        if (a.team !== b.team && this.phase === 'live') {
          if (a.loadout.hull === 'dozer' && !a.isConvoy) this.ram(a, b, nx, ny);
          if (b.loadout.hull === 'dozer' && !b.isConvoy) this.ram(b, a, -nx, -ny);
        }
      }
    }
  }

  // Dozer blade: driving the blade into an enemy hurts it in proportion to the
  // closing speed and shoves it away. (nx, ny) points from the rammer to the victim.
  ram(a, b, nx, ny) {
    if (Math.abs(angDiff(a.angle, Math.atan2(ny, nx))) > 0.85) return;
    const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (closing < RAM.minSpeed) return;
    const last = a.ramCd.get(b.id);
    if (last !== undefined && this.time - last < RAM.cooldown) return;
    a.ramCd.set(b.id, this.time);
    const dmg = Math.round(Math.min(RAM.max, closing * RAM.perSpeed) * a.dmgMul);
    if (!b.isConvoy) { b.x += nx * RAM.knock; b.y += ny * RAM.knock; b.speed *= 0.3; }
    a.speed *= 0.45;
    const hx = a.x + nx * a.radius, hy = a.y + ny * a.radius;
    this.events.push({ type: 'ram', x: hx, y: hy, angle: Math.atan2(ny, nx), tank: a, target: b });
    this.damage(b, dmg, a, Math.atan2(ny, nx), hx, hy, clamp(closing / 300, 0, 1), 'ram');
  }

  updateBurning(dt) {
    for (const t of this.tanks) {
      if (t.burnT <= 0) continue;
      if (!t.alive) { t.burnT = 0; continue; }
      t.burnT -= dt;
      t.burnAcc += FLAME.burn * dt * (t.burnBy ? t.burnBy.dmgMul : 1);
      if (t.burnAcc >= 2) {
        t.burnAcc -= 2;
        this.damage(t, 2, t.burnBy, 0, t.x, t.y, 0.5, 'burn');
      }
    }
  }

  // ---- weapons ------------------------------------------------------------------------
  fire(t) {
    const w = t.loadout.weapon;
    // One wire-guided missile in the air at a time.
    if (w === 'wire' && t.wireMissile && t.wireMissile.alive) return;
    if (w === 'mg' || w === 'flame') {
      if (t.overheatT > 0) return;
      t.heat += w === 'flame' ? FLAME.heat : MG_HEAT.perShot;
      if (t.heat >= 100) {
        t.heat = 100;
        t.overheatT = MG_HEAT.overheat;
        this.events.push({ type: 'overheat', tank: t });
      }
    }
    t.reload = t.reloadTime;
    t.recoil = 1;
    t.shield = 0;
    t.stats.shots++;
    t.speed -= Math.cos(angDiff(t.angle, t.turret)) * (w === 'mg' || w === 'flame' ? 2 : w === 'bazooka' || w === 'wire' ? 30 : w === 'longgun' ? 44 : w === 'hesh' ? 36 : 28);
    const a = t.turret, ca = Math.cos(a), sa = Math.sin(a), L = TANK.barrelLength * t.scale;
    const muzzles = [];
    if (w === 'double') {
      const o = 5.5 * t.scale;
      muzzles.push([t.x + ca * L - sa * o, t.y + sa * L + ca * o, a], [t.x + ca * L + sa * o, t.y + sa * L - ca * o, a]);
    } else if (w === 'twin') {
      muzzles.push([t.x + ca * L, t.y + sa * L, a], [t.x - ca * L * 0.92, t.y - sa * L * 0.92, a + Math.PI]);
    } else if (w === 'longgun') {
      const L2 = L * 1.6;
      muzzles.push([t.x + ca * L2, t.y + sa * L2, a]);
    } else {
      const jit = w === 'mg' ? BULLET.jitter : w === 'flame' ? FLAME.jitter : 0;
      muzzles.push([t.x + ca * L, t.y + sa * L, jit ? a + this.rng.float(-jit, jit) : a]);
    }
    this.events.push({ type: 'shot', x: muzzles[0][0], y: muzzles[0][1], angle: a, tank: t, weapon: w, muzzles });
    for (const [mx, my, ma] of muzzles) {
      // Barrel poking into a wall: burst on the wall face instead.
      const hit = this.map.raycast(t.x, t.y, mx, my, 3);
      if (hit >= 0) {
        this.events.push({ type: 'impact', kind: 'wall', x: lerp(t.x, mx, hit), y: lerp(t.y, my, hit), angle: ma + Math.PI });
        continue;
      }
      if (w === 'bazooka' || w === 'wire') {
        const r = new Missile(t, null, w === 'wire' ? 'wire' : 'rocket');
        r.x = r.px = mx; r.y = r.py = my; r.angle = ma;
        this.missiles.push(r);
        if (w === 'wire') t.wireMissile = r;
      } else this.shells.push(new Shell(t, mx, my, ma, w === 'mg' ? 'bullet' : w === 'flame' ? 'flame' : w === 'longgun' ? 'long' : w === 'hesh' ? 'hesh' : 'shell'));
    }
  }

  // ---- specials -----------------------------------------------------------------------
  specialCost(t) { return PARTS.special[t.loadout.special].cost; }

  useSpecial(t, target, point) {
    const cost = this.specialCost(t);
    if (t.isConvoy) return;
    // Grenade launcher: a full charge loads two grenades; the second fires on the next press.
    if (t.loadout.special === 'grenades' && t.grenadeAmmo > 0) { this.throwGrenade(t); return; }
    if (t.missileCharge < cost) return;
    const valid = target && target.alive && target.team !== t.team ? target : null;
    switch (t.loadout.special) {
      case 'grenades': t.grenadeAmmo = GRENADE.ammo; this.throwGrenade(t); break;
      case 'salvo':
        for (let i = 0; i < 4; i++) t.salvoQueue.push({ at: this.time + i * SALVO.gap, side: i % 2 ? 1 : -1, row: i < 2 ? 0 : 1 });
        this.events.push({ type: 'salvo', x: t.x, y: t.y, tank: t });
        break;
      case 'flak':
        t.flakT = FLAK.time;
        t.flakCd = 0;
        t.flakAngle = t.turret - 0.4;
        this.events.push({ type: 'flak_on', x: t.x, y: t.y, tank: t });
        break;
      case 'airstrike': this.callAirstrike(t, valid, point); break;
      case 'missile': this.launchMissile(t, valid); break;
      case 'mine': this.dropMine(t); break;
      case 'artillery': this.callArtillery(t, valid, point); break;
      case 'smoke': this.deploySmoke(t); break;
      case 'repair':
        t.repairT = REPAIR.time;
        t.burnT = 0;
        this.events.push({ type: 'repair_kit', x: t.x, y: t.y, tank: t });
        break;
      case 'overdrive':
        t.boostT = OVERDRIVE.time;
        this.events.push({ type: 'overdrive', x: t.x, y: t.y, tank: t });
        break;
    }
    t.missileCharge = 0;
  }

  launchMissile(t, target) {
    const m = new Missile(t, target || this.seekTarget(t.x, t.y, t.turret, t.team, 1.1));
    this.missiles.push(m);
    this.events.push({ type: 'missile_launch', x: m.x, y: m.y, angle: m.angle, tank: t, missile: m });
  }

  dropMine(t) {
    const back = t.radius + 12;
    const mine = { x: t.x - Math.cos(t.angle) * back, y: t.y - Math.sin(t.angle) * back, owner: t, team: t.team, arm: MINE.arm, alive: true, blink: 0, age: 0 };
    const mine0 = this.mines.filter(m => m.owner === t);
    if (mine0.length >= MINE.maxPerTank) {
      mine0[0].alive = false;
      this.events.push({ type: 'impact', kind: 'fizzle', x: mine0[0].x, y: mine0[0].y, angle: 0 });
    }
    this.mines.push(mine);
    this.mines = this.mines.filter(m => m.alive);
    this.events.push({ type: 'mine_drop', x: mine.x, y: mine.y, tank: t });
  }

  updateMines(dt) {
    for (const m of this.mines) {
      if (!m.alive) continue;
      m.age += dt;
      m.arm -= dt;
      m.blink = (m.blink + dt) % 1.2;
      if (m.arm > 0) continue;
      for (const t of this.tanks) {
        if (!t.alive || t.team === m.team) continue;
        const r = t.radius * 0.95 + MINE.reach;
        const dx = m.x - t.x, dy = m.y - t.y;
        if (dx * dx + dy * dy > r * r) continue;
        // Straight over the middle hurts most; pinching it with a track edge least.
        const lateral = Math.abs(dx * Math.sin(t.angle) - dy * Math.cos(t.angle));
        const q = 1 - clamp(lateral / r, 0, 1);
        const dmg = Math.round((MINE.min + (MINE.max - MINE.min) * q) * (m.owner ? m.owner.dmgMul : 1));
        m.alive = false;
        this.events.push({ type: 'mine_boom', x: m.x, y: m.y });
        this.damage(t, dmg, m.owner, t.angle, m.x, m.y, q, 'mine');
        this.splash(m.x, m.y, MINE.splashRadius, MINE.splashDamage, m.owner, m.team, t);
        break;
      }
    }
    this.mines = this.mines.filter(m => m.alive);
  }

  callArtillery(t, target, point) {
    let p = point;
    if (!p) p = target ? { x: target.x, y: target.y } : { x: t.x + Math.cos(t.turret) * 500, y: t.y + Math.sin(t.turret) * 500 };
    const d = dist(t.x, t.y, p.x, p.y);
    if (d > ARTY.range) p = { x: t.x + (p.x - t.x) / d * ARTY.range, y: t.y + (p.y - t.y) / d * ARTY.range };
    t.artyQueue = [];
    for (let i = 0; i < ARTY.shells; i++) t.artyQueue.push({ at: this.time + i * ARTY.gap, target, x: p.x, y: p.y });
    this.events.push({ type: 'arty_call', tank: t, x: p.x, y: p.y });
  }

  updateArtillery(dt) {
    for (const t of this.tanks) {
      if (!t.artyQueue.length) continue;
      if (!t.alive) { t.artyQueue = []; continue; }
      while (t.artyQueue.length && this.time >= t.artyQueue[0].at) {
        const q = t.artyQueue.shift();
        const tg = q.target && q.target.alive ? q.target : null;
        const bx = tg ? tg.x + tg.vx * 0.6 : q.x, by = tg ? tg.y + tg.vy * 0.6 : q.y;
        const a = this.rng.float(0, TAU), r = Math.sqrt(this.rng.next()) * ARTY.scatter;
        const sx = t.x - Math.cos(t.angle) * 18 * t.scale, sy = t.y - Math.sin(t.angle) * 18 * t.scale;
        const tx = bx + Math.cos(a) * r, ty = by + Math.sin(a) * r;
        const d = dist(sx, sy, tx, ty);
        this.artillery.push({ sx, sy, tx, ty, k: 0, dur: 1.0 + d / 1400, peak: 140 + d * 0.22, owner: t, team: t.team, x: sx, y: sy, h: 0 });
        this.events.push({ type: 'arty_launch', x: sx, y: sy, tank: t });
      }
    }
    for (const s of this.artillery) {
      if (s.done) continue; // shot down
      s.k += dt / s.dur;
      const k = Math.min(1, s.k);
      s.x = lerp(s.sx, s.tx, k);
      s.y = lerp(s.sy, s.ty, k);
      s.h = Math.sin(Math.PI * k) * s.peak;
      if (s.k >= 1) {
        s.done = true;
        this.events.push({ type: 'arty_boom', x: s.tx, y: s.ty });
        this.splash(s.tx, s.ty, ARTY.radius, ARTY.damage, s.owner, s.team, null, 'artillery', ARTY.edge);
      }
    }
    this.artillery = this.artillery.filter(s => !s.done);
  }

  // ---- grenade launcher ----
  throwGrenade(t) {
    t.grenadeAmmo = Math.max(0, t.grenadeAmmo - 1);
    const a = t.turret, side = t.grenadeAmmo % 2 ? 1 : -1;
    const ox = t.x + (Math.cos(a) * 10 - Math.sin(a) * 12.4 * side) * t.scale, oy = t.y + (Math.sin(a) * 10 + Math.cos(a) * 12.4 * side) * t.scale;
    this.grenades.push({ x: ox, y: oy, vx: Math.cos(a) * GRENADE.speed + t.vx * 0.5, vy: Math.sin(a) * GRENADE.speed + t.vy * 0.5, fuse: GRENADE.fuse, owner: t, team: t.team, alive: true, spin: 0, bounces: 0 });
    this.events.push({ type: 'grenade_launch', x: ox, y: oy, tank: t });
  }

  updateGrenades(dt) {
    const map = this.map, r = GRENADE.size;
    for (const g of this.grenades) {
      if (!g.alive) continue;
      g.fuse -= dt;
      g.age = (g.age || 0) + dt;
      const d = Math.exp(-GRENADE.drag * dt);
      g.vx *= d; g.vy *= d;
      const sp = Math.hypot(g.vx, g.vy);
      g.spin += sp * dt * 0.08;
      g.x += g.vx * dt; g.y += g.vy * dt;
      // Bounce off walls, rocks and the map edge.
      const o = map.projectileHit(g.x, g.y, r);
      if (o) {
        let nx, ny;
        if (o.shape === 'rect') { const px = clamp(g.x, o.x, o.x + o.w), py = clamp(g.y, o.y, o.y + o.h); nx = g.x - px; ny = g.y - py; if (!nx && !ny) { nx = -g.vx; ny = -g.vy; } }
        else { nx = g.x - o.cx; ny = g.y - o.cy; }
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        const vn = g.vx * nx + g.vy * ny;
        if (vn < 0) { g.vx = (g.vx - 2 * vn * nx) * GRENADE.bounce; g.vy = (g.vy - 2 * vn * ny) * GRENADE.bounce; }
        g.x -= g.vx * dt; g.y -= g.vy * dt;
        if (sp > 90 && g.age - (g.lastBounce || -1) > 0.15) { g.lastBounce = g.age; this.events.push({ type: 'grenade_bounce', x: g.x, y: g.y }); }
      }
      if (g.x < r || g.x > map.w - r) { g.vx = -g.vx * GRENADE.bounce; g.x = clamp(g.x, r, map.w - r); }
      if (g.y < r || g.y > map.h - r) { g.vy = -g.vy * GRENADE.bounce; g.y = clamp(g.y, r, map.h - r); }
      let hit = g.fuse <= 0;
      if (!hit) for (const t of this.tanks) if (t.alive && t.team !== g.team && dist2(t.x, t.y, g.x, g.y) < (t.radius + r) ** 2) { hit = true; break; }
      if (hit) this.burstGrenade(g);
    }
    this.grenades = this.grenades.filter(g => g.alive);
  }

  burstGrenade(g) {
    g.alive = false;
    this.events.push({ type: 'grenade_boom', x: g.x, y: g.y });
    this.splash(g.x, g.y, GRENADE.radius, GRENADE.damage, g.owner, g.team, null, 'grenade', GRENADE.edge);
  }

  // ---- quad missiles: four rockets from the rear pods, straight ahead of the hull ----
  updateSalvos() {
    for (const t of this.tanks) {
      if (!t.salvoQueue.length) continue;
      if (!t.alive) { t.salvoQueue = []; continue; }
      while (t.salvoQueue.length && this.time >= t.salvoQueue[0].at) {
        const q = t.salvoQueue.shift(), a = t.angle, s = t.scale;
        const lx = -10, ly = q.side * (17 + (q.row ? 1.9 : -1.9));
        const x = t.x + (Math.cos(a) * lx - Math.sin(a) * ly) * s, y = t.y + (Math.sin(a) * lx + Math.cos(a) * ly) * s;
        const m = new Missile(t, null, 'salvo');
        m.x = m.px = x; m.y = m.py = y;
        m.angle = a - q.side * SALVO.converge;   // the four rockets cross a few hundred px ahead
        this.missiles.push(m);
        this.events.push({ type: 'salvo_launch', x, y, angle: m.angle, tank: t });
      }
    }
  }

  // ---- anti-air rounds: shoot down hostile explosives near the tank ----
  updateFlak(dt) {
    for (const t of this.tanks) {
      if (t.flakT <= 0) continue;
      if (!t.alive) { t.flakT = 0; continue; }
      t.flakT -= dt;
      t.flakCd -= dt;
      if (t.flakCd > 0) continue;
      const R2 = FLAK.radius * FLAK.radius;
      let best = null, bd = R2, bx = 0, by = 0, arty = false;
      for (const m of this.missiles) {
        if (!m.alive || m.team === t.team) continue;
        const d = dist2(t.x, t.y, m.x, m.y);
        if (d < bd) { bd = d; best = m; bx = m.x; by = m.y; arty = false; }
      }
      for (const g of this.grenades) {
        if (!g.alive || g.team === t.team) continue;
        const d = dist2(t.x, t.y, g.x, g.y);
        if (d < bd) { bd = d; best = g; bx = g.x; by = g.y; arty = false; }
      }
      for (const s of this.artillery) {
        if (s.done || s.team === t.team || s.k < 0.45) continue;
        const d = dist2(t.x, t.y, s.x, s.y);
        if (d < bd) { bd = d; best = s; bx = s.x; by = s.y - s.h * 0.6; arty = true; }
      }
      if (!best) continue;
      // Not every burst finds its mark.
      t.flakCd = FLAK.rate;
      const kill = this.rng.chance(FLAK.hit);
      if (kill) { if (arty) best.done = true; else best.alive = false; }
      t.flakAngle = Math.atan2(by - t.y, bx - t.x);
      this.events.push({ type: 'intercept', x: bx + (kill ? 0 : this.rng.float(-26, 26)), y: by + (kill ? 0 : this.rng.float(-26, 26)), fx: t.x, fy: t.y, tank: t, kill });
    }
  }

  // ---- coaxial MG: rattles away between cannon shots ----
  updateCoax(dt, hold) {
    for (const t of this.tanks) {
      if (!t.alive || t.loadout.weapon !== 'coax') continue;
      t.coaxT -= dt;
      if (hold || !t.input.fire || t.reload < 0.12 || t.coaxT > 0) continue;
      t.coaxT = COAX.interval;
      const a = t.turret, ca = Math.cos(a), sa = Math.sin(a), s = t.scale;
      const mx = t.x + (ca * 27 - sa * 6) * s, my = t.y + (sa * 27 + ca * 6) * s;
      if (this.map.raycast(t.x, t.y, mx, my, 2) >= 0) continue;
      this.shells.push(new Shell(t, mx, my, a + this.rng.float(-COAX.jitter, COAX.jitter), 'coax'));
      this.events.push({ type: 'shot', x: mx, y: my, angle: a, tank: t, weapon: 'coaxmg', muzzles: [[mx, my, a]] });
    }
  }

  // ---- airstrike: a fighter-bomber runs a line through the marked spot ----
  callAirstrike(t, target, point) {
    let p = point || (target ? { x: target.x, y: target.y } : { x: t.x + Math.cos(t.turret) * 520, y: t.y + Math.sin(t.turret) * 520 });
    const d = dist(t.x, t.y, p.x, p.y);
    if (d > AIRSTRIKE.range) p = { x: t.x + (p.x - t.x) / d * AIRSTRIKE.range, y: t.y + (p.y - t.y) / d * AIRSTRIKE.range };
    // The run crosses the target side-on, so the bombs never walk back onto the caller.
    const a = (d > 20 ? Math.atan2(p.y - t.y, p.x - t.x) : t.turret) + (this.rng.chance(0.5) ? 1 : -1) * Math.PI / 2;
    const s = { x: p.x, y: p.y, a, t: 0, owner: t, team: t.team, next: 0, done: false, target: target && !point ? target : null };
    // A marked tank near the spot: the pilot follows it until the final approach.
    if (target && point && dist(target.x, target.y, point.x, point.y) < 110) s.target = target;
    this.airstrikes.push(s);
    this.events.push({ type: 'air_call', x: p.x, y: p.y, tank: t, strike: s });
  }

  updateAirstrikes(dt) {
    const A = AIRSTRIKE, step = A.length / (A.bombs - 1);
    for (const s of this.airstrikes) {
      s.t += dt;
      if (s.target && s.target.alive && s.t < A.delay - A.commit) {
        const tx = s.target.x + s.target.vx * 0.5, ty = s.target.y + s.target.vy * 0.5, d = dist(s.x, s.y, tx, ty), step = A.track * dt;
        if (d > step) { s.x += (tx - s.x) / d * step; s.y += (ty - s.y) / d * step; } else { s.x = tx; s.y = ty; }
      }
      // Plane position along the run (0 = centre of the marked line).
      s.along = (s.t - A.delay) * A.planeSpeed - A.length / 2;
      if (!s.passed && s.along > -A.length / 2 - 600) { s.passed = true; this.events.push({ type: 'air_pass', x: s.x, y: s.y }); }
      while (s.next < A.bombs && s.along >= -A.length / 2 + s.next * step) {
        const off = -A.length / 2 + s.next * step, j = this.rng.float(-14, 14);
        const bx = s.x + Math.cos(s.a) * off - Math.sin(s.a) * j, by = s.y + Math.sin(s.a) * off + Math.cos(s.a) * j;
        this.events.push({ type: 'air_boom', x: bx, y: by });
        this.splash(bx, by, A.radius, A.damage, s.owner, s.team, null, 'airstrike', A.edge);
        s.next++;
      }
      if (s.along > A.length / 2 + 1400) s.done = true;
    }
    this.airstrikes = this.airstrikes.filter(s => !s.done);
  }

  // Blast damage to enemies within radius, falling from `dmg` to `edge`.
  splash(x, y, radius, dmg, owner, team, except, kind = 'splash', edge = 4) {
    for (const t of this.tanks) {
      if (!t.alive || t === except || t.team === team) continue;
      const d = Math.max(0, dist(x, y, t.x, t.y) - t.radius);
      if (d >= radius) continue;
      const amount = Math.max(edge, Math.round(dmg * (1 - d / radius) * (owner ? owner.dmgMul : 1)));
      this.damage(t, amount, owner, Math.atan2(t.y - y, t.x - x), t.x, t.y, 1 - d / radius, kind);
    }
  }

  deploySmoke(t) {
    this.smokes.push({ x: t.x, y: t.y, r: SMOKE.radius, life: SMOKE.life, max: SMOKE.life, owner: t, team: t.team, seed: this.rng.int(1, 1e6) });
    this.events.push({ type: 'smoke', x: t.x, y: t.y, tank: t });
  }

  // Smoke hides whatever is inside it (after it has had a moment to billow).
  inSmoke(x, y) {
    for (const s of this.smokes) if (s.max - s.life > 0.5 && s.life > 0.4 && dist2(x, y, s.x, s.y) < (s.r * 0.85) ** 2) return true;
    return false;
  }
  smokeBlocks(x1, y1, x2, y2) {
    for (const s of this.smokes) {
      if (s.max - s.life < 0.5 || s.life < 0.4) continue;
      const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy || 1;
      const u = clamp(((s.x - x1) * dx + (s.y - y1) * dy) / l2, 0, 1);
      if (dist2(x1 + dx * u, y1 + dy * u, s.x, s.y) < (s.r * 0.7) ** 2) return true;
    }
    return false;
  }

  // Closest visible enemy inside a cone ahead of (x, y, heading).
  seekTarget(x, y, heading, team, cone) {
    let best = null, bestScore = Infinity;
    for (const e of this.tanks) {
      if (!e.alive || e.team === team) continue;
      const d = dist(x, y, e.x, e.y);
      if (d > MISSILE.seekRange) continue;
      const off = Math.abs(angDiff(heading, Math.atan2(e.y - y, e.x - x)));
      if (off > cone) continue;
      if (!this.map.lineOfSight(x, y, e.x, e.y, 2) || this.inSmoke(e.x, e.y)) continue;
      const score = d * (1 + off);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  updateMissiles(dt) {
    const map = this.map;
    for (const m of this.missiles) {
      if (!m.alive) continue;
      m.age += dt;
      m.px = m.x; m.py = m.y;
      m.speed = Math.min(m.maxSpeed, m.speed + MISSILE.accel * dt);
      if (m.wire) {
        // Rides the owner's line of sight: steer for a point just ahead of it along the turret.
        const o = m.owner;
        if (o.alive && !m.cut) {
          const L = dist(o.x, o.y, m.x, m.y) + WIRE.lead;
          const want = Math.atan2(o.y + Math.sin(o.turret) * L - m.y, o.x + Math.cos(o.turret) * L - m.x);
          m.angle = rotateToward(m.angle, want, WIRE.turn * dt);
        } else m.cut = true;
      } else if (!m.rocket) {
        if (m.target && !m.target.alive) m.target = null;
        if (!m.target && !m.committed && m.age > MISSILE.arm) {
          m.seekT -= dt;
          if (m.seekT <= 0) { m.seekT = 0.25; m.target = this.seekTarget(m.x, m.y, m.angle, m.team, 0.9); }
        }
        // Steer for the intercept point with a limited turn rate. In the last
        // stretch it commits to its line, so a well-timed juke (or cover) beats it.
        if (m.target && !m.committed && m.age > MISSILE.arm) {
          const tg = m.target, d = dist(m.x, m.y, tg.x, tg.y);
          if (d < MISSILE.commit) m.committed = true;
          else if (Math.abs(angDiff(m.angle, Math.atan2(tg.y - m.y, tg.x - m.x))) > MISSILE.cone) m.target = null;
          else {
            const tt = d / m.speed;
            const want = Math.atan2(tg.y + tg.vy * tt * MISSILE.lead - m.y, tg.x + tg.vx * tt * MISSILE.lead - m.x);
            m.angle = rotateToward(m.angle, want, MISSILE.turnRate * dt);
          }
        }
        m.blink = Math.max(0, m.blink - dt * 6);
        // Beeps speed up the longer it flies.
        m.beepT -= dt;
        if (m.beepT <= 0) {
          const k = clamp(m.age / MISSILE.life, 0, 1);
          m.beepT = lerp(0.5, 0.06, Math.pow(k, 1.2));
          m.blink = 1;
          this.events.push({ type: 'missile_beep', x: m.x, y: m.y, missile: m });
        }
      }
      m.x += Math.cos(m.angle) * m.speed * dt;
      m.y += Math.sin(m.angle) * m.speed * dt;

      const sx = m.x - m.px, sy = m.y - m.py, sl2 = sx * sx + sy * sy || 1;
      let hitTank = null, hitU = 2;
      for (const t of this.tanks) {
        if (!t.alive || t.team === m.team) continue;
        const u = clamp(((t.x - m.px) * sx + (t.y - m.py) * sy) / sl2, 0, 1);
        const cx = m.px + sx * u, cy = m.py + sy * u, rr = t.radius + MISSILE.radius;
        if (dist2(cx, cy, t.x, t.y) < rr * rr && u < hitU) { hitU = u; hitTank = t; }
      }
      const wallU = map.raycast(m.px, m.py, m.x, m.y, MISSILE.radius);
      if (hitTank && (wallU < 0 || hitU <= wallU)) {
        const hx = m.px + sx * hitU, hy = m.py + sy * hitU;
        const off = Math.abs((hitTank.x - m.px) * sy - (hitTank.y - m.py) * sx) / Math.sqrt(sl2);
        const rr = hitTank.radius + MISSILE.radius;
        this.explodeMissile(m, hx, hy, hitTank, 1 - clamp((off - 3) / (rr - 5), 0, 1));
      } else if (wallU >= 0) {
        this.explodeMissile(m, m.px + sx * wallU, m.py + sy * wallU, null, 0);
      } else if (m.age >= m.life || m.x < -60 || m.y < -60 || m.x > map.w + 60 || m.y > map.h + 60) {
        this.explodeMissile(m, m.x, m.y, null, 0);
      }
    }
    this.missiles = this.missiles.filter(m => m.alive);
  }

  // Direct hit by location (missile 60 ± 15, rocket 40 ± 10, ...), then a blast.
  explodeMissile(m, x, y, direct, quality) {
    m.alive = false;
    m.hitTank = direct;
    const K = MISSILE_KINDS[m.kind], P = K.P;
    this.events.push({ type: 'missile_boom', x, y, direct: !!direct, owner: m.owner, rocket: m.rocket, kind: m.kind });
    const owner = m.owner;
    if (direct) {
      const dmg = Math.round((P.damage + P.spread * (2 * quality - 1)) * owner.dmgMul);
      this.damage(direct, dmg, owner, m.angle, x, y, quality, K.dmgKind);
    }
    this.splash(x, y, P.splashRadius, P.splashDamage, owner, m.team, direct);
  }

  updateShells(dt) {
    const map = this.map;
    for (const s of this.shells) {
      if (!s.alive) continue;
      s.px = s.x; s.py = s.y;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.age += dt;
      const sx = s.x - s.px, sy = s.y - s.py, sl2 = sx * sx + sy * sy;

      // Earliest tank along this step's segment.
      let hitTank = null, hitU = 2;
      for (const t of this.tanks) {
        if (!t.alive || t === s.owner || t.team === s.team) continue;
        const u = clamp(((t.x - s.px) * sx + (t.y - s.py) * sy) / sl2, 0, 1);
        const cx = s.px + sx * u, cy = s.py + sy * u, rr = t.radius + s.radius;
        if (dist2(cx, cy, t.x, t.y) < rr * rr && u < hitU) { hitU = u; hitTank = t; }
      }
      const wallU = map.raycast(s.px, s.py, s.x, s.y, s.radius);

      if (hitTank && (wallU < 0 || hitU <= wallU)) {
        const hx = s.px + sx * hitU, hy = s.py + sy * hitU;
        s.alive = false;
        // Hit location: dead centre adds damage, grazing the tracks removes it.
        const off = Math.abs((hitTank.x - s.px) * sy - (hitTank.y - s.py) * sx) / Math.sqrt(sl2);
        const q = 1 - clamp((off - 3) / (hitTank.radius + s.radius - 5), 0, 1);
        const dmg = Math.max(1, Math.round(s.damage + s.spread * (2 * q - 1)));
        if (s.flame && hitTank.shield <= 0 && hitTank.invuln <= 0 && !hitTank.isConvoy) {
          hitTank.burnT = FLAME.burnTime;
          hitTank.burnBy = s.owner;
        }
        this.damage(hitTank, dmg, s.owner, s.angle, hx, hy, q, s.bullet ? 'bullet' : s.flame ? 'flame' : s.hesh ? 'hesh' : 'shell');
        if (s.hesh) { this.events.push({ type: 'impact', kind: 'hesh', x: hx, y: hy, angle: s.angle + Math.PI }); this.splash(hx, hy, HESH.splashRadius, HESH.splashDamage, s.owner, s.team, hitTank, 'hesh', 3); }
      } else if (wallU >= 0) {
        s.alive = false;
        s.x = s.px + sx * wallU; s.y = s.py + sy * wallU;
        if (s.flame) this.events.push({ type: 'impact', kind: 'flame', x: s.x, y: s.y, angle: s.angle + Math.PI });
        else if (s.hesh) { this.events.push({ type: 'impact', kind: 'hesh', x: s.x, y: s.y, angle: s.angle + Math.PI }); this.splash(s.x, s.y, HESH.splashRadius, HESH.splashDamage, s.owner, s.team, null, 'hesh', 3); }
        else this.events.push({ type: 'impact', kind: 'wall', x: s.x, y: s.y, angle: s.angle + Math.PI, small: s.bullet });
      } else if (s.age >= s.life || s.x < -50 || s.y < -50 || s.x > map.w + 50 || s.y > map.h + 50) {
        s.alive = false;
        if (!s.bullet && !s.flame) this.events.push({ type: 'impact', kind: 'fizzle', x: s.x, y: s.y, angle: s.angle });
      }
    }
    this.shells = this.shells.filter(s => s.alive);
  }

  // quality: 1 = dead-centre hit, 0 = edge of the tracks.
  // kind: 'shell' | 'bullet' | 'flame' | 'burn' | 'ram' | 'missile' | 'rocket' | 'splash' | 'mine' | 'artillery'.
  // Only gun damage (shells, bullets and flames) charges the special.
  damage(target, amount, shooter, angle, x, y, quality = 0.5, kind = 'shell') {
    if (!target.alive) return;
    if (target.shield > 0 || target.invuln > 0 || this.phase === 'over') {
      if (kind !== 'burn') this.events.push({ type: 'impact', kind: 'shield', x, y, angle: angle + Math.PI, target });
      return;
    }
    if (EXPLOSIVE.has(kind)) amount = Math.max(1, Math.round(amount * target.explosiveMul));
    // Sloped armor: glancing blows off the front plates, weak at the back.
    // Side skirts: side hits and rockets. Fuel drums: weak from behind (and they burn).
    let deflect = 0;
    const hull = PARTS.hull[target.loadout.hull];
    if ((hull.front || hull.rear || hull.side) && DIRECTIONAL.has(kind)) {
      const rel = Math.abs(angDiff(target.angle, angle + Math.PI));
      if (rel < 1.05) { if (hull.front) { amount = Math.max(1, Math.round(amount * hull.front)); deflect = 1; } }
      else if (rel > 2.2) {
        if (hull.rear) { amount = Math.round(amount * hull.rear); deflect = -1; }
        if (hull.rearFire && !target.isConvoy && this.rng.chance(hull.rearFire)) { target.burnT = FLAME.burnTime; target.burnBy = shooter; }
      } else if (hull.side) { amount = Math.max(1, Math.round(amount * hull.side)); deflect = 1; }
    }
    if (hull.rocketMul && ROCKET_KINDS.has(kind)) amount = Math.max(1, Math.round(amount * hull.rocketMul));
    // One Shot: every hit is lethal (machine-gun rounds, flames and burns don't count).
    if (this.oneShot && !target.isConvoy && kind !== 'bullet' && kind !== 'flame' && kind !== 'burn') amount = Math.max(amount, target.hp);
    target.hp -= amount;
    target.flash = 1;
    target.lastHitBy = shooter;
    target.lastHitT = this.time;
    if (shooter) {
      target.damagers.set(shooter, this.time);
      shooter.stats.damage += amount;
      if (target.isConvoy) { shooter.stats.convoy += amount; this.award(shooter, amount * XP.convoyDmg); }
      else this.award(shooter, amount * XP.dmg);
      if (GUN_KINDS.has(kind)) {
        shooter.stats.hits++;
        const cost = this.specialCost(shooter), was = shooter.missileCharge;
        shooter.missileCharge = Math.min(cost, was + amount * shooter.chargeMul);
        if (was < cost && shooter.missileCharge >= cost) this.events.push({ type: 'missile_ready', tank: shooter });
      }
    }
    this.events.push({ type: 'hit', x, y, angle, target, shooter, dmg: amount, quality, kind, deflect, lethal: target.hp <= 0 });
    if (target.hp <= 0) this.kill(target, shooter);
  }

  zoneDamage(t, amount) {
    t.hp -= amount;
    t.zoneT = this.time;
    if (t.hp <= 0) this.kill(t, t.lastHitBy && this.time - t.lastHitT < 6 ? t.lastHitBy : null, 'zone');
  }

  kill(victim, killer, cause) {
    victim.hp = 0;
    victim.alive = false;
    victim.stats.deaths++;
    victim.respawnT = this.respawnTime * (this.twists.enemyRespawn && victim.team === 1 && this.def.teams ? this.twists.enemyRespawn : 1);
    victim.killedBy = killer;
    victim.streak = 0;
    victim.burnT = 0;
    victim.repairT = 0;
    victim.boostT = 0;
    victim.flakT = 0;
    victim.salvoQueue = [];
    if (victim.ace && killer && killer.isPlayer) {
      this.aceKills++;
      this.announce(victim.name + ' destroyed', 'The enemy Ace is down', '#ffc850');
    }
    if (killer && killer !== victim) {
      if (!victim.isConvoy) {
        killer.stats.kills++;
        this.award(killer, XP.kill);
        killer.streak++;
        const bonus = XP.streaks[killer.streak];
        if (bonus) {
          this.award(killer, bonus);
          this.events.push({ type: 'streak', tank: killer, streak: killer.streak });
        }
      }
      // Assists: anyone else who hurt the victim in the last 8 seconds.
      for (const [t, when] of victim.damagers) {
        if (t === killer || this.time - when > 8 || t.team === victim.team) continue;
        t.stats.assists++;
        this.award(t, XP.assist);
      }
    }
    victim.damagers.clear();
    this.events.push({ type: 'kill', victim, killer, cause, x: victim.x, y: victim.y });
    this.mode.onKill(victim, killer);
    victim.carrying = null;
  }

  // ---- combat score, levels and upgrades -------------------------------------------------
  award(t, amount) {
    if (!t || t.isConvoy || !(amount > 0) || this.phase !== 'live') return;
    t.stats.xp += amount;
    if (!this.leveling) return;
    while (t.level - 1 < XP.levels.length && t.stats.xp >= XP.levels[t.level - 1]) {
      t.level++;
      t.pendingOffers = (t.pendingOffers || 0) + 1;
    }
    if (t.pendingOffers && !t.offer) this.openOffer(t);
  }

  openOffer(t) {
    t.pendingOffers--;
    t.offer = { options: makeOffers(t.loadout, this.rng), expires: this.time + OFFER.time, level: t.level };
    // Bots (and autopiloted players) choose after a short think.
    if (t.brain) t.offer.botAt = this.time + this.rng.float(0.6, 2);
    if (t.alive) t.invuln = OFFER.invuln;
    this.events.push({ type: 'levelup', tank: t, level: t.level });
  }

  // idx < 0 keeps the current build.
  pickOffer(t, idx) {
    const o = t.offer;
    if (!o) return;
    const pick = o.options[idx];
    t.offer = null;
    if (pick) {
      t.loadout[pick.slot] = pick.id;
      t.recalc(this.baseHp);
      t.missileCharge = Math.min(t.missileCharge, this.specialCost(t));
      if (t.loadout.weapon !== 'mg' && t.loadout.weapon !== 'flame') { t.heat = 0; t.overheatT = 0; }
      this.events.push({ type: 'upgrade', tank: t, slot: pick.slot, id: pick.id });
    }
    if (t.pendingOffers > 0) this.openOffer(t);
  }

  updateOffers() {
    for (const t of this.tanks) {
      const o = t.offer;
      if (!o) continue;
      if (o.botAt !== undefined && this.time >= o.botAt) this.pickOffer(t, this.rng.int(0, o.options.length - 1));
      else if (this.time >= o.expires) this.pickOffer(t, -1);
    }
  }

  // Seconds of match played, for the results card.
  get elapsed() { return this.time; }
}
