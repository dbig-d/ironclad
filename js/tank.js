'use strict';
// ---------------------------------------------------------------------------
// Tank and shell entities. Pure simulation, no drawing.
// ---------------------------------------------------------------------------

let NEXT_TANK_ID = 1;

class Tank {
  constructor({ name, team, color, isPlayer = false, skill = null }) {
    this.id = NEXT_TANK_ID++;
    this.name = name;
    this.team = team;
    this.color = color;
    this.isPlayer = isPlayer;
    this.skill = skill;
    this.brain = null;

    this.x = 0; this.y = 0;
    this.angle = 0;       // hull heading
    this.turret = 0;      // turret heading (world space)
    this.speed = 0;       // signed speed along hull heading
    this.turnVel = 0;
    this.vx = 0; this.vy = 0;

    this.maxHp = TANK.hp;
    this.hp = this.maxHp;
    this.alive = false;
    this.reload = 0;
    this.respawnT = 0;
    this.shield = 0;
    this.eliminated = false; // battle royale: out for good

    // cosmetic state read by the renderer
    this.recoil = 0;
    this.flash = 0;
    this.treadL = 0;
    this.treadR = 0;
    this.spawnFx = 0;

    this.input = { throttle: 0, turn: 0, aim: 0, fire: false, missile: false, missileTarget: null };
    this.missileCharge = 0; // earned by dealing shell damage; kept through respawns
    this.scale = 1;         // Juggernaut is bigger
    this.scaleMul = 1;      // campaign bosses can be oversized too
    this.reloadTime = TANK.reload;
    this.dmgMul = 1;
    this.regenMul = 1;
    this.score = 0;         // Juggernaut points
    this.stats = { kills: 0, deaths: 0, damage: 0, shots: 0, hits: 0, caps: 0, assists: 0, xp: 0, hill: 0, convoy: 0 };
    // Parts (Leveling / Freeplay) and the stats derived from them.
    this.loadout = Object.assign({}, DEFAULT_LOADOUT);
    this.level = 1;
    this.offer = null;        // pending level-up choice
    this.streak = 0;
    this.speedMul = 1;
    this.surfaceMul = 1;
    this.turnMul = 1;         // tires
    this.accelMul = 1;
    this.slide = 0;           // armored car wheels: turning drops off at speed
    this.pivot = 1;           // neutral steer: turning boost when stopped
    this.chargeMul = 1;       // fuel drums: specials charge faster
    this.coaxT = 0;           // coaxial MG between cannon shots
    this.grenadeAmmo = 0;     // grenade launcher shots left from this charge
    this.salvoQueue = [];     // quad missiles still to fire
    this.flakT = 0;           // anti-air rounds running
    this.flakCd = 0;
    this.flakAngle = 0;
    this.wireMissile = null;  // wire-guided missile in flight
    this.hpUp = 1;            // campaign hangar upgrades (armor plating, gun calibre)
    this.dmgUp = 1;
    this.burnT = 0;           // set alight by a flamethrower
    this.burnBy = null;
    this.burnAcc = 0;
    this.repairT = 0;         // field repair kit running
    this.boostT = 0;          // engine overdrive running
    this.ramCd = new Map();   // dozer blade: tank id -> time of the last ram
    this.explosiveMul = 1;
    this.heat = 0;            // machine gun
    this.overheatT = 0;
    this.invuln = 0;          // level-up protection (firing doesn't cancel it)
    this.artyQueue = [];
    this.damagers = new Map(); // tank -> last time it hurt us (assists)
    this.carrying = null;
    this.lastHitBy = null;
    this.lastHitT = -99;
    this.place = 0;
  }

  spawn(x, y, angle) {
    this.x = x; this.y = y;
    this.angle = angle;
    this.turret = angle;
    this.input.aim = angle;
    this.speed = 0; this.turnVel = 0;
    this.vx = 0; this.vy = 0;
    this.hp = this.maxHp;
    this.alive = true;
    this.reload = 0.4;
    this.shield = TANK.spawnShield;
    this.recoil = 0; this.flash = 0;
    this.spawnFx = 1;
    this.carrying = null;
    this.lastHitBy = null;
    this.heat = 0; this.overheatT = 0; this.streak = 0;
    this.burnT = 0; this.burnBy = null; this.burnAcc = 0; this.repairT = 0; this.boostT = 0;
    this.coaxT = 0; this.grenadeAmmo = 0; this.salvoQueue = []; this.flakT = 0; this.wireMissile = null;
    this.artyQueue = [];
    this.damagers.clear();
    if (this.brain) this.brain.reset();
  }

  // Recompute stats from base armor, parts, hangar upgrades and (Juggernaut) crown.
  recalc(baseHp) {
    const hull = PARTS.hull[this.loadout.hull], wpn = PARTS.weapon[this.loadout.weapon], tire = PARTS.tires[this.loadout.tires];
    const J = this.jug ? JUGGERNAUT : null;
    const oldMax = this.maxHp;
    this.scale = hull.scale * (J ? J.scale : 1) * this.scaleMul;
    this.maxHp = baseHp * hull.hpMul * this.hpUp * (J ? this.jugHpMul : 1);
    this.speedMul = hull.speedMul;
    this.turnMul = tire.turn || 1;
    this.accelMul = tire.accel || 1;
    this.slide = tire.slide || 0;
    this.pivot = tire.pivot || 1;
    this.chargeMul = hull.chargeMul || 1;
    this.explosiveMul = hull.explosiveMul;
    this.reloadTime = wpn.reload * (J ? J.reloadMul : 1);
    this.dmgMul = this.dmgUp * (J ? J.dmgMul : 1);
    this.regenMul = J ? J.regenMul : 1;
    if (oldMax > 0 && this.alive) this.hp = Math.min(this.maxHp, this.hp * this.maxHp / oldMax);
    else this.hp = this.maxHp;
  }

  // Integrates controls. Collision is resolved by the game afterwards.
  move(dt) {
    const inp = this.input;
    const boost = this.boostT > 0;
    const turn = clamp(inp.turn, -1, 1);
    let turnRate = TANK.turnRate * this.turnMul * (boost ? OVERDRIVE.turn : 1);
    const sp = Math.abs(this.speed) / TANK.maxSpeed;
    if (this.slide) turnRate *= 1 - this.slide * clamp(sp, 0, 1);
    if (this.pivot > 1 && sp < 0.18) turnRate *= this.pivot;
    this.turnVel = lerp(this.turnVel, turn * turnRate, damp(14, dt));
    this.angle = angNorm(this.angle + this.turnVel * dt);

    const th = clamp(inp.throttle, -1, 1);
    const sm = this.speedMul * this.surfaceMul * (boost ? OVERDRIVE.speed : 1);
    const target = (th >= 0 ? th * TANK.maxSpeed : th * TANK.reverseSpeed) * sm;
    const speeding = Math.abs(target) > Math.abs(this.speed) && (Math.sign(target) === Math.sign(this.speed) || this.speed === 0);
    const rate = speeding ? TANK.accel * this.accelMul * (boost ? OVERDRIVE.accel : 1) : TANK.drag;
    this.speed += clamp(target - this.speed, -rate * dt, rate * dt);

    this._px = this.x; this._py = this.y;
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;

    const rate2 = TANK.turretRate * (this.skill ? this.skill.turret : 1);
    this.turret = rotateToward(this.turret, inp.aim, rate2 * dt);
  }

  // Called after collisions so velocity reflects what actually happened.
  settle(dt) {
    this.vx = (this.x - this._px) / dt;
    this.vy = (this.y - this._py) / dt;
    const fwd = this.vx * Math.cos(this.angle) + this.vy * Math.sin(this.angle);
    // Pushing into a wall bleeds speed instead of storing it.
    if (Math.abs(fwd) < Math.abs(this.speed)) this.speed = Math.sign(this.speed) * Math.max(Math.abs(fwd), Math.abs(this.speed) - 900 * dt);
    const half = 16;
    this.treadL += (fwd - this.turnVel * half) * dt;
    this.treadR += (fwd + this.turnVel * half) * dt;

    this.reload = Math.max(0, this.reload - dt);
    this.shield = Math.max(0, this.shield - dt);
    this.recoil = Math.max(0, this.recoil - dt * 4.5);
    this.flash = Math.max(0, this.flash - dt * 6);
    this.spawnFx = Math.max(0, this.spawnFx - dt * 1.5);
    this.invuln = Math.max(0, this.invuln - dt);
    this.boostT = Math.max(0, this.boostT - dt);
    if (this.overheatT > 0) this.overheatT = Math.max(0, this.overheatT - dt);
    this.heat = Math.max(0, this.heat - MG_HEAT.cool * dt);
  }

  get radius() { return TANK.radius * this.scale; }
  get muzzleX() { return this.x + Math.cos(this.turret) * TANK.barrelLength * this.scale; }
  get muzzleY() { return this.y + Math.sin(this.turret) * TANK.barrelLength * this.scale; }
}

// Missiles and rockets. kind: 'missile' (homing special), 'rocket' (bazooka),
// 'salvo' (quad missile special) or 'wire' (wire-guided weapon).
const MISSILE_KINDS = {
  missile: { P: MISSILE, speed0: MISSILE.speed0, speed: MISSILE.speed, life: MISSILE.life, dmgKind: 'missile' },
  rocket: { P: ROCKET, speed0: ROCKET.speed0, speed: ROCKET.speed, life: ROCKET.range / ROCKET.speed, dmgKind: 'rocket' },
  salvo: { P: SALVO, speed0: SALVO.speed0, speed: SALVO.speed, life: SALVO.range / SALVO.speed, dmgKind: 'rocket' },
  wire: { P: WIRE, speed0: WIRE.speed0, speed: WIRE.speed, life: WIRE.life, dmgKind: 'wire' },
};
class Missile {
  constructor(owner, target, kind = 'missile') {
    const K = MISSILE_KINDS[kind];
    this.kind = kind;
    this.rocket = kind === 'rocket' || kind === 'salvo';
    this.wire = kind === 'wire';
    this.owner = owner;
    this.team = owner.team;
    this.target = target;
    this.angle = owner.turret;
    this.x = owner.muzzleX;
    this.y = owner.muzzleY;
    this.px = this.x; this.py = this.y;
    this.speed = K.speed0;
    this.maxSpeed = K.speed;
    this.life = K.life;
    this.age = 0;
    this.alive = true;
    this.beepT = 0.3;
    this.blink = 0;
    this.seekT = 0;
    this.committed = false;
    this.seenBy = null;
  }
  get vx() { return Math.cos(this.angle) * this.speed; }
  get vy() { return Math.sin(this.angle) * this.speed; }
}

// Projectile fired from (x, y) at angle a. kind: 'shell' (cannon), 'bullet'
// (machine gun), 'flame' (flamethrower puff) or 'long' (long gun).
const SHELL_KINDS = {
  shell: { speed: TANK.shellSpeed, range: TANK.shellRange, damage: TANK.shellDamage, spread: TANK.damageSpread, radius: TANK.shellRadius },
  bullet: BULLET,
  flame: { speed: FLAME.speed, range: FLAME.range, damage: FLAME.damage, spread: 0, radius: FLAME.radius },
  long: LONGGUN,
  hesh: HESH,
  coax: { speed: BULLET.speed, range: 620, damage: COAX.damage, spread: 0.5, radius: BULLET.radius },
};
class Shell {
  constructor(owner, x, y, a, kind = 'shell') {
    const P = SHELL_KINDS[kind];
    this.owner = owner;
    this.team = owner.team;
    this.kind = kind;
    this.bullet = kind === 'bullet' || kind === 'coax';
    this.flame = kind === 'flame';
    this.hesh = kind === 'hesh';
    this.x = x;
    this.y = y;
    this.px = this.x; this.py = this.y;
    this.vx = Math.cos(a) * P.speed;
    this.vy = Math.sin(a) * P.speed;
    // Flames drift with the tank that throws them.
    if (this.flame) { this.vx += owner.vx * 0.6; this.vy += owner.vy * 0.6; }
    this.speed = P.speed;
    this.angle = a;
    this.life = P.range / P.speed;
    this.age = 0;
    this.damage = P.damage * owner.dmgMul;
    this.spread = P.spread * owner.dmgMul;
    this.radius = P.radius;
    this.alive = true;
    this.seenBy = null;
  }
}

// Escort mode's VIP supply truck: a tank-shaped target that follows a route.
class Convoy extends Tank {
  constructor(team, color, hp, route, speed) {
    super({ name: 'Supply Convoy', team, color });
    this.isConvoy = true;
    this.route = route;       // [{x, y}], start to extraction
    this.routeI = 1;
    this.cruise = speed;
    this.scale = 1.55;
    this.maxHp = this.hp = hp;
    this.progress = 0;        // 0..1 along the route
    this.routeLen = 0;
    for (let i = 1; i < route.length; i++) this.routeLen += dist(route[i - 1].x, route[i - 1].y, route[i].x, route[i].y);
    this.travelled = 0;
    this.beacon = 0;
  }

  spawn(x, y, angle) {
    super.spawn(x, y, angle);
    this.shield = 0;
    this.spawnFx = 0;
  }

  // Drives itself along the route at a steady pace.
  move(dt) {
    this._px = this.x; this._py = this.y;
    const wp = this.route[this.routeI];
    if (!wp) { this.speed = 0; return; }
    const want = Math.atan2(wp.y - this.y, wp.x - this.x);
    this.angle = rotateToward(this.angle, want, 1.6 * dt);
    this.turret = this.angle;
    this.speed = this.cruise * clamp(1 - Math.abs(angDiff(this.angle, want)) / 1.2, 0.35, 1);
    const step = this.speed * dt;
    this.x += Math.cos(this.angle) * step;
    this.y += Math.sin(this.angle) * step;
    this.travelled += step;
    this.progress = clamp(this.travelled / this.routeLen, 0, 1);
    if (dist(this.x, this.y, wp.x, wp.y) < 26) this.routeI++;
    this.beacon += dt;
  }

  get arrived() { return this.routeI >= this.route.length; }
}
