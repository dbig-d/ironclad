'use strict';
// ---------------------------------------------------------------------------
// Tank parts (Leveling / Freeplay / Campaign hangar), XP rules and level-up
// offers. Every tank has one part per slot; upgrades replace the standard part.
// `price` is what the campaign hangar charges for it.
// ---------------------------------------------------------------------------

const PARTS = {
  weapon: {
    cannon:  { name: 'Cannon', desc: 'Balanced main gun.', reload: 0.72, price: 0 },
    double:  { name: 'Double Shot', desc: 'Two side-by-side barrels fire together. Slightly slower reload.', reload: 0.8, price: 900 },
    twin:    { name: 'Fore & Aft', desc: 'One barrel forward, one backward. Slightly slower reload.', reload: 0.8, price: 700 },
    mg:      { name: 'Machine Gun', desc: 'Rapid, low-damage fire. Overheats if you hold it too long.', reload: 0.11, price: 1100 },
    bazooka: { name: 'Bazooka', desc: 'Slow unguided rockets with a small explosive blast.', reload: 1.7, price: 1000 },
    flame:   { name: 'Flamethrower', desc: 'Short-range jet of fire that leaves tanks burning. Loses pressure if held too long.', reload: 0.075, price: 1200 },
    longgun: { name: 'Long Gun', desc: 'High-velocity barrel: hits harder and reaches much farther, but reloads slowly.', reload: 1.2, price: 1400 },
    coax:    { name: 'Cannon + Coaxial MG', desc: 'Standard cannon with a coaxial machine gun that keeps firing while the main gun reloads.', reload: 0.8, price: 1150 },
    hesh:    { name: 'HESH Gun', desc: 'Squash-head shells: full damage wherever they land, plus a small blast. Weak against reactive armor.', reload: 0.9, price: 1100 },
    wire:    { name: 'Wire-Guided Missile', desc: 'A slow missile that flies wherever your turret points. Hits hard, but keep aiming until it lands.', reload: 2.4, price: 1500 },
  },
  hull: {
    standard: { name: 'Standard Hull', desc: 'Balanced armor and speed.', hpMul: 1, scale: 1, speedMul: 1, explosiveMul: 1, price: 0 },
    big:      { name: 'Big Hull', desc: '+50% armor, but bigger and a little slower.', hpMul: 1.5, scale: 1.15, speedMul: 0.88, explosiveMul: 1, price: 1000 },
    feather:  { name: 'Featherweight', desc: '+22% speed and a smaller target, 30% less armor.', hpMul: 0.7, scale: 0.9, speedMul: 1.22, explosiveMul: 1, price: 700 },
    era:      { name: 'Explosive Reinforcements', desc: 'Halves explosive damage. Slightly bigger and slower.', hpMul: 1, scale: 1.06, speedMul: 0.92, explosiveMul: 0.5, price: 800 },
    sloped:   { name: 'Sloped Armor', desc: 'Angled plates shrug off 40% of hits to the front. Hits from behind do 25% more.', hpMul: 1, scale: 1.02, speedMul: 0.96, explosiveMul: 1, front: 0.6, rear: 1.25, price: 1100 },
    dozer:    { name: 'Dozer Blade', desc: 'Ram enemy tanks for heavy damage and shove them aside. +10% armor, a little slower.', hpMul: 1.1, scale: 1.04, speedMul: 0.95, explosiveMul: 1, ram: true, price: 900 },
    skirts:   { name: 'Side Skirts', desc: 'Spaced armor plates: 28% less damage from side hits, and from rockets and missiles.', hpMul: 1, scale: 1.05, speedMul: 0.96, explosiveMul: 1, side: 0.72, rocketMul: 0.72, price: 800 },
    fuel:     { name: 'External Fuel Drums', desc: '+12% speed and specials charge 20% faster, but hits from behind do 30% more and can set you alight.', hpMul: 1, scale: 1.02, speedMul: 1.12, explosiveMul: 1, rear: 1.3, rearFire: 0.35, chargeMul: 1.2, price: 650 },
  },
  tires: {
    tracks:    { name: 'Standard Tracks', desc: 'Same speed on land. Slowed by marsh water.', road: 1, off: 1, water: 0.6, turn: 1, accel: 1, price: 0 },
    rover:     { name: 'Rover Wheels', desc: '+30% on roads, 12% slower on grass, sand and snow. Bogs down in water.', road: 1.3, off: 0.88, water: 0.5, turn: 1, accel: 1, price: 500 },
    quad:      { name: 'Heavy Quad Tracks', desc: '+12% off-road, 8% slower on roads. Ploughs through water at full speed.', road: 0.92, off: 1.12, water: 1.12, turn: 1, accel: 1, price: 600 },
    halftrack: { name: 'Half-Track', desc: '+10% speed on land, but turns wide. Slowed by water.', road: 1.1, off: 1.1, water: 0.62, turn: 0.72, accel: 1, price: 700 },
    christie:  { name: 'Christie Suspension', desc: 'Big road wheels: +45% acceleration and +30% turning, 5% lower top speed. Slowed by water.', road: 0.95, off: 0.95, water: 0.6, turn: 1.3, accel: 1.45, price: 850 },
    carwheels: { name: 'Armored Car Wheels', desc: '+35% on roads, +10% off-road. Slides wide when turning at speed and bogs down in water.', road: 1.35, off: 1.1, water: 0.45, turn: 1, accel: 1.1, slide: 0.45, price: 750 },
    neutral:   { name: 'Neutral-Steer Transmission', desc: 'Spins on the spot: 80% faster turning when stopped, 5% lower top speed. Slowed by water.', road: 0.95, off: 0.95, water: 0.6, turn: 1, accel: 1, pivot: 1.8, price: 700 },
  },
  special: {
    missile:   { name: 'Guided Missile', desc: 'Homes in on a target. 60 damage.', cost: 200, price: 0 },
    mine:      { name: 'Land Mine', desc: 'Drops behind you. Hurts most when driven straight over.', cost: 110, price: 600 },
    artillery: { name: 'Artillery', desc: 'Four shells arc over walls onto a spot or locked target.', cost: 240, price: 1300 },
    smoke:     { name: 'Smokescreen', desc: 'A thick cloud that hides you and blinds bots.', cost: 130, price: 500 },
    repair:    { name: 'Field Repair Kit', desc: 'Restores 45% of your armor over 3 seconds and puts out fires.', cost: 150, price: 900 },
    overdrive: { name: 'Engine Overdrive', desc: 'Four seconds of +55% speed and sharper turning.', cost: 120, price: 650 },
    airstrike: { name: 'Airstrike', desc: 'A fighter-bomber walks heavy bombs through the spot you mark. Mark a tank and the pilot follows it in.', cost: 280, price: 1400 },
    flak:      { name: 'Anti-Air Rounds', desc: 'For 15 seconds an automatic gun tries to shoot down missiles, rockets, grenades and shells coming in near you.', cost: 170, price: 900 },
    grenades:  { name: 'Grenade Launcher', desc: 'Two grenades per charge. They bounce off walls and burst a moment later.', cost: 140, price: 950 },
    salvo:     { name: 'Quad Missiles', desc: 'Four rockets from rear pods fire straight ahead of your hull, two down each side. 30 damage each.', cost: 190, price: 1200 },
  },
};
const SLOTS = ['weapon', 'hull', 'tires', 'special'];
const SLOT_NAMES = { weapon: 'Weapon', hull: 'Hull', tires: 'Tires', special: 'Special' };
const DEFAULT_LOADOUT = { weapon: 'cannon', hull: 'standard', tires: 'tracks', special: 'missile' };

// Weapon ballistics.
const BULLET = { speed: 1000, range: 700, damage: 6, spread: 1, radius: 2.5, jitter: 0.035 };
const MG_HEAT = { perShot: 7, cool: 28, overheat: 2.5 };
const ROCKET = { damage: 40, spread: 10, splashRadius: 80, splashDamage: 18, speed0: 380, speed: 560, range: 950 };
// Flamethrower puffs: fat, slow, short-lived; a hit sets the tank burning.
const FLAME = { speed: 430, range: 250, damage: 3, radius: 10, jitter: 0.09, heat: 4.5, burn: 5, burnTime: 2.2 };
const LONGGUN = { speed: 1350, range: 1500, damage: 32, spread: 7, radius: 4.5 };
// HESH: flat damage (no hit-location spread) and a small blast wherever it bursts.
const HESH = { speed: 700, range: 900, damage: 25, spread: 0, radius: 5, splashRadius: 44, splashDamage: 10 };
// Coaxial MG: light rounds fired between cannon shots.
const COAX = { interval: 0.18, damage: 2, jitter: 0.05 };
// Wire-guided missile: rides the line of the owner's turret.
const WIRE = { damage: 55, spread: 12, splashRadius: 50, splashDamage: 12, speed0: 250, speed: 380, life: 3.6, turn: 3.2, lead: 160 };
// Quad missile rockets and grenades.
const SALVO = { damage: 30, spread: 5, splashRadius: 68, splashDamage: 15, speed0: 420, speed: 640, range: 900, gap: 0.08, converge: 0.04 };
const GRENADE = { speed: 540, fuse: 1.3, radius: 70, damage: 32, edge: 6, drag: 1.5, bounce: 0.62, size: 6, ammo: 2 };
const AIRSTRIKE = { delay: 2.2, length: 500, bombs: 7, radius: 82, damage: 58, edge: 14, planeSpeed: 950, range: 1200, track: 240, commit: 0.8 };
const FLAK = { time: 15, radius: 200, rate: 0.5, hit: 0.7 };

// Projectile speed and reach per weapon (bots use this to lead and pick range).
function weaponBallistics(w) {
  switch (w) {
    case 'mg': return { speed: BULLET.speed, range: BULLET.range };
    case 'bazooka': return { speed: 480, range: ROCKET.range };
    case 'flame': return { speed: FLAME.speed, range: FLAME.range };
    case 'longgun': return { speed: LONGGUN.speed, range: LONGGUN.range };
    case 'hesh': return { speed: HESH.speed, range: HESH.range };
    case 'wire': return { speed: WIRE.speed, range: WIRE.speed * WIRE.life * 0.9 };
    default: return { speed: TANK.shellSpeed, range: TANK.shellRange };
  }
}

// Hull and special effects.
const RAM = { minSpeed: 70, perSpeed: 0.12, max: 34, cooldown: 0.7, knock: 16 };
const REPAIR = { amount: 0.45, time: 3 };
const OVERDRIVE = { time: 4, speed: 1.55, turn: 1.3, accel: 1.6 };

// Specials.
const MINE = { arm: 0.8, maxPerTank: 3, min: 35, max: 75, splashRadius: 60, splashDamage: 15, size: 12, reach: 6 };
const ARTY = { shells: 4, gap: 0.3, range: 1200, radius: 75, damage: 32, edge: 8, scatter: 42 };
const SMOKE = { radius: 230, life: 9 };
const EXPLOSIVE = new Set(['missile', 'splash', 'rocket', 'mine', 'artillery', 'hesh', 'wire', 'grenade', 'airstrike']);
// Hits that come from one direction (sloped armor, skirts and fuel drums care about these).
// HESH isn't here: squash-head rounds don't glance off angled plates.
const DIRECTIONAL = new Set(['shell', 'bullet', 'flame', 'missile', 'rocket', 'wire']);
// Gun damage that charges the special.
const GUN_KINDS = new Set(['shell', 'bullet', 'flame', 'hesh', 'wire']);
// What spaced armor (side skirts) weakens.
const ROCKET_KINDS = new Set(['rocket', 'missile', 'wire']);

// Combat score. Every tank earns it (it ranks the lobby ladder); in Leveling
// mode crossing each threshold offers an upgrade.
const XP = {
  levels: [200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400, 6500],
  kill: 100, assist: 40, dmg: 0.5,
  streaks: { 3: 60, 5: 120, 8: 200 },
  flagTake: 60, flagCap: 300, flagReturn: 80,
  hill: 12,            // per second on the hill
  jug: 10, jugKill: 150,
  convoyDmg: 1, escort: 6, convoyKill: 400,
  survive: 1.5,        // battle royale, per second alive
  round: 150,          // hardcore: every tank on the side that takes a round
};
const OFFER = { invuln: 4, time: 10 };

// Up to three offers, from different slots where possible, never the part
// already fitted and never a standard part.
function makeOffers(loadout, rng) {
  const pool = [];
  for (const slot of SLOTS) {
    for (const id of Object.keys(PARTS[slot])) {
      if (id === DEFAULT_LOADOUT[slot] || loadout[slot] === id) continue;
      pool.push({ slot, id });
    }
  }
  rng.shuffle(pool);
  const out = [], used = new Set();
  for (const o of pool) if (out.length < 3 && !used.has(o.slot)) { out.push(o); used.add(o.slot); }
  for (const o of pool) if (out.length < 3 && !out.includes(o)) out.push(o);
  return out;
}

function randomLoadout(rng) {
  const L = {};
  for (const slot of SLOTS) L[slot] = rng.pick(Object.keys(PARTS[slot]));
  return L;
}

// Short labels and tiny glyphs for the loadout builder and upgrade cards.
const PART_SHORT = {
  cannon: 'Cannon', double: 'Double', twin: 'Fore & Aft', mg: 'MG', bazooka: 'Bazooka', flame: 'Flame', longgun: 'Long Gun', coax: 'Coax', hesh: 'HESH', wire: 'Wire-Guided',
  standard: 'Standard', big: 'Big', feather: 'Feather', era: 'ERA', sloped: 'Sloped', dozer: 'Dozer', skirts: 'Skirts', fuel: 'Fuel Drums',
  tracks: 'Tracks', rover: 'Rover', quad: 'Quad', halftrack: 'Half-Track', christie: 'Christie', carwheels: 'Car Wheels', neutral: 'Neutral-Steer',
  missile: 'Missile', mine: 'Mine', artillery: 'Artillery', smoke: 'Smoke', repair: 'Repair', overdrive: 'Overdrive',
  airstrike: 'Airstrike', flak: 'Anti-Air', grenades: 'Grenades', salvo: 'Quad Missiles',
};
const PART_ICONS = {
  cannon: '<rect x="4" y="13" width="10" height="10" rx="3"/><rect x="13" y="16" width="16" height="4" rx="1"/>',
  double: '<rect x="4" y="12" width="10" height="12" rx="3"/><rect x="13" y="12.5" width="16" height="3.2" rx="1"/><rect x="13" y="20.3" width="16" height="3.2" rx="1"/>',
  twin: '<rect x="11" y="13" width="10" height="10" rx="3"/><rect x="20" y="16" width="12" height="4" rx="1"/><rect x="0" y="16" width="12" height="4" rx="1"/>',
  mg: '<rect x="4" y="13" width="9" height="10" rx="2.5"/><rect x="12" y="14" width="18" height="1.8"/><rect x="12" y="17.1" width="18" height="1.8"/><rect x="12" y="20.2" width="18" height="1.8"/>',
  bazooka: '<rect x="4" y="14" width="8" height="8" rx="2.5"/><rect x="10" y="12.5" width="18" height="11" rx="3"/><path d="M28 14.5c4 1.2 4 5.8 0 7z"/>',
  flame: '<rect x="2" y="12" width="9" height="12" rx="3"/><rect x="10" y="15.5" width="10" height="5" rx="1"/><path d="M20 18c4-6 9-5 14-8-2 4-1 6 1 8-2 2-3 4-1 8-5-3-10-2-14-8z" fill-opacity=".85"/>',
  longgun: '<rect x="2" y="13" width="9" height="10" rx="3"/><rect x="10" y="16.4" width="23" height="3.2" rx="1"/><rect x="30" y="15" width="4" height="6" rx="1"/><rect x="16" y="15.6" width="4" height="4.8" rx="1"/>',
  coax: '<rect x="3" y="12" width="10" height="12" rx="3"/><rect x="12" y="13.5" width="18" height="4" rx="1"/><rect x="12" y="20" width="12" height="1.8"/><rect x="9" y="22.5" width="5" height="4" rx="1" fill-opacity=".5"/>',
  hesh: '<rect x="3" y="12" width="10" height="12" rx="3"/><rect x="12" y="14.5" width="14" height="7" rx="1.5"/><rect x="25" y="13" width="6" height="10" rx="1.5"/>',
  wire: '<rect x="3" y="12" width="9" height="12" rx="3"/><rect x="11" y="16.5" width="18" height="3" rx="1"/><path d="M13 12.5h12l4 2.5-4 2.5H13z"/><path d="M29 18c3 4 5 2 6 7" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  skirts: '<rect x="7" y="10" width="22" height="16" rx="3" fill-opacity=".45"/><rect x="3" y="5" width="30" height="5" rx="1"/><rect x="3" y="26" width="30" height="5" rx="1"/><rect x="11" y="5" width="1.2" height="5" fill-opacity=".3"/><rect x="21" y="26" width="1.2" height="5" fill-opacity=".3"/>',
  fuel: '<rect x="11" y="9" width="22" height="18" rx="4"/><rect x="2" y="9.5" width="8" height="7.5" rx="2"/><rect x="2" y="19" width="8" height="7.5" rx="2"/>',
  carwheels: '<circle cx="8" cy="9" r="4.2"/><circle cx="18" cy="9" r="4.2"/><circle cx="28" cy="9" r="4.2"/><circle cx="8" cy="27" r="4.2"/><circle cx="18" cy="27" r="4.2"/><circle cx="28" cy="27" r="4.2"/>',
  neutral: '<rect x="3" y="7" width="30" height="7" rx="2.5" fill-opacity=".5"/><rect x="3" y="22" width="30" height="7" rx="2.5" fill-opacity=".5"/><path d="M18 11a7 7 0 1 1-6.1 3.6l-2.6-1.5A10 10 0 1 0 18 8z"/><path d="M8 11l2 5 4-3z"/>',
  airstrike: '<path d="M18 4l2.5 9 12 3v3l-12-1-1 8 4 3v2l-5.5-1.5L12.5 31v-2l4-3-1-8-12 1v-3l12-3z"/>',
  flak: '<circle cx="18" cy="22" r="7"/><rect x="16.5" y="3" width="1.4" height="17" transform="rotate(20 17 20)"/><rect x="19.5" y="3" width="1.4" height="17" transform="rotate(20 20 20)"/><circle cx="26" cy="8" r="2.5" fill-opacity=".5"/><circle cx="31" cy="12" r="1.8" fill-opacity=".5"/>',
  grenades: '<rect x="4" y="10" width="14" height="16" rx="3"/><rect x="16" y="11" width="9" height="4" rx="1.5"/><rect x="16" y="21" width="9" height="4" rx="1.5"/><ellipse cx="30" cy="18" rx="4" ry="3"/>',
  salvo: '<rect x="3" y="4" width="18" height="8" rx="2"/><rect x="3" y="24" width="18" height="8" rx="2"/><path d="M21 5.5h7l3 2.5-3 2.5h-7zM21 25.5h7l3 2.5-3 2.5h-7z"/><rect x="9" y="14" width="16" height="8" rx="2" fill-opacity=".4"/>',
  standard: '<rect x="5" y="9" width="26" height="18" rx="4"/>',
  big: '<rect x="3" y="7" width="30" height="22" rx="4"/><rect x="3" y="7" width="30" height="4" fill-opacity=".5"/><rect x="3" y="25" width="30" height="4" fill-opacity=".5"/>',
  feather: '<rect x="7" y="11" width="22" height="14" rx="4"/><rect x="11" y="14" width="3" height="2" fill-opacity=".35"/><rect x="17" y="14" width="3" height="2" fill-opacity=".35"/><rect x="11" y="20" width="3" height="2" fill-opacity=".35"/><rect x="17" y="20" width="3" height="2" fill-opacity=".35"/>',
  era: '<rect x="5" y="9" width="26" height="18" rx="4"/><g fill-opacity=".45"><rect x="7" y="11" width="5" height="4"/><rect x="13" y="11" width="5" height="4"/><rect x="19" y="11" width="5" height="4"/><rect x="7" y="21" width="5" height="4"/><rect x="13" y="21" width="5" height="4"/><rect x="19" y="21" width="5" height="4"/></g>',
  sloped: '<path d="M4 10h18l10 8-10 8H4z"/><path d="M22 10l10 8-10 8z" fill-opacity=".45"/>',
  dozer: '<rect x="3" y="10" width="21" height="16" rx="3"/><path d="M26 5h4c2 4 2 22 0 26h-4c1.5-6 1.5-20 0-26z"/><rect x="22" y="14" width="5" height="2"/><rect x="22" y="20" width="5" height="2"/>',
  tracks: '<rect x="3" y="7" width="30" height="7" rx="2.5"/><rect x="3" y="22" width="30" height="7" rx="2.5"/>',
  rover: '<rect x="3" y="8" width="8" height="6" rx="2.5"/><rect x="14" y="8" width="8" height="6" rx="2.5"/><rect x="25" y="8" width="8" height="6" rx="2.5"/><rect x="3" y="22" width="8" height="6" rx="2.5"/><rect x="14" y="22" width="8" height="6" rx="2.5"/><rect x="25" y="22" width="8" height="6" rx="2.5"/>',
  quad: '<rect x="2" y="5" width="32" height="5" rx="2"/><rect x="4" y="11" width="28" height="5" rx="2"/><rect x="4" y="20" width="28" height="5" rx="2"/><rect x="2" y="26" width="32" height="5" rx="2"/>',
  halftrack: '<rect x="2" y="7" width="19" height="7" rx="2.5"/><rect x="2" y="22" width="19" height="7" rx="2.5"/><rect x="24" y="7" width="9" height="6.5" rx="3"/><rect x="24" y="22.5" width="9" height="6.5" rx="3"/>',
  christie: '<rect x="3" y="7" width="30" height="7" rx="3.5" fill-opacity=".45"/><rect x="3" y="22" width="30" height="7" rx="3.5" fill-opacity=".45"/><circle cx="8" cy="10.5" r="3.2"/><circle cx="18" cy="10.5" r="3.2"/><circle cx="28" cy="10.5" r="3.2"/><circle cx="8" cy="25.5" r="3.2"/><circle cx="18" cy="25.5" r="3.2"/><circle cx="28" cy="25.5" r="3.2"/>',
  missile: '<path d="M6 18l5-5h14l6 5-6 5H11z"/><path d="M6 18l-3-5v10z"/>',
  mine: '<circle cx="18" cy="18" r="11"/><circle cx="18" cy="18" r="4" fill-opacity=".45"/>',
  artillery: '<path d="M5 29c3-16 18-24 27-22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="3 3"/><circle cx="29" cy="8" r="4"/><rect x="3" y="26" width="10" height="5" rx="1.5"/>',
  smoke: '<circle cx="12" cy="20" r="7"/><circle cx="21" cy="15" r="8"/><circle cx="26" cy="22" r="6"/>',
  repair: '<rect x="5" y="12" width="26" height="17" rx="3"/><rect x="13" y="8" width="10" height="5" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="16.5" y="15" width="3" height="11" fill-opacity=".4"/><rect x="12.5" y="19" width="11" height="3" fill-opacity=".4"/>',
  overdrive: '<path d="M3 24a15 15 0 0 1 30 0h-5a10 10 0 0 0-20 0z"/><path d="M17 23l9-10 2 2-9 10z"/><circle cx="18" cy="24" r="3"/>',
};
function partIcon(id) { return `<svg viewBox="0 0 36 36" fill="currentColor" aria-hidden="true">${PART_ICONS[id] || ''}</svg>`; }
