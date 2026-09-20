'use strict';
// ---------------------------------------------------------------------------
// Tunables: tank stats, modes, AI skill tiers, palettes and names.
// ---------------------------------------------------------------------------

const TANK = {
  radius: 22,          // collision radius
  maxSpeed: 170,       // px/s forward
  reverseSpeed: 110,   // px/s backward
  accel: 520,
  drag: 700,
  turnRate: 2.7,       // hull rad/s
  turretRate: 4.6,     // turret rad/s
  hp: 140,             // default; the match sets maxHp = hits × shellDamage
  reload: 0.72,
  shellSpeed: 780,
  shellRange: 980,
  shellDamage: 20,     // base damage; hit location adds up to ±damageSpread
  damageSpread: 5,
  shellRadius: 4,
  barrelLength: 34,
  spawnShield: 2.5,
  regenDelay: 5,       // seconds without being hit before repairs start
  regenRate: 0.05,     // fraction of max hp repaired per second
};

// Guided missile: charged by dealing shell damage, homes with a limited turn
// rate so sharp dodges and hard cover can beat it.
const MISSILE = {
  charge: 200,        // shell damage needed for a full charge
  damage: 60,         // direct-hit base damage
  spread: 15,         // ± by hit location, like shells
  splashRadius: 120,  // neighbours inside this take reduced damage
  splashDamage: 30,   // at the blast centre, falling off to 0 at the edge
  speed0: 230,        // launch speed (px/s)
  speed: 430,         // top speed
  accel: 380,
  turnRate: 2.3,      // rad/s steering limit
  lead: 1.0,          // aims at the predicted intercept point
  commit: 140,        // stops steering inside this range: a well-timed juke dodges it
  cone: 1.2,          // loses lock if the target gets this far off its nose (rad)
  arm: 0.18,          // flies straight this long before homing
  life: 5.5,          // self-destructs after this
  radius: 6,
  seekRange: 750,     // re-acquires a target within this cone/range
};

// Armor: how many average hits destroy a tank (menu slider).
const HITS = { min: 3, max: 12, default: 7 };

// Accent colours that mark each human player (rings, name tags, minimap).
const PLAYER_COLORS = ['#f0a93a', '#6fe3c1'];

const MODES = {
  tdm: {
    id: 'tdm', name: 'Team Deathmatch', short: 'TDM',
    blurb: 'First team to the kill limit wins.',
    teams: true, respawn: 3,
  },
  koth: {
    id: 'koth', name: 'King of the Hill', short: 'KOTH',
    blurb: 'Hold the central zone to score. Contest it to stop the clock.',
    teams: true, respawn: 4,
  },
  ctf: {
    id: 'ctf', name: 'Capture the Flag', short: 'CTF',
    blurb: 'Bring the enemy flag home while yours is safe.',
    teams: true, respawn: 5,
  },
  oneshot: {
    id: 'oneshot', name: 'One Shot', short: '1HIT',
    blurb: 'No heavy armor. Every hit is a kill.',
    teams: true, respawn: 2.5,
  },
  escort: {
    id: 'escort', name: 'Escort', short: 'ESC',
    blurb: 'Guard your supply convoy, then ambush theirs. Two rounds.',
    teams: true, respawn: 4,
  },
  hardcore: {
    id: 'hardcore', name: 'Hardcore', short: 'HC',
    blurb: 'No respawns. Wipe out the enemy squad to win the round. First to 3 rounds.',
    teams: true, respawn: 0,
  },
  br: {
    id: 'br', name: 'Battle Royale', short: 'BR',
    blurb: 'Every tank for itself as the zone shrinks. Last one running wins.',
    teams: false, respawn: 0,
  },
  jug: {
    id: 'jug', name: 'Juggernaut', short: 'JUG',
    blurb: 'Destroy the giant tank to become it. Only the Juggernaut scores.',
    teams: false, respawn: 3,
  },
};

const TEAM_SIZES = [1, 2, 4, 10];
const BR_SIZES = [6, 10, 20, 40];
const JUG_SIZES = [4, 6, 8, 12];

// Per-size rules for team modes.
const TEAM_RULES = {
  1:  { tdm: 5,  oneshot: 10, koth: 40, ctf: 2, time: 270, map: [2300, 1500] },
  2:  { tdm: 10, oneshot: 15, koth: 40, ctf: 2, time: 330, map: [2800, 1850] },
  4:  { tdm: 20, oneshot: 30, koth: 40, ctf: 2, time: 420, map: [3400, 2250] },
  10: { tdm: 40, oneshot: 60, koth: 40, ctf: 2, time: 540, map: [4300, 2900] },
};
const BR_MAP = { 6: 2700, 10: 3200, 16: 3800, 20: 4200, 40: 5400 };

// Hardcore: rounds without respawns. A round that runs out of time goes to
// the side with more tanks left (then more armor left).
const HARDCORE = { rounds: 3, breakTime: 4.5, time: { 1: 100, 2: 130, 4: 160, 10: 210 } };

// Team modes use the rules of the nearest listed squad size (campaign
// missions can field uneven teams such as 2v3).
function rulesSize(n) { return n <= 1 ? 1 : n <= 2 ? 2 : n <= 6 ? 4 : 10; }
// Free-for-all sizes come from a list; round up to one the maps are built for.
function ffaSize(mode, n) {
  const list = mode === 'jug' ? JUG_SIZES : BR_SIZES;
  return list.find(v => v >= n) || list[list.length - 1];
}

// Escort: each round the convoy needs about this long to reach extraction.
const ESCORT = { duration: 135, breakTime: 6, hpBase: 740, hpPerTank: 700 };

// Juggernaut: one oversized, heavily armed tank that everyone else hunts.
const JUGGERNAUT = {
  scale: 1.45,        // drawn and collides this much bigger
  hpMul: 5,           // × normal armor with 4 tanks…
  hpPerTank: 0.5,     // …plus this much more for every extra tank hunting it
  dmgMul: 1.5,        // shell and missile damage
  reloadMul: 0.7,
  regenMul: 0.3,      // repairs much slower than normal tanks
  pointsPerSec: 1,
  pointsPerKill: 5,
  time: 300,
  map: { 4: 2300, 6: 2600, 8: 2900, 12: 3300 },
};

// AI skill tiers. Every bot gets one of these; "mixed" draws from all of them.
const SKILLS = [
  { id: 1, name: 'Recruit',  reaction: 0.75, aimError: 0.16, aimDrift: 1.2, lead: 0.0,  fireCone: 0.30, dodge: 0.0,  strafe: 0.15, range: 270, retreat: 0.0, fireRate: 0.55, turret: 0.7 },
  { id: 2, name: 'Regular',  reaction: 0.45, aimError: 0.09, aimDrift: 1.6, lead: 0.45, fireCone: 0.18, dodge: 0.25, strafe: 0.45, range: 320, retreat: 0.2, fireRate: 0.8,  turret: 0.85 },
  { id: 3, name: 'Veteran',  reaction: 0.26, aimError: 0.045, aimDrift: 2.0, lead: 0.8, fireCone: 0.10, dodge: 0.55, strafe: 0.75, range: 360, retreat: 0.5, fireRate: 1.0,  turret: 1.0 },
  { id: 4, name: 'Elite',    reaction: 0.14, aimError: 0.02, aimDrift: 2.4, lead: 0.97, fireCone: 0.06, dodge: 0.85, strafe: 0.95, range: 400, retreat: 0.8, fireRate: 1.0,  turret: 1.0 },
];

const DIFFICULTIES = [
  { id: 'easy',   name: 'Recruit', blurb: 'Slow reactions, loose aim.', tiers: [1] },
  { id: 'normal', name: 'Regular', blurb: 'Leads shots, strafes a little.', tiers: [2] },
  { id: 'hard',   name: 'Veteran', blurb: 'Accurate, dodges, keeps range.', tiers: [3] },
  { id: 'elite',  name: 'Elite',   blurb: 'Near-perfect lead and evasive driving.', tiers: [4] },
  { id: 'mixed',  name: 'Mixed',   blurb: 'Every bot rolls its own skill tier.', tiers: [1, 2, 2, 3, 3, 4] },
];

// Team liveries. main = hull, dark = trim, light = highlights, ui = HUD color.
const TEAM_COLORS = [
  { name: 'Cobalt', main: '#3f7fc4', dark: '#244a78', light: '#8cc0f2', camo: '#2f6199', ui: '#5fb0ff' },
  { name: 'Ember',  main: '#c2533b', dark: '#7a2d1e', light: '#f29a7c', camo: '#963f2c', ui: '#ff6b52' },
];

// Free-for-all liveries (Battle Royale). Index 0 is used for the player.
const FFA_HUES = [150, 8, 45, 275, 195, 330, 28, 95, 220, 350, 60, 250, 175, 15, 305, 120, 38, 205, 290, 75];
function ffaColor(i) {
  const h = FFA_HUES[i % FFA_HUES.length];
  const main = hslToHex(h, 48, 46);
  return {
    name: 'FFA' + i, main,
    dark: hslToHex(h, 45, 27), light: hslToHex(h, 70, 72),
    camo: hslToHex(h, 45, 36), ui: hslToHex(h, 80, 64),
  };
}

const BIOMES = {
  grassland: {
    id: 'grassland', name: 'Grassland',
    ground: ['#5c7a3a', '#6b8a43', '#7d9a4e', '#4f6b33'],
    dirt: '#8a7550', dirtDark: '#6b5a3c',
    detail: ['#86a85a', '#a3c06b', '#4a6530'], flowers: ['#f2e2a0', '#e8a0b8', '#ffffff', '#c8b8f0'],
    rock: '#8d8a80', tree: ['#3d5f2a', '#4c7433', '#5e8a3d'], treeType: 'broadleaf',
    concrete: '#a8a498', roof: ['#6f6a62', '#7d5b4a', '#5b6570'],
    border: '#2f3d22', scorch: '#1e1a12', cloud: 0.16, ambient: 'pollen',
  },
  desert: {
    id: 'desert', name: 'Desert',
    ground: ['#d2b27a', '#c9a56b', '#dcbd88', '#bf9a60'],
    dirt: '#a8834f', dirtDark: '#8f6d3e',
    detail: ['#b8935a', '#e6cc9a', '#9c8a4a'], flowers: ['#8a9a50', '#a0a860'],
    rock: '#b08a62', tree: ['#6f8a3a', '#809c44', '#5d7630'], treeType: 'palm',
    concrete: '#d8c6a0', roof: ['#c9a878', '#b88a5c', '#d6c09a'],
    border: '#8a6a3e', scorch: '#2a1f14', cloud: 0.12, ambient: 'dust',
  },
  snow: {
    id: 'snow', name: 'Tundra',
    ground: ['#e8eef2', '#dfe7ec', '#f2f6f8', '#d3dde4'],
    dirt: '#a9b4bb', dirtDark: '#8d989f',
    detail: ['#c9d6de', '#ffffff', '#b8c6cf'], flowers: ['#9fb0bb'],
    rock: '#7d8790', tree: ['#2e4a3c', '#375847', '#426651'], treeType: 'pine',
    concrete: '#b9c1c6', roof: ['#5b6670', '#6d5e58', '#4f5b66'],
    border: '#6d7c86', scorch: '#23262a', cloud: 0.14, ambient: 'snow',
  },
  badlands: {
    id: 'badlands', name: 'Badlands',
    ground: ['#b3603a', '#c06b40', '#a8532f', '#cc7b4c'],
    dirt: '#8f4a2c', dirtDark: '#6c341d',
    detail: ['#8c3f22', '#d98f5f', '#7d6a3a'], flowers: ['#d8c28a', '#e8d9b0'],
    rock: '#a04f30', tree: ['#4f6b34', '#5f7d3c', '#3f5829'], treeType: 'cactus',
    concrete: '#c9a07f', roof: ['#9a5a3c', '#7a4a36', '#b3764e'],
    border: '#5e2b17', scorch: '#2a140b', cloud: 0.1, ambient: 'dust',
  },
  cherry: {
    id: 'cherry', name: 'Blossom',
    ground: ['#6d9a56', '#7ea663', '#8cb26e', '#5d8948'],
    dirt: '#a8927a', dirtDark: '#86735d',
    detail: ['#8fb96d', '#a9c983', '#5a8243'], flowers: ['#f7b8cf', '#fbd5e3', '#ffffff', '#f09ab9'],
    rock: '#8b9098', tree: ['#d9779c', '#ec9fbd', '#f8c9da'], treeType: 'blossom',
    concrete: '#cbc4ba', roof: ['#4a4e62', '#6e3b3f', '#3c4a44'],
    border: '#34462a', scorch: '#221c18', cloud: 0.12, ambient: 'petals',
  },
  autumn: {
    id: 'autumn', name: 'Autumn',
    ground: ['#7c7a3c', '#8b8543', '#9b904b', '#6c6935'],
    dirt: '#8c6b45', dirtDark: '#6b5034',
    detail: ['#a39449', '#b89c52', '#6f6a34'], flowers: ['#d9742c', '#c4502a', '#e8a838', '#a53f27', '#e0c060'],
    rock: '#8a857a', tree: ['#b3461f', '#d56f2a', '#eba443'], treeType: 'autumn',
    concrete: '#b2aa9a', roof: ['#6a5a4a', '#7a4a3a', '#56605c'],
    border: '#3e3420', scorch: '#221a10', cloud: 0.15, ambient: 'leaves',
  },
  marsh: {
    id: 'marsh', name: 'Marsh',
    ground: ['#4d5b39', '#58673f', '#647246', '#434f30'],
    dirt: '#6b5b3e', dirtDark: '#4a3f2a',
    detail: ['#8a9a5a', '#a8ad6a', '#5d6b3a'], flowers: ['#e6dfb0', '#cfd98f'],
    rock: '#70736a', tree: ['#4f6a32', '#6a8640', '#8aa352'], treeType: 'willow',
    concrete: '#9d9c90', roof: ['#5a5f58', '#6b5646', '#48524e'],
    border: '#262f1f', scorch: '#1c1a12', cloud: 0.24, ambient: 'drizzle',
  },
};
const BIOME_IDS = ['grassland', 'desert', 'snow', 'badlands', 'cherry', 'autumn', 'marsh'];

const CONTAINER_COLORS = ['#b5482f', '#2f7d8a', '#d19a2e', '#35507a', '#6b8a3a', '#8a3b5c'];

const CALLSIGNS = [
  'Viper', 'Rook', 'Maverick', 'Havoc', 'Onyx', 'Bishop', 'Warden', 'Talon', 'Grizzly', 'Nomad',
  'Jackal', 'Cobra', 'Ranger', 'Bulldog', 'Specter', 'Hammer', 'Anvil', 'Raptor', 'Sable', 'Ghost',
  'Mantis', 'Boomer', 'Duke', 'Rhino', 'Tempest', 'Brick', 'Falcon', 'Hex', 'Kodiak', 'Lynx',
  'Oxide', 'Pike', 'Quarry', 'Rivet', 'Sledge', 'Torque', 'Vandal', 'Wolfram', 'Yeti', 'Zephyr',
  'Cinder', 'Flint', 'Gunner', 'Jolt', 'Mortar', 'Piston', 'Slate', 'Tusk', 'Ironside', 'Badger',
];
