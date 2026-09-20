'use strict';
// ---------------------------------------------------------------------------
// Keyboard + mouse state, and conversion into tank controls.
// Single player: WASD/arrows drive, mouse aims, click/Space fires,
// right-click launches the missile, R toggles autofire.
// Two players: P1 = WASD + Left Shift (Q missile, E autofire),
// P2 = arrows + Space (Enter missile, Right Shift autofire); turrets auto-lock.
// ---------------------------------------------------------------------------

const COOP_KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: ['ShiftLeft', 'KeyF'], missile: ['KeyQ'], auto: ['KeyE'], picks: ['Digit1', 'Digit2', 'Digit3'] },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: ['Space', 'Numpad0'], missile: ['Enter', 'NumpadEnter'], auto: ['ShiftRight'], picks: ['Comma', 'Period', 'Slash'] },
];
const SOLO_PICKS = [['Digit1', 'Numpad1'], ['Digit2', 'Numpad2'], ['Digit3', 'Numpad3']];
const SOLO_AUTO_KEY = 'KeyR';
const STICK_RADIUS = 56;   // px a touch stick can travel from its centre

class Input {
  constructor(target) {
    this.keys = new Set();
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, down: false, inside: true };
    this.pressed = new Set();   // keys pressed since last frame
    this.clicked = false;
    this.rightClicked = false;
    this.reversing = new Map(); // arcade steering hysteresis, per tank id
    // Touch: floating twin sticks plus on-screen buttons (see setupTouch).
    this.touchMode = LOW_MEM;
    this.sticks = { l: null, r: null };
    this.touchAim = null;
    this.touchSpecial = false;
    this.autoTap = false;
    this.boardHeld = false;
    window.addEventListener('pointerdown', e => { this.touchMode = e.pointerType === 'touch' || (e.pointerType !== 'mouse' && this.touchMode); }, true);

    const noScroll = ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    window.addEventListener('keydown', e => {
      const k = e.code;
      if (noScroll.includes(k) && !isTyping(e)) e.preventDefault();
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; });
    // Tracked on the window so aiming keeps working with the cursor over HUD panels.
    window.addEventListener('mousemove', e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true; });
    document.documentElement.addEventListener('mouseleave', () => { this.mouse.inside = false; });
    target.addEventListener('mousedown', e => {
      if (e.button === 0) { this.mouse.down = true; this.clicked = true; }
      if (e.button === 2) this.rightClicked = true;
    });
    window.addEventListener('mouseup', e => { if (e.button === 0) this.mouse.down = false; });
    target.addEventListener('contextmenu', e => e.preventDefault());
    function isTyping(e) { return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT'); }
  }

  wasPressed(code) { return this.pressed.has(code); }
  endFrame() { this.pressed.clear(); this.clicked = false; this.rightClicked = false; this.autoTap = false; this.touchSpecial = false; }

  // True when the given player pressed their autofire toggle this frame.
  autoToggled(idx, twoPlayer) {
    return twoPlayer ? COOP_KEYS[idx].auto.some(c => this.pressed.has(c)) : this.pressed.has(SOLO_AUTO_KEY) || this.autoTap;
  }

  // Touch layer: the left half of the screen spawns the drive stick where the
  // thumb lands, the right half spawns the aim stick. Buttons sit on top.
  setupTouch(layer) {
    const R = STICK_RADIUS;
    const grab = e => {
      if (e.pointerType === 'mouse' || e.target.closest('.t-btn')) return;
      const side = e.clientX < window.innerWidth / 2 ? 'l' : 'r';
      if (this.sticks[side]) return;
      this.sticks[side] = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      e.preventDefault();
    };
    const move = e => {
      for (const k of ['l', 'r']) {
        const s = this.sticks[k];
        if (!s || s.id !== e.pointerId) continue;
        s.x = e.clientX; s.y = e.clientY;
        // The base follows a thumb that slides past the rim.
        const dx = s.x - s.ox, dy = s.y - s.oy, d = Math.hypot(dx, dy);
        if (d > R * 1.25) { s.ox = s.x - dx / d * R * 1.25; s.oy = s.y - dy / d * R * 1.25; }
        e.preventDefault();
      }
    };
    const drop = e => { for (const k of ['l', 'r']) if (this.sticks[k] && this.sticks[k].id === e.pointerId) this.sticks[k] = null; };
    layer.addEventListener('pointerdown', grab);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
    const btn = (id, down, up) => {
      const b = layer.querySelector(id);
      b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); down(); });
      if (up) for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, up);
    };
    btn('#t-special', () => { this.touchSpecial = true; });
    btn('#t-auto', () => { this.autoTap = true; });
    btn('#t-board', () => { this.boardHeld = true; }, () => { this.boardHeld = false; });
    return this;
  }

  stickVec(k) {
    const s = this.sticks[k];
    if (!s) return null;
    const dx = (s.x - s.ox) / STICK_RADIUS, dy = (s.y - s.oy) / STICK_RADIUS, m = Math.hypot(dx, dy);
    return { dx, dy, m: Math.min(1, m), a: Math.atan2(dy, dx) };
  }

  // Single player on touch: left stick drives toward where it points, right stick
  // aims (with a gentle pull toward enemies) and fires. Returns the aim point.
  applyTouch(tank, game, autofire) {
    const inp = tank.input, L = this.stickVec('l'), Rv = this.stickVec('r');
    if (L && L.m > 0.18) this.driveToward(tank, L.a, Math.min(1, (L.m - 0.18) / 0.6 + 0.35));
    else { inp.throttle = 0; inp.turn = 0; }
    const aiming = Rv && Rv.m > 0.28;
    if (aiming) this.touchAim = Rv.a;
    const base = this.touchAim !== null ? this.touchAim : tank.turret;
    const lock = aiming || autofire ? touchAssist(tank, game, base) : null;
    if (lock) {
      let px = lock.x, py = lock.y;
      const { speed } = weaponBallistics(tank.loadout.weapon);
      for (let i = 0; i < 2; i++) { const tt = dist(tank.muzzleX, tank.muzzleY, px, py) / speed; px = lock.x + lock.vx * tt * 0.8; py = lock.y + lock.vy * tt * 0.8; }
      inp.aim = Math.atan2(py - tank.y, px - tank.x);
    } else inp.aim = base;
    inp.fire = autofire || aiming;
    const reach = lock ? dist(tank.x, tank.y, lock.x, lock.y) : 420;
    const aimPt = { x: tank.x + Math.cos(inp.aim) * reach, y: tank.y + Math.sin(inp.aim) * reach };
    if (this.touchSpecial) {
      inp.missile = true;
      const near = lock || pickMissileTarget(tank, game, aimPt);
      inp.missileTarget = near;
      if (tank.loadout.special === 'artillery' || tank.loadout.special === 'airstrike') inp.specialPoint = near ? { x: near.x, y: near.y } : { x: tank.x + Math.cos(inp.aim) * 520, y: tank.y + Math.sin(inp.aim) * 520 };
    }
    return aimPt;
  }

  // Upgrade choice pressed this frame (0-2), or -1.
  pickPressed(idx, twoPlayer) {
    const sets = twoPlayer ? COOP_KEYS[idx].picks.map(c => [c]) : SOLO_PICKS;
    return sets.findIndex(codes => codes.some(c => this.pressed.has(c)));
  }

  // Throttle/turn from four direction keys, in tank or arcade steering.
  drive(tank, W, S, A, D, steering) {
    const inp = tank.input;
    if (steering !== 'arcade') {
      inp.throttle = (W ? 1 : 0) - (S ? 1 : 0);
      inp.turn = (D ? 1 : 0) - (A ? 1 : 0);
      return;
    }
    const dx = (D ? 1 : 0) - (A ? 1 : 0), dy = (S ? 1 : 0) - (W ? 1 : 0);
    if (!dx && !dy) { inp.turn = 0; inp.throttle = 0; return; }
    this.driveToward(tank, Math.atan2(dy, dx), 1);
  }

  // Arcade steering toward a heading (reverses instead of turning right round).
  driveToward(tank, want, mag) {
    const inp = tank.input;
    const diff = angDiff(tank.angle, want);
    let rev = this.reversing.get(tank.id) || false;
    if (!rev && Math.abs(diff) > 2.2) rev = true;
    else if (rev && Math.abs(diff) < 1.0) rev = false;
    this.reversing.set(tank.id, rev);
    if (rev) {
      const db = angDiff(tank.angle + Math.PI, want);
      inp.turn = clamp(db * 3, -1, 1);
      inp.throttle = -Math.max(0.35, Math.cos(db)) * mag;
    } else {
      inp.turn = clamp(diff * 3, -1, 1);
      inp.throttle = (Math.abs(diff) > 1.2 ? 0.15 : Math.max(0.35, Math.cos(diff))) * mag;
    }
  }

  // Single player: keyboard drives, mouse aims. Returns the aim point in world space.
  applyTo(tank, renderer, steering, autofire, game) {
    const k = this.keys;
    this.drive(tank,
      k.has('KeyW') || k.has('ArrowUp'), k.has('KeyS') || k.has('ArrowDown'),
      k.has('KeyA') || k.has('ArrowLeft'), k.has('KeyD') || k.has('ArrowRight'), steering);
    const m = renderer.screenToWorld(this.mouse.x, this.mouse.y);
    tank.input.aim = Math.atan2(m.y - tank.y, m.x - tank.x);
    tank.input.fire = autofire || this.mouse.down || k.has('Space');
    if (this.rightClicked) {
      tank.input.missile = true;
      if (tank.loadout.special === 'artillery' || tank.loadout.special === 'airstrike') {
        // Artillery: lock onto an enemy right under the cursor, otherwise hit the spot.
        const near = pickMissileTarget(tank, game, m);
        tank.input.missileTarget = near && dist(near.x, near.y, m.x, m.y) < 110 ? near : null;
        tank.input.specialPoint = { x: m.x, y: m.y };
      } else tank.input.missileTarget = pickMissileTarget(tank, game, m);
    }
    return m;
  }

  // Co-op: player `idx` drives with their key set; the turret locks onto the
  // best enemy in front of the hull. Returns the locked target (or null).
  applyCoop(tank, idx, game, steering, prevLock, autofire) {
    const k = this.keys, map = COOP_KEYS[idx];
    this.drive(tank, k.has(map.up), k.has(map.down), k.has(map.left), k.has(map.right), steering);
    tank.input.fire = autofire || map.fire.some(c => k.has(c));
    const target = assistTarget(tank, game, prevLock);
    if (map.missile.some(c => this.pressed.has(c))) {
      tank.input.missile = true;
      tank.input.missileTarget = target;
    }
    if (target) {
      let px = target.x, py = target.y;
      for (let i = 0; i < 2; i++) {
        const tt = dist(tank.muzzleX, tank.muzzleY, px, py) / TANK.shellSpeed;
        px = target.x + target.vx * tt * 0.75;
        py = target.y + target.vy * tt * 0.75;
      }
      tank.input.aim = Math.atan2(py - tank.y, px - tank.x);
    } else tank.input.aim = tank.angle;
    return target;
  }
}

// Missile target for mouse aiming: the enemy nearest the cursor (cover
// doesn't block the lock, but the missile can still fly into it), otherwise
// whatever is visible in front of the turret.
function pickMissileTarget(tank, game, point) {
  let best = null, bd = 260 * 260;
  for (const e of game.tanks) {
    if (!e.alive || e.team === tank.team) continue;
    const d = dist2(e.x, e.y, point.x, point.y);
    if (d < bd && dist2(e.x, e.y, tank.x, tank.y) < 1100 * 1100) { bd = d; best = e; }
  }
  return best || game.seekTarget(tank.x, tank.y, tank.turret, tank.team, 0.7);
}

// Touch aim assist: the visible enemy closest to the aimed direction (within
// about 15 degrees and gun range).
function touchAssist(tank, game, aim) {
  let best = null, bestScore = Infinity;
  const { range } = weaponBallistics(tank.loadout.weapon);
  for (const e of game.tanks) {
    if (!e.alive || e.team === tank.team) continue;
    const d = dist(tank.x, tank.y, e.x, e.y);
    if (d > range * 0.95) continue;
    const off = Math.abs(angDiff(aim, Math.atan2(e.y - tank.y, e.x - tank.x)));
    if (off > 0.26 + Math.atan2(e.radius, d)) continue;
    if (!game.map.lineOfSight(tank.x, tank.y, e.x, e.y, 2) || game.inSmoke(e.x, e.y)) continue;
    const score = off * 900 + d * 0.3;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

// Closest visible enemy inside a cone ahead of the hull; sticky once locked.
function assistTarget(tank, game, prev) {
  let best = null, bestScore = Infinity;
  for (const e of game.tanks) {
    if (!e.alive || e.team === tank.team) continue;
    const d = dist(tank.x, tank.y, e.x, e.y);
    if (d > TANK.shellRange * 0.9) continue;
    const off = Math.abs(angDiff(tank.angle, Math.atan2(e.y - tank.y, e.x - tank.x)));
    if (off > (e === prev ? 1.35 : 1.0)) continue;
    if (!game.map.lineOfSight(tank.x, tank.y, e.x, e.y, 2)) continue;
    const score = d * (1 + off * 1.2) - (e === prev ? 250 : 0);
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}
