'use strict';
// ---------------------------------------------------------------------------
// Campaign: regions, missions (each with its own designed map), enemy tech
// tiers, stars, rewards and pilot saves. Pure data and logic (no DOM); the
// world map and hangar screens live in worldmap.js and ui.js.
// ---------------------------------------------------------------------------

// Hangar upgrades bought with mission money.
const UPGRADES = {
  max: 6,
  cost: [250, 400, 600, 850, 1150, 1500],
  hp: 0.08,    // armor plating: +8% armor per level
  dmg: 0.07,   // gun calibre: +7% damage per level
};

// Mission maps are recipes for GameMap: set pieces in normalised coordinates
// (team maps mirror each one through the centre unless c: 1), then a light
// procedural fill. t: hedge | line (k: sandbags, barrier, pipe) | bld (k: barn,
// house, temple, bunker, building) | grove | orchard | rocks | ridge | wreck |
// village | pond | river | road (convoy: follow it) | field | ice | scorch | clear.
//
// Star conditions. The first star is always "win the mission".
// t: deaths | time | kills | damage | mvp | margin | caps | ace | flawless |
//    convoyKill | convoySafe | convoyFast | points
const CAMPAIGN = {
  title: 'The Iron Road',
  regions: [
    {
      id: 'greenbelt', biome: 'grassland', name: 'Greenbelt', blurb: 'Rolling farmland where the war begins.',
      levels: [
        { id: 'g1', name: 'First Contact', mode: 'tdm', sizes: [1, 1], foes: [1], tier: 0, rules: { limit: 3, time: 180 }, reward: 200,
          brief: 'A lone enemy scout is probing the farm fields around the old barn. Find it and put it down.',
          stars: [{ t: 'deaths', n: 0 }, { t: 'time', n: 100 }],
          map: { density: 0.05, features: [
            { t: 'field', x: 0.3, y: 0.27, w: 380, h: 220, a: 0.08 }, { t: 'field', x: 0.36, y: 0.74, w: 320, h: 230, a: -0.12 },
            { t: 'hedge', x: 0.3, y: 0.5, len: 300 }, { t: 'hedge', x: 0.44, y: 0.3, len: 240, v: 1 },
            { t: 'bld', k: 'house', x: 0.42, y: 0.66, w: 90, h: 64 }, { t: 'bld', k: 'barn', x: 0.5, y: 0.5, w: 160, h: 90, c: 1 },
            { t: 'grove', x: 0.27, y: 0.86, r: 60, n: 1 },
          ] } },
        { id: 'g2', name: 'Squad Up', mode: 'tdm', sizes: [2, 2], allies: [2], foes: [1], tier: 0, rules: { limit: 6, time: 240 }, reward: 220,
          brief: 'You have a wingman now. Clear the patrol off the farm roads together.',
          stars: [{ t: 'kills', n: 3 }, { t: 'mvp' }],
          map: { density: 0.06, roads: 'custom', features: [
            { t: 'road', pts: [[0.03, 0.5], [0.3, 0.5], [0.42, 0.3], [0.58, 0.3], [0.7, 0.5], [0.97, 0.5]] },
            { t: 'field', x: 0.33, y: 0.18, w: 360, h: 210 }, { t: 'field', x: 0.44, y: 0.74, w: 300, h: 240, a: 0.2 },
            { t: 'hedge', x: 0.27, y: 0.35, len: 260 }, { t: 'hedge', x: 0.5, y: 0.5, len: 220, v: 1, c: 1 },
            { t: 'bld', k: 'house', x: 0.38, y: 0.42, w: 100, h: 70 }, { t: 'bld', k: 'barn', x: 0.27, y: 0.67, w: 140, h: 80 },
            { t: 'grove', x: 0.42, y: 0.9, r: 70, n: 2 },
          ] } },
        { id: 'g3', name: 'Crossroads', mode: 'koth', sizes: [2, 2], allies: [2], foes: [1, 1, 2], tier: 0, rules: { limit: 30, time: 240 }, reward: 240,
          brief: 'Two farm roads cross in the middle of the valley. Hold the crossroads long enough for the column behind you to pass.',
          stars: [{ t: 'margin', n: 10 }, { t: 'deaths', n: 1 }],
          map: { density: 0.07, roads: 'custom', features: [
            { t: 'road', pts: [[0.03, 0.5], [0.5, 0.5], [0.97, 0.5]], c: 1 }, { t: 'road', pts: [[0.5, -0.03], [0.5, 0.5], [0.5, 1.03]], c: 1 },
            { t: 'bld', k: 'house', x: 0.4, y: 0.28, w: 110, h: 80 }, { t: 'bld', k: 'house', x: 0.4, y: 0.72, w: 100, h: 76 },
            { t: 'hedge', x: 0.32, y: 0.38, len: 180 }, { t: 'field', x: 0.28, y: 0.2, w: 280, h: 190 }, { t: 'grove', x: 0.3, y: 0.8, r: 70, n: 2 },
          ] } },
        { id: 'g4', name: 'Flag Run', mode: 'ctf', sizes: [2, 2], allies: [2], foes: [1, 1, 2], tier: 1, rules: { limit: 2, time: 330 }, reward: 260,
          brief: 'Each side keeps its colours in a barn yard. Steal theirs and bring them home. Twice.',
          stars: [{ t: 'caps', n: 1 }, { t: 'time', n: 240 }],
          map: { density: 0.07, features: [
            { t: 'bld', k: 'barn', x: 0.2, y: 0.5, w: 90, h: 160 },
            { t: 'hedge', x: 0.27, y: 0.33, len: 200 }, { t: 'hedge', x: 0.27, y: 0.67, len: 200 },
            { t: 'field', x: 0.4, y: 0.25, w: 360, h: 220 }, { t: 'field', x: 0.42, y: 0.72, w: 320, h: 220, a: 0.1 },
            { t: 'bld', k: 'house', x: 0.4, y: 0.48, w: 90, h: 70 }, { t: 'grove', x: 0.5, y: 0.5, r: 30, n: 1, c: 1 },
          ] } },
        { id: 'g5', name: 'Outnumbered', mode: 'tdm', sizes: [2, 3], allies: [2], foes: [1, 1, 2], tier: 1, rules: { limit: 8, time: 300 }, reward: 280,
          brief: 'Three tanks against your two in the hedgerow country. Use the hedges and pick them off.',
          stars: [{ t: 'deaths', n: 2 }, { t: 'damage', n: 500 }],
          map: { density: 0.05, kinds: { tree: 0.5, rock: 0.2, house: 0.2, crates: 0.1 }, features: [
            { t: 'hedge', x: 0.26, y: 0.34, len: 300 }, { t: 'hedge', x: 0.26, y: 0.66, len: 300 },
            { t: 'hedge', x: 0.36, y: 0.2, len: 260, v: 1 }, { t: 'hedge', x: 0.36, y: 0.58, len: 300, v: 1 },
            { t: 'hedge', x: 0.45, y: 0.4, len: 280 }, { t: 'hedge', x: 0.44, y: 0.84, len: 260 },
            { t: 'hedge', x: 0.5, y: 0.5, len: 260, v: 1, c: 1 },
            { t: 'field', x: 0.3, y: 0.5, w: 260, h: 200 }, { t: 'field', x: 0.42, y: 0.62, w: 240, h: 180, a: 0.1 },
            { t: 'bld', k: 'barn', x: 0.43, y: 0.22, w: 150, h: 80 },
          ] } },
        { id: 'g6', name: 'The Iron Duke', mode: 'hardcore', sizes: [3, 3], allies: [2, 3], foes: [1], tier: 1, rules: { limit: 2 }, reward: 340, boss: true,
          twists: { ace: { name: 'Iron Duke', skill: 3, hp: 1.4, dmg: 1, loadout: { hull: 'big' } } },
          brief: 'The Iron Duke leads their counterattack through the village in a heavily armored tank. No respawns: win two rounds and the Greenbelt is ours.',
          stars: [{ t: 'ace' }, { t: 'mvp' }],
          map: { density: 0.06, noCenter: true, features: [
            { t: 'village', x: 0.42, y: 0.33, r: 130, n: 3 }, { t: 'village', x: 0.42, y: 0.7, r: 120, n: 2 },
            { t: 'bld', k: 'building', x: 0.5, y: 0.5, w: 160, h: 120, c: 1 },
            { t: 'hedge', x: 0.3, y: 0.5, len: 220, v: 1 }, { t: 'line', k: 'sandbags', x: 0.37, y: 0.5, len: 140, v: 1 },
            { t: 'field', x: 0.3, y: 0.2, w: 300, h: 180 },
          ] } },
      ],
    },
    {
      id: 'blossom', biome: 'cherry', name: 'Blossom Valley', blurb: 'Temple gardens in full spring bloom.',
      levels: [
        { id: 'b1', name: 'Petal Storm', mode: 'oneshot', sizes: [2, 2], allies: [2], foes: [1, 2], tier: 1, rules: { limit: 10, time: 270 }, reward: 360,
          brief: 'A duel among the orchard rows with armor stripped for speed on both sides. One hit ends any tank.',
          stars: [{ t: 'kills', n: 4 }, { t: 'deaths', n: 2 }],
          map: { density: 0.03, kinds: { tree: 0.7, rock: 0.3 }, features: [
            { t: 'orchard', x: 0.34, y: 0.3, cols: 3, rows: 3, gap: 115 }, { t: 'orchard', x: 0.36, y: 0.73, cols: 3, rows: 2, gap: 115 },
            { t: 'orchard', x: 0.5, y: 0.5, cols: 2, rows: 2, gap: 130, c: 1 }, { t: 'bld', k: 'house', x: 0.46, y: 0.22, w: 80, h: 60 },
          ] } },
        { id: 'b2', name: 'Supply Line', mode: 'escort', sizes: [2, 2], allies: [2], foes: [2], tier: 1, reward: 380,
          brief: 'Run our supply truck along the valley road past the shrines, then ambush theirs on the same road.',
          stars: [{ t: 'convoyKill' }, { t: 'convoySafe' }],
          map: { density: 0.07, roads: 'custom', features: [
            { t: 'road', convoy: true, c: 1, pts: [[0.07, 0.5], [0.25, 0.42], [0.42, 0.62], [0.58, 0.38], [0.75, 0.58], [0.93, 0.5]] },
            { t: 'grove', x: 0.3, y: 0.18, r: 110, n: 3 }, { t: 'grove', x: 0.34, y: 0.84, r: 100, n: 3 },
            { t: 'bld', k: 'temple', x: 0.5, y: 0.16, w: 130, h: 90 }, { t: 'rocks', x: 0.46, y: 0.44, r: 40, n: 1 },
          ] } },
        { id: 'b3', name: 'Lanterns Out', mode: 'tdm', sizes: [2, 2], allies: [2], foes: [2], tier: 2, rules: { limit: 8, time: 300 }, reward: 400,
          twists: { night: true },
          brief: 'A night raid through the temple gardens and their ponds. You will only see what your lights reach, and neither will they.',
          stars: [{ t: 'deaths', n: 1 }, { t: 'kills', n: 4 }],
          map: { density: 0.06, kinds: { tree: 0.45, rock: 0.35, hedge: 0.2 }, features: [
            { t: 'pond', x: 0.36, y: 0.3, r: 80 }, { t: 'pond', x: 0.5, y: 0.5, r: 70, c: 1 },
            { t: 'bld', k: 'temple', x: 0.3, y: 0.63, w: 100, h: 80 },
            { t: 'hedge', x: 0.42, y: 0.73, len: 200 }, { t: 'hedge', x: 0.24, y: 0.38, len: 160, v: 1 }, { t: 'rocks', x: 0.44, y: 0.34, r: 40, n: 2 },
          ] } },
        { id: 'b4', name: 'Temple Hill', mode: 'koth', sizes: [4, 4], allies: [2, 2, 3], foes: [1, 2, 2, 3], tier: 2, rules: { limit: 40, time: 360 }, reward: 430,
          brief: 'Two great temples flank the courtyard at the top of the valley. Take the courtyard and keep it.',
          stars: [{ t: 'margin', n: 10 }, { t: 'mvp' }],
          map: { density: 0.07, noCenter: true, features: [
            { t: 'bld', k: 'temple', x: 0.5, y: 0.22, w: 220, h: 130 },
            { t: 'orchard', x: 0.36, y: 0.3, cols: 2, rows: 2, gap: 120 }, { t: 'orchard', x: 0.37, y: 0.72, cols: 2, rows: 2, gap: 120 },
            { t: 'line', k: 'barrier', x: 0.42, y: 0.5, len: 150, v: 1 }, { t: 'rocks', x: 0.44, y: 0.36, r: 30, n: 1 },
          ] } },
        { id: 'b5', name: 'Last Tank Standing', mode: 'hardcore', sizes: [2, 2], allies: [2], foes: [2, 2], tier: 2, reward: 460,
          brief: 'A clipped-hedge maze in the palace gardens, and no reinforcements coming. Every tank you lose stays lost until the round is over.',
          stars: [{ t: 'flawless' }, { t: 'kills', n: 3 }],
          map: { density: 0.04, kinds: { tree: 0.6, rock: 0.4 }, features: [
            { t: 'hedge', x: 0.34, y: 0.3, len: 260 }, { t: 'hedge', x: 0.34, y: 0.7, len: 260 },
            { t: 'hedge', x: 0.42, y: 0.5, len: 280, v: 1 }, { t: 'hedge', x: 0.26, y: 0.5, len: 200, v: 1 },
            { t: 'hedge', x: 0.5, y: 0.33, len: 240 }, { t: 'pond', x: 0.5, y: 0.5, r: 60, c: 1 },
            { t: 'bld', k: 'temple', x: 0.28, y: 0.85, w: 90, h: 70 },
          ] } },
        { id: 'b6', name: 'The Gardener', mode: 'hardcore', sizes: [4, 4], allies: [2, 3, 3], foes: [2, 3], tier: 2, allyTier: 2, rules: { limit: 2 }, reward: 520, boss: true,
          twists: { ace: { name: 'The Gardener', skill: 3, hp: 1.5, dmg: 1, loadout: { hull: 'feather', weapon: 'mg', tires: 'rover', special: 'smoke' } } },
          brief: 'A fast, smoke-shrouded ace holds the formal gardens. No respawns, and no second chances: take two rounds off him.',
          stars: [{ t: 'ace' }, { t: 'flawless' }],
          map: { density: 0.07, features: [
            { t: 'hedge', x: 0.2, y: 0.36, len: 200 }, { t: 'hedge', x: 0.2, y: 0.64, len: 200 },
            { t: 'orchard', x: 0.34, y: 0.5, cols: 2, rows: 3, gap: 120 }, { t: 'bld', k: 'temple', x: 0.5, y: 0.5, w: 150, h: 110, c: 1 },
            { t: 'pond', x: 0.42, y: 0.24, r: 70 }, { t: 'hedge', x: 0.44, y: 0.73, len: 240 },
          ] } },
      ],
    },
    {
      id: 'rustleaf', biome: 'autumn', name: 'Rustleaf Ridge', blurb: 'Forested ridgelines under autumn fire.',
      levels: [
        { id: 'a1', name: 'Leaf Litter', mode: 'tdm', sizes: [4, 4], allies: [2, 3], foes: [2, 2, 3], tier: 2, rules: { limit: 16, time: 360 }, reward: 560,
          twists: { minefield: 16 },
          brief: 'Both sides mined the clearing between the woods before the leaves came down. Watch the ground.',
          stars: [{ t: 'deaths', n: 2 }, { t: 'kills', n: 5 }],
          map: { density: 0.13, kinds: { tree: 0.7, rock: 0.2, crates: 0.1 }, features: [
            { t: 'clear', x: 0.5, y: 0.5, r: 280, c: 1 }, { t: 'grove', x: 0.3, y: 0.3, r: 160, n: 4 }, { t: 'grove', x: 0.4, y: 0.72, r: 160, n: 4 },
          ] } },
        { id: 'a2', name: 'Hunting Season', mode: 'jug', size: 6, foes: [2, 3], tier: 2, rules: { time: 240 }, reward: 580,
          brief: 'A free-for-all in the hunting woods around the old lodges. Take the crown from whoever is wearing it and keep it.',
          stars: [{ t: 'points', n: 60 }, { t: 'kills', n: 5 }],
          map: { density: 0.12, kinds: { tree: 0.75, rock: 0.25 }, features: [
            { t: 'bld', k: 'house', x: 0.3, y: 0.3, w: 110, h: 80 }, { t: 'bld', k: 'house', x: 0.7, y: 0.7, w: 110, h: 80 },
            { t: 'bld', k: 'barn', x: 0.68, y: 0.28, w: 150, h: 90 }, { t: 'bld', k: 'house', x: 0.32, y: 0.72, w: 100, h: 70 },
            { t: 'clear', x: 0.5, y: 0.5, r: 220 },
          ] } },
        { id: 'a3', name: 'Shell Shock', mode: 'escort', sizes: [4, 4], allies: [2, 3], foes: [2, 3], tier: 3, reward: 620,
          twists: { barrage: true },
          brief: 'Every enemy tank carries a mortar and the road is already cratered. Keep the convoy moving through the barrage.',
          stars: [{ t: 'convoyFast', n: 105 }, { t: 'convoySafe' }],
          map: { density: 0.06, features: [
            { t: 'road', convoy: true, c: 1, pts: [[0.07, 0.5], [0.3, 0.36], [0.5, 0.5], [0.7, 0.64], [0.93, 0.5]] },
            { t: 'scorch', x: 0.36, y: 0.6, r: 110 }, { t: 'scorch', x: 0.46, y: 0.3, r: 100 },
            { t: 'wreck', x: 0.4, y: 0.45 }, { t: 'wreck', x: 0.28, y: 0.7 }, { t: 'wreck', x: 0.46, y: 0.78 }, { t: 'grove', x: 0.3, y: 0.17, r: 90, n: 2 },
          ] } },
        { id: 'a4', name: 'Ridge Line', mode: 'koth', sizes: [4, 5], allies: [2, 3, 3], foes: [2, 2, 2], tier: 2, allyTier: 2, rules: { limit: 40, time: 360 }, reward: 650,
          brief: 'A rocky ridge rings the summit and they hold it with five tanks. Take it back with four through the passes.',
          stars: [{ t: 'margin', n: 10 }, { t: 'deaths', n: 3 }],
          map: { density: 0.05, features: [
            { t: 'ridge', x1: 0.36, y1: 0.12, x2: 0.4, y2: 0.4, gaps: [0.5] }, { t: 'ridge', x1: 0.4, y1: 0.6, x2: 0.36, y2: 0.88, gaps: [0.5] },
            { t: 'grove', x: 0.26, y: 0.5, r: 90, n: 2 }, { t: 'rocks', x: 0.44, y: 0.5, r: 30, n: 1 },
          ] } },
        { id: 'a5', name: 'No Retreat', mode: 'hardcore', sizes: [4, 4], allies: [2, 3], foes: [2, 3, 3], tier: 3, reward: 680,
          twists: { noRegen: true },
          brief: 'Two trench lines face each other across the ridge. Supply lines are cut: no field repairs, no respawns.',
          stars: [{ t: 'flawless' }, { t: 'kills', n: 4 }],
          map: { density: 0.06, features: [
            { t: 'line', k: 'sandbags', x: 0.3, y: 0.3, len: 200, v: 1 }, { t: 'line', k: 'sandbags', x: 0.3, y: 0.7, len: 200, v: 1 },
            { t: 'line', k: 'sandbags', x: 0.4, y: 0.5, len: 240, v: 1 }, { t: 'line', k: 'sandbags', x: 0.44, y: 0.2, len: 180, v: 1 },
            { t: 'bld', k: 'bunker', x: 0.35, y: 0.5, w: 70, h: 60 }, { t: 'wreck', x: 0.5, y: 0.5, c: 1 }, { t: 'scorch', x: 0.5, y: 0.35, r: 90 },
          ] } },
        { id: 'a6', name: 'The Red Warden', mode: 'hardcore', sizes: [4, 4], allies: [2, 3, 3], foes: [2, 2, 3], tier: 3, allyTier: 3, rules: { limit: 2 }, reward: 760, boss: true,
          twists: { night: true, ace: { name: 'Red Warden', skill: 3, hp: 1.45, dmg: 1, loadout: { hull: 'sloped', weapon: 'longgun', special: 'artillery' } } },
          brief: 'A sniper ace hunts the open ridges at night with a long gun and a mortar. No respawns: get close before he sees you.',
          stars: [{ t: 'ace' }, { t: 'mvp' }],
          map: { density: 0.04, features: [
            { t: 'ridge', x1: 0.3, y1: 0.35, x2: 0.46, y2: 0.2, gaps: [0.45] }, { t: 'ridge', x1: 0.3, y1: 0.65, x2: 0.46, y2: 0.8, gaps: [0.55] },
            { t: 'grove', x: 0.4, y: 0.5, r: 80, n: 2 }, { t: 'wreck', x: 0.5, y: 0.5, c: 1 },
          ] } },
      ],
    },
    {
      id: 'frostline', biome: 'snow', name: 'Frostline', blurb: 'The frozen front. Their best crews are dug in here.',
      levels: [
        { id: 'f1', name: 'Polar Night', mode: 'ctf', sizes: [4, 4], allies: [3], foes: [3], tier: 3, rules: { limit: 2, time: 420 }, reward: 800,
          twists: { night: true },
          brief: 'Six hours of daylight up here, and this isn\'t one of them. Cross the frozen lake and take their flag from its bunker line.',
          stars: [{ t: 'caps', n: 1 }, { t: 'deaths', n: 3 }],
          map: { density: 0.07, features: [
            { t: 'ice', x: 0.5, y: 0.5, r: 300, c: 1 }, { t: 'clear', x: 0.5, y: 0.5, r: 240, c: 1 },
            { t: 'bld', k: 'bunker', x: 0.21, y: 0.5, w: 70, h: 60 },
            { t: 'bld', k: 'bunker', x: 0.3, y: 0.34, w: 64, h: 56 }, { t: 'bld', k: 'bunker', x: 0.3, y: 0.66, w: 64, h: 56 },
            { t: 'grove', x: 0.4, y: 0.19, r: 110, n: 3 }, { t: 'grove', x: 0.4, y: 0.83, r: 110, n: 3 },
          ] } },
        { id: 'f2', name: 'Frozen Convoy', mode: 'escort', sizes: [4, 4], allies: [3], foes: [3, 3, 4], tier: 4, reward: 840,
          twists: { minefield: 12 },
          brief: 'The ice road is mined along its whole length. Escort the convoy through, then catch theirs.',
          stars: [{ t: 'convoyKill' }, { t: 'convoySafe' }],
          map: { density: 0.07, features: [
            { t: 'road', convoy: true, c: 1, pts: [[0.07, 0.5], [0.28, 0.62], [0.5, 0.5], [0.72, 0.38], [0.93, 0.5]] },
            { t: 'ice', x: 0.38, y: 0.28, r: 200 }, { t: 'grove', x: 0.3, y: 0.84, r: 120, n: 3 },
            { t: 'wreck', x: 0.44, y: 0.66 }, { t: 'bld', k: 'house', x: 0.46, y: 0.18, w: 100, h: 70 },
          ] } },
        { id: 'f3', name: 'Blizzard Royale', mode: 'br', size: 10, foes: [2, 3, 3, 4], tier: 3, reward: 880,
          brief: 'Ten tanks around a frozen village, one survivor. The storm is closing in.',
          stars: [{ t: 'kills', n: 4 }, { t: 'damage', n: 700 }],
          map: { density: 0.09, features: [
            { t: 'village', x: 0.5, y: 0.5, r: 220, n: 6 }, { t: 'ice', x: 0.25, y: 0.3, r: 220 }, { t: 'ice', x: 0.72, y: 0.75, r: 180 },
            { t: 'bld', k: 'bunker', x: 0.3, y: 0.75, w: 70, h: 60 }, { t: 'bld', k: 'bunker', x: 0.75, y: 0.25, w: 70, h: 60, flip: 1 },
          ] } },
        { id: 'f4', name: 'Iron Wall', mode: 'hardcore', sizes: [4, 4], allies: [3], foes: [3, 4], tier: 4, reward: 920,
          twists: { enemyHull: 'big' },
          brief: 'A concrete wall splits the field and their whole line drives heavy hulls. Flank around the ends; don\'t trade shots head-on.',
          stars: [{ t: 'flawless' }, { t: 'mvp' }],
          map: { density: 0.05, noCenter: true, features: [
            { t: 'line', k: 'barrier', x: 0.5, y: 0.5, len: 720, v: 1, c: 1 }, { t: 'bld', k: 'bunker', x: 0.44, y: 0.5, w: 70, h: 64 },
            { t: 'line', k: 'barrier', x: 0.4, y: 0.24, len: 200 }, { t: 'grove', x: 0.36, y: 0.85, r: 90, n: 2 },
          ] } },
        { id: 'f5', name: 'Avalanche', mode: 'tdm', sizes: [10, 10], allies: [2, 3], foes: [2, 3, 3, 4], tier: 4, rules: { limit: 40, time: 540 }, reward: 960,
          brief: 'Both armies commit everything. Twenty tanks on one frozen field strewn with wrecks.',
          stars: [{ t: 'kills', n: 8 }, { t: 'mvp' }],
          map: { density: 0.05, features: [
            { t: 'wreck', x: 0.4, y: 0.3 }, { t: 'wreck', x: 0.44, y: 0.62 }, { t: 'wreck', x: 0.35, y: 0.5 },
            { t: 'ice', x: 0.5, y: 0.5, r: 380, c: 1 }, { t: 'rocks', x: 0.3, y: 0.3, r: 100, n: 2 },
            { t: 'ridge', x1: 0.42, y1: 0.12, x2: 0.46, y2: 0.3 },
          ] } },
        { id: 'f6', name: 'The Frost Marshal', mode: 'hardcore', sizes: [4, 4], allies: [3, 3], foes: [3, 4], tier: 5, rules: { limit: 2 }, reward: 1100, boss: true,
          twists: { ace: { name: 'Frost Marshal', skill: 4, hp: 2.05, dmg: 1.2, loadout: { hull: 'dozer', weapon: 'flame', tires: 'christie', special: 'repair' } } },
          brief: 'The Marshal drives a flame-throwing bulldozer out of his bunker line, and he outnumbers you. No respawns: end this in two rounds.',
          stars: [{ t: 'ace' }, { t: 'flawless' }],
          map: { density: 0.06, features: [
            { t: 'bld', k: 'bunker', x: 0.3, y: 0.3, w: 80, h: 70 }, { t: 'bld', k: 'bunker', x: 0.3, y: 0.7, w: 80, h: 70 },
            { t: 'line', k: 'barrier', x: 0.36, y: 0.5, len: 320, v: 1 },
            { t: 'line', k: 'sandbags', x: 0.42, y: 0.28, len: 180 }, { t: 'line', k: 'sandbags', x: 0.42, y: 0.72, len: 180 },
            { t: 'ice', x: 0.5, y: 0.5, r: 220, c: 1 },
          ] } },
      ],
    },
    {
      id: 'marsh', biome: 'marsh', name: 'Sunken Marsh', blurb: 'Flooded lowlands. Water slows everything but heavy quad tracks.',
      levels: [
        { id: 'm1', name: 'Wading In', mode: 'tdm', sizes: [4, 4], allies: [3], foes: [3], tier: 4, rules: { limit: 16, time: 420 }, reward: 1150,
          brief: 'A slow river splits the marsh. Hold the bridges or wade across: heavy quad tracks handle the water best.',
          stars: [{ t: 'deaths', n: 2 }, { t: 'kills', n: 5 }],
          map: { density: 0.07, noPools: 1, noCenter: true, features: [
            { t: 'river', c: 1, w: 150, pts: [[0.5, -0.02], [0.46, 0.25], [0.5, 0.5], [0.54, 0.75], [0.5, 1.02]] },
            { t: 'pond', x: 0.3, y: 0.3, r: 70 }, { t: 'grove', x: 0.36, y: 0.75, r: 100, n: 3 }, { t: 'wreck', x: 0.4, y: 0.4 },
          ] } },
        { id: 'm2', name: 'Fogbound', mode: 'ctf', sizes: [4, 4], allies: [3], foes: [3], tier: 4, rules: { limit: 2, time: 450 }, reward: 1200,
          twists: { fog: true },
          brief: 'Thick fog rolls off the pools. Find their flag before they find yours.',
          stars: [{ t: 'caps', n: 1 }, { t: 'deaths', n: 3 }],
          map: { density: 0.07, features: [
            { t: 'hedge', x: 0.34, y: 0.5, len: 260, v: 1 }, { t: 'bld', k: 'house', x: 0.42, y: 0.3, w: 100, h: 70 }, { t: 'wreck', x: 0.46, y: 0.66 },
          ] } },
        { id: 'm3', name: 'Causeway Convoy', mode: 'escort', sizes: [4, 4], allies: [3], foes: [3, 4], tier: 4, reward: 1250,
          brief: 'The only dry route through the marsh is a single causeway. Run our truck along it, then ambush theirs.',
          stars: [{ t: 'convoyKill' }, { t: 'convoySafe' }],
          map: { density: 0.06, noPools: 1, roads: 'custom', features: [
            { t: 'road', convoy: true, c: 1, pts: [[0.05, 0.5], [0.3, 0.5], [0.5, 0.5], [0.7, 0.5], [0.95, 0.5]] },
            { t: 'pond', x: 0.3, y: 0.4, r: 120 }, { t: 'pond', x: 0.37, y: 0.6, r: 130 }, { t: 'pond', x: 0.46, y: 0.42, r: 110 },
            { t: 'grove', x: 0.26, y: 0.18, r: 100, n: 2 }, { t: 'bld', k: 'house', x: 0.42, y: 0.84, w: 100, h: 70 },
          ] } },
        { id: 'm4', name: 'Drowned Village', mode: 'koth', sizes: [4, 4], allies: [3, 3, 4], foes: [3, 4], tier: 5, rules: { limit: 40, time: 420 }, reward: 1300,
          brief: 'The flooded village square is the last dry ground for miles. Take it.',
          stars: [{ t: 'margin', n: 10 }, { t: 'mvp' }],
          map: { density: 0.06, noPools: 1, noCenter: true, features: [
            { t: 'village', x: 0.4, y: 0.3, r: 140, n: 3 }, { t: 'village', x: 0.4, y: 0.72, r: 120, n: 2 },
            { t: 'pond', x: 0.33, y: 0.5, r: 110 }, { t: 'pond', x: 0.47, y: 0.18, r: 90 }, { t: 'bld', k: 'barn', x: 0.27, y: 0.3, w: 140, h: 80 },
          ] } },
        { id: 'm5', name: 'Reed Hunters', mode: 'hardcore', sizes: [4, 4], allies: [3], foes: [3, 4], tier: 5, reward: 1350,
          twists: { fog: true },
          brief: 'Fog, reeds and hedges, and no respawns. Listen for engines.',
          stars: [{ t: 'flawless' }, { t: 'kills', n: 4 }],
          map: { density: 0.06, kinds: { tree: 0.4, rock: 0.2, hedge: 0.4 }, features: [
            { t: 'wreck', x: 0.42, y: 0.4 }, { t: 'pond', x: 0.5, y: 0.5, r: 90, c: 1 },
          ] } },
        { id: 'm6', name: 'The Bog Baron', mode: 'hardcore', sizes: [4, 5], allies: [3, 3, 4], foes: [3, 4], tier: 5, rules: { limit: 2 }, reward: 1500, boss: true,
          twists: { ace: { name: 'Bog Baron', skill: 4, hp: 1.6, dmg: 1.1, loadout: { hull: 'big', tires: 'quad', weapon: 'mg', special: 'mine' } } },
          brief: 'The Baron\'s heavy quad-track tank ploughs through bog water that slows everyone else. No respawns: keep him out of the pools and win two rounds.',
          stars: [{ t: 'ace' }, { t: 'deaths', n: 1 }],
          map: { density: 0.05, noPools: 1, features: [
            { t: 'pond', x: 0.36, y: 0.3, r: 120 }, { t: 'pond', x: 0.4, y: 0.66, r: 130 }, { t: 'pond', x: 0.5, y: 0.5, r: 120, c: 1 }, { t: 'pond', x: 0.27, y: 0.5, r: 90 },
            { t: 'grove', x: 0.44, y: 0.15, r: 80, n: 2 }, { t: 'wreck', x: 0.32, y: 0.82 },
          ] } },
      ],
    },
    {
      id: 'dunes', biome: 'desert', name: 'Dune Sea', blurb: 'Open sand, scattered ruins and the oases between them.',
      levels: [
        { id: 'd1', name: 'Oasis', mode: 'koth', sizes: [4, 4], allies: [3, 4], foes: [3, 4], tier: 5, rules: { limit: 40, time: 420 }, reward: 1400,
          brief: 'Whoever holds the ground between the two oases holds the desert. Fight for it among the palms.',
          stars: [{ t: 'margin', n: 10 }, { t: 'deaths', n: 3 }],
          map: { density: 0.06, features: [
            { t: 'pond', x: 0.5, y: 0.26, r: 100 }, { t: 'grove', x: 0.43, y: 0.22, r: 60, n: 2 }, { t: 'grove', x: 0.57, y: 0.19, r: 50, n: 1 },
            { t: 'bld', k: 'house', x: 0.36, y: 0.4, w: 100, h: 70 }, { t: 'rocks', x: 0.3, y: 0.72, r: 70, n: 2 },
          ] } },
        { id: 'd2', name: 'Sandstorm', mode: 'tdm', sizes: [4, 4], allies: [3, 4], foes: [4], tier: 5, rules: { limit: 16, time: 420 }, reward: 1450,
          twists: { sandstorm: true },
          brief: 'A storm blots out the sun over the ruins. Fight by the glow of muzzle flashes.',
          stars: [{ t: 'deaths', n: 2 }, { t: 'kills', n: 5 }],
          map: { density: 0.07, kinds: { rock: 0.35, building: 0.2, barrier: 0.2, crates: 0.1, tree: 0.15 }, features: [
            { t: 'bld', k: 'building', x: 0.42, y: 0.3, w: 140, h: 100 }, { t: 'line', k: 'barrier', x: 0.36, y: 0.6, len: 200 },
            { t: 'wreck', x: 0.5, y: 0.5, c: 1 }, { t: 'ridge', x1: 0.28, y1: 0.4, x2: 0.3, y2: 0.55 },
          ] } },
        { id: 'd3', name: 'Pipeline', mode: 'escort', sizes: [4, 4], allies: [3, 4], foes: [3, 4], tier: 5, reward: 1500,
          twists: { barrage: true },
          brief: 'Follow the road along the pipeline to the pumping station. Their mortars are ranged on it.',
          stars: [{ t: 'convoyFast', n: 110 }, { t: 'convoySafe' }],
          map: { density: 0.05, features: [
            { t: 'road', convoy: true, c: 1, pts: [[0.07, 0.5], [0.3, 0.56], [0.5, 0.5], [0.7, 0.44], [0.93, 0.5]] },
            { t: 'line', k: 'pipe', x: 0.36, y: 0.42, len: 500 }, { t: 'line', k: 'pipe', x: 0.3, y: 0.68, len: 380 },
            { t: 'bld', k: 'bunker', x: 0.46, y: 0.28, w: 70, h: 60 }, { t: 'rocks', x: 0.26, y: 0.22, r: 80, n: 2 },
          ] } },
        { id: 'd4', name: 'Dune Royale', mode: 'br', size: 10, foes: [3, 4], tier: 5, reward: 1550,
          brief: 'Ten crews in a ruined desert town by an oasis. The zone closes on the square.',
          stars: [{ t: 'kills', n: 4 }, { t: 'damage', n: 900 }],
          map: { density: 0.08, kinds: { rock: 0.3, building: 0.25, barrier: 0.2, crates: 0.15, tree: 0.1 }, features: [
            { t: 'village', x: 0.5, y: 0.5, r: 260, n: 7 }, { t: 'pond', x: 0.24, y: 0.74, r: 100 }, { t: 'grove', x: 0.25, y: 0.62, r: 90, n: 2 },
            { t: 'line', k: 'pipe', x: 0.72, y: 0.3, len: 420 },
          ] } },
        { id: 'd5', name: 'Mirage', mode: 'oneshot', sizes: [4, 4], allies: [3, 4], foes: [4], tier: 5, rules: { limit: 20, time: 330 }, reward: 1600,
          brief: 'Heat haze over open sand and no heavy armor. Every shot you land ends a tank.',
          stars: [{ t: 'kills', n: 6 }, { t: 'deaths', n: 3 }],
          map: { density: 0.05, kinds: { rock: 0.7, tree: 0.3 }, features: [
            { t: 'rocks', x: 0.36, y: 0.3, r: 90, n: 3 }, { t: 'rocks', x: 0.42, y: 0.7, r: 90, n: 3 }, { t: 'wreck', x: 0.5, y: 0.5, c: 1 },
          ] } },
        { id: 'd6', name: 'The Sand Viper', mode: 'hardcore', sizes: [4, 4], allies: [3, 4], foes: [4], tier: 5, rules: { limit: 2 }, reward: 1800, boss: true,
          twists: { ace: { name: 'Sand Viper', skill: 4, hp: 1.6, dmg: 1.1, loadout: { hull: 'feather', tires: 'rover', weapon: 'longgun', special: 'overdrive' } } },
          brief: 'A fast sniper ace leads their walled outpost. No respawns: one mistake and you watch the rest.',
          stars: [{ t: 'ace' }, { t: 'flawless' }],
          map: { density: 0.05, features: [
            { t: 'line', k: 'barrier', x: 0.34, y: 0.4, len: 220, v: 1 }, { t: 'line', k: 'barrier', x: 0.34, y: 0.72, len: 160, v: 1 },
            { t: 'bld', k: 'bunker', x: 0.42, y: 0.5, w: 76, h: 66 }, { t: 'line', k: 'sandbags', x: 0.46, y: 0.24, len: 200 },
            { t: 'rocks', x: 0.5, y: 0.5, r: 20, n: 1, c: 1 },
          ] } },
      ],
    },
    {
      id: 'scar', biome: 'badlands', name: 'Red Scar', blurb: 'Canyons and mesas. The last stand of their army.',
      levels: [
        { id: 'r1', name: 'Canyon Run', mode: 'ctf', sizes: [4, 4], allies: [4], foes: [4], tier: 6, rules: { limit: 2, time: 480 }, reward: 1700,
          brief: 'Three canyons run between the bases, split by walls of red rock. Pick one and push.',
          stars: [{ t: 'caps', n: 1 }, { t: 'deaths', n: 3 }],
          map: { density: 0.03, kinds: { rock: 0.8, tree: 0.2 }, features: [
            { t: 'ridge', x1: 0.26, y1: 0.36, x2: 0.5, y2: 0.36, step: 60, gaps: [0.35], rmin: 34, rmax: 46 },
            { t: 'ridge', x1: 0.26, y1: 0.64, x2: 0.5, y2: 0.64, step: 60, gaps: [0.7], rmin: 34, rmax: 46 },
          ] } },
        { id: 'r2', name: 'Dust Devils', mode: 'tdm', sizes: [10, 10], allies: [3, 4], foes: [3, 4, 4], tier: 6, rules: { limit: 40, time: 540 }, reward: 1800,
          brief: 'Every tank they have left, spread among the mesas.',
          stars: [{ t: 'kills', n: 8 }, { t: 'mvp' }],
          map: { density: 0.07, kinds: { rock: 0.6, tree: 0.2, crates: 0.1, barrier: 0.1 }, features: [
            { t: 'rocks', x: 0.36, y: 0.3, r: 120, n: 4 }, { t: 'rocks', x: 0.42, y: 0.7, r: 120, n: 4 }, { t: 'wreck', x: 0.3, y: 0.5 }, { t: 'wreck', x: 0.5, y: 0.5, c: 1 },
          ] } },
        { id: 'r3', name: 'Iron Convoy', mode: 'escort', sizes: [4, 4], allies: [4], foes: [4], tier: 6, reward: 1900,
          twists: { minefield: 14 },
          brief: 'The canyon road is mined and watched from the rim. Get the convoy through; stop theirs.',
          stars: [{ t: 'convoyKill' }, { t: 'convoySafe' }],
          map: { density: 0.04, features: [
            { t: 'road', convoy: true, c: 1, pts: [[0.07, 0.5], [0.3, 0.44], [0.5, 0.5], [0.7, 0.56], [0.93, 0.5]] },
            { t: 'ridge', x1: 0.24, y1: 0.3, x2: 0.5, y2: 0.34, step: 65, gaps: [0.5] }, { t: 'ridge', x1: 0.24, y1: 0.66, x2: 0.46, y2: 0.7, step: 65, gaps: [0.4] },
          ] } },
        { id: 'r4', name: 'The Mesa', mode: 'koth', sizes: [4, 4], allies: [4], foes: [3, 3, 3, 4], tier: 6, allyTier: 6, rules: { limit: 40, time: 480 }, reward: 2000,
          brief: 'A ring of rock around the summit, four ways in, and their best crews dug in on top.',
          stars: [{ t: 'margin', n: 10 }, { t: 'deaths', n: 3 }],
          map: { density: 0.04, features: [
            { t: 'ridge', x1: 0.45, y1: 0.25, x2: 0.39, y2: 0.42, step: 60 }, { t: 'ridge', x1: 0.39, y1: 0.58, x2: 0.45, y2: 0.75, step: 60 },
            { t: 'wreck', x: 0.3, y: 0.3 }, { t: 'rocks', x: 0.28, y: 0.72, r: 80, n: 2 },
          ] } },
        { id: 'r5', name: 'Last Stand', mode: 'hardcore', sizes: [4, 4], allies: [4], foes: [4], tier: 6, reward: 2100,
          twists: { noRegen: true, enemyHull: 'era' },
          brief: 'Their line wears reactive armor, and no one repairs out here. Win three rounds across the trenches.',
          stars: [{ t: 'flawless' }, { t: 'mvp' }],
          map: { density: 0.05, features: [
            { t: 'line', k: 'sandbags', x: 0.32, y: 0.34, len: 220, v: 1 }, { t: 'line', k: 'sandbags', x: 0.32, y: 0.7, len: 180, v: 1 },
            { t: 'line', k: 'sandbags', x: 0.42, y: 0.5, len: 260, v: 1 }, { t: 'wreck', x: 0.46, y: 0.22 }, { t: 'wreck', x: 0.38, y: 0.84 },
            { t: 'scorch', x: 0.5, y: 0.5, r: 120, c: 1 },
          ] } },
        { id: 'r6', name: 'The Red Colossus', mode: 'hardcore', sizes: [4, 4], allies: [4], foes: [3, 4], tier: 6, rules: { limit: 2 }, reward: 2500, boss: true,
          twists: { ace: { name: 'Red Colossus', skill: 4, hp: 1.8, dmg: 1.25, scale: 1.35, loadout: { hull: 'big', weapon: 'double', tires: 'quad', special: 'artillery' } } },
          brief: 'Their last and biggest tank: a colossus with twin guns and its own artillery, in a ring of red rock. No respawns: bring it down twice.',
          stars: [{ t: 'ace' }, { t: 'flawless' }],
          map: { density: 0.03, features: [
            { t: 'ridge', x1: 0.3, y1: 0.2, x2: 0.46, y2: 0.14 }, { t: 'ridge', x1: 0.28, y1: 0.8, x2: 0.44, y2: 0.86 },
            { t: 'wreck', x: 0.4, y: 0.4 }, { t: 'wreck', x: 0.36, y: 0.62 }, { t: 'scorch', x: 0.5, y: 0.5, r: 160, c: 1 },
            { t: 'line', k: 'barrier', x: 0.44, y: 0.5, len: 160, v: 1 },
          ] } },
      ],
    },
  ],
};

// Filler props per region for campaign maps (no shipping containers in the orchards).
const REGION_KINDS = {
  grassland: { tree: 0.3, rock: 0.15, hedge: 0.2, house: 0.1, crates: 0.1, sandbags: 0.15 },
  cherry: { tree: 0.45, rock: 0.2, hedge: 0.15, house: 0.08, sandbags: 0.12 },
  autumn: { tree: 0.5, rock: 0.2, house: 0.08, sandbags: 0.12, crates: 0.1 },
  snow: { tree: 0.35, rock: 0.2, sandbags: 0.15, barrier: 0.1, container: 0.1, building: 0.1 },
  marsh: { tree: 0.35, rock: 0.15, hedge: 0.2, house: 0.1, sandbags: 0.1, wreck: 0.1 },
  desert: { rock: 0.35, building: 0.15, barrier: 0.15, sandbags: 0.15, crates: 0.1, container: 0.1 },
  badlands: { rock: 0.5, tree: 0.15, barrier: 0.1, sandbags: 0.1, crates: 0.1, wreck: 0.05 },
};

// Every playable mission in order, with its region.
const CAMPAIGN_LEVELS = [];
CAMPAIGN.regions.forEach((r, ri) => r.levels.forEach((l, li) => CAMPAIGN_LEVELS.push(Object.assign(l, { region: ri, index: li, order: CAMPAIGN_LEVELS.length }))));
const CAMPAIGN_MAX_STARS = CAMPAIGN_LEVELS.length * 3;

const TWIST_INFO = {
  night: { name: 'Night', desc: 'Darkness: you only see what your lights reach.' },
  fog: { name: 'Fog', desc: 'Thick fog: tanks appear only at close range.' },
  sandstorm: { name: 'Sandstorm', desc: 'Blowing sand cuts visibility for everyone.' },
  noRegen: { name: 'No repairs', desc: 'Supply lines are cut: no field repairs.' },
  minefield: { name: 'Minefield', desc: 'Neutral mines are buried across the middle of the map.' },
  ace: { name: 'Enemy Ace', desc: 'A named veteran with heavy armor and a signature build.' },
  barrage: { name: 'Barrage', desc: 'Every enemy tank carries artillery.' },
  enemyHull: { name: 'Heavy armor', desc: 'The enemy line drives Big Hulls.' },
  enemyRespawn: { name: 'Reinforcements', desc: 'Destroyed enemies come back faster.' },
  outnumbered: { name: 'Outnumbered', desc: 'They have more tanks than you.' },
};

// Bot build for a mission tech tier: higher tiers field more non-standard
// parts (pricier ones too) and more hangar upgrades.
function campaignBotLoadout(rng, tier) {
  const L = Object.assign({}, DEFAULT_LOADOUT);
  const p = clamp(tier * 0.2, 0, 0.85);
  const budget = 700 + tier * 300;
  for (const slot of SLOTS) {
    if (!rng.chance(p)) continue;
    const opts = Object.keys(PARTS[slot]).filter(id => id !== DEFAULT_LOADOUT[slot] && PARTS[slot][id].price <= budget);
    if (opts.length) L[slot] = rng.pick(opts);
  }
  const lv = k => clamp(Math.round(tier * k + rng.float(-0.45, 0.45)), 0, UPGRADES.max);
  L.up = { hp: 1 + UPGRADES.hp * lv(1), dmg: 1 + UPGRADES.dmg * lv(0.8) };
  return L;
}

// ---- pilot saves ---------------------------------------------------------------------------
// Each pilot is one campaign: money, stars, hangar. An index lists them and
// remembers which one is active; every pilot lives in its own storage key.
const CAMPAIGN_KEY = 'ironclad.campaign.v1';              // single save from the first version
const CAMPAIGN_INDEX_KEY = 'ironclad.campaign.index.v2';
const slotKey = id => 'ironclad.campaign.slot.' + id;
const MAX_PILOTS = 5;
const PILOT_MAX_LEN = 14;

function storeGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
function storeDel(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }

function cleanName(name, fallback) {
  const s = String(name || '').replace(/[\x00-\x1f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, PILOT_MAX_LEN);
  return s || fallback;
}

function newCampaignSave(pilot) {
  const owned = {};
  for (const slot of SLOTS) owned[slot] = [DEFAULT_LOADOUT[slot]];
  return { v: 2, id: null, pilot: pilot || 'Pilot', money: 0, stars: {}, owned, equip: Object.assign({}, DEFAULT_LOADOUT), armor: 0, gun: 0, seen: 0, updated: 0 };
}

// Fill in anything missing (older saves, parts that no longer exist).
function normalizeSave(s, base) {
  const out = Object.assign(base || newCampaignSave(), s);
  out.owned = Object.assign({}, out.owned);
  for (const slot of SLOTS) {
    out.owned[slot] = (out.owned[slot] || []).filter(id => PARTS[slot][id]);
    if (!out.owned[slot].includes(DEFAULT_LOADOUT[slot])) out.owned[slot].unshift(DEFAULT_LOADOUT[slot]);
    if (!PARTS[slot][out.equip[slot]] || !out.owned[slot].includes(out.equip[slot])) out.equip[slot] = DEFAULT_LOADOUT[slot];
  }
  return out;
}

function newPilotId() { return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

function campaignIndex() {
  let idx = storeGet(CAMPAIGN_INDEX_KEY);
  if (idx && Array.isArray(idx.pilots)) return idx;
  idx = { active: null, pilots: [] };
  // Carry the original single save over as the first pilot.
  const old = storeGet(CAMPAIGN_KEY);
  if (old && typeof old === 'object') {
    const s = normalizeSave(old);
    s.id = newPilotId();
    s.pilot = 'Pilot 1';
    storeSet(slotKey(s.id), s);
    idx.pilots.push(s.id);
    idx.active = s.id;
  }
  storeSet(CAMPAIGN_INDEX_KEY, idx);
  return idx;
}

function loadPilot(id) {
  const s = storeGet(slotKey(id));
  return s && typeof s === 'object' ? normalizeSave(s, Object.assign(newCampaignSave(), { id })) : null;
}

function listPilots() {
  return campaignIndex().pilots.map(loadPilot).filter(Boolean);
}

// The active pilot (a first one is created on demand).
function loadCampaign(defaultPilot) {
  const idx = campaignIndex();
  const s = idx.active && loadPilot(idx.active);
  return s || createPilot(defaultPilot || 'Pilot 1');
}

function createPilot(name) {
  const idx = campaignIndex();
  const s = newCampaignSave(cleanName(name, 'Pilot ' + (idx.pilots.length + 1)));
  s.id = newPilotId();
  s.updated = Date.now();
  storeSet(slotKey(s.id), s);
  idx.pilots.push(s.id);
  idx.active = s.id;
  storeSet(CAMPAIGN_INDEX_KEY, idx);
  return s;
}

function setActivePilot(id) {
  const idx = campaignIndex();
  if (!idx.pilots.includes(id)) return null;
  idx.active = id;
  storeSet(CAMPAIGN_INDEX_KEY, idx);
  return loadPilot(id);
}

// Start this pilot's campaign over: progress, money and hangar are wiped.
function resetPilot(id) {
  const s = loadPilot(id);
  if (!s) return null;
  const fresh = Object.assign(newCampaignSave(s.pilot), { id, updated: Date.now() });
  storeSet(slotKey(id), fresh);
  return fresh;
}

function deletePilot(id) {
  const idx = campaignIndex();
  idx.pilots = idx.pilots.filter(p => p !== id);
  if (idx.active === id) idx.active = idx.pilots[0] || null;
  storeDel(slotKey(id));
  storeSet(CAMPAIGN_INDEX_KEY, idx);
}

function renamePilot(save, name) {
  save.pilot = cleanName(name, save.pilot);
  saveCampaign(save);
}

function saveCampaign(save) {
  if (!save.id) return;
  save.updated = Date.now();
  storeSet(slotKey(save.id), save);
}

const levelStars = (save, id) => save.stars[id] || [false, false, false];
const starCount = flags => flags.reduce((n, b) => n + (b ? 1 : 0), 0);
function totalStars(save) { return CAMPAIGN_LEVELS.reduce((n, l) => n + starCount(levelStars(save, l.id)), 0); }
function missionsDone(save) { return CAMPAIGN_LEVELS.filter(l => levelStars(save, l.id)[0]).length; }

// A mission unlocks once the one before it has been won.
function levelUnlocked(save, order) {
  return order === 0 || (order < CAMPAIGN_LEVELS.length && levelStars(save, CAMPAIGN_LEVELS[order - 1].id)[0]);
}
// The furthest unlocked mission (the "you are here" marker).
function frontierLevel(save) {
  let i = 0;
  while (i + 1 < CAMPAIGN_LEVELS.length && levelUnlocked(save, i + 1)) i++;
  return i;
}

function upgradeCost(level) { return level < UPGRADES.max ? UPGRADES.cost[level] : Infinity; }

// ---- missions ------------------------------------------------------------------------------
// A stable seed per mission, so its map (and opening moves) are always the same.
function missionSeed(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 1e9;
}

function missionSettings(level, save, extra) {
  const region = CAMPAIGN.regions[level.region];
  const teams = MODES[level.mode].teams;
  return Object.assign({
    mode: level.mode,
    size: teams ? Math.max(level.sizes[0], level.sizes[1]) : level.size,
    teamSizes: teams ? level.sizes.slice() : null,
    difficulty: 'normal',
    biome: region.biome,
    seed: missionSeed(level.id),
    recipe: level.map ? Object.assign({ kinds: REGION_KINDS[region.biome] }, level.map) : null,
    players: 1, versus: false, hits: HITS.default,
    progression: 'campaign',
    playerName: save.pilot || 'You',
    loadout: Object.assign({}, save.equip),
    playerUp: { hp: 1 + UPGRADES.hp * save.armor, dmg: 1 + UPGRADES.dmg * save.gun },
    skills: { ally: level.allies || [2], enemy: level.foes },
    botTier: { ally: level.allyTier !== undefined ? level.allyTier : Math.max(0, level.tier - 1), enemy: level.tier },
    twists: level.twists || {},
    rules: level.rules || null,
    mission: level.id,
  }, extra || {});
}

function missionTwists(level) {
  const tw = level.twists || {};
  const out = Object.keys(tw).map(k => {
    const info = Object.assign({ id: k }, TWIST_INFO[k]);
    if (k === 'enemyHull') info.desc = `The enemy line drives ${PARTS.hull[tw.enemyHull].name}.`;
    return info;
  });
  if (level.sizes && level.sizes[1] > level.sizes[0]) out.unshift(Object.assign({ id: 'outnumbered' }, TWIST_INFO.outnumbered));
  return out;
}

function condText(c) {
  const s = n => (n === 1 ? '' : 's');
  switch (c.t) {
    case 'deaths': return c.n === 0 ? 'Finish without being destroyed' : `Get destroyed ${c.n} time${s(c.n)} at most`;
    case 'time': return `Win within ${fmtTime(c.n)}`;
    case 'kills': return `Destroy ${c.n} enemy tank${s(c.n)}`;
    case 'damage': return `Deal ${c.n} damage`;
    case 'mvp': return 'Finish as lobby MVP';
    case 'margin': return `Win by ${c.n} points or more`;
    case 'caps': return `Capture ${c.n} flag${s(c.n)} yourself`;
    case 'ace': return 'Destroy the enemy Ace';
    case 'flawless': return 'Win without losing a round';
    case 'convoyKill': return 'Destroy the enemy convoy';
    case 'convoySafe': return 'Get your convoy to extraction';
    case 'convoyFast': return `Destroy their convoy within ${fmtTime(c.n)}`;
    case 'points': return `Score ${c.n} points`;
  }
  return '';
}

function missionWon(game) {
  const p = game.players[0];
  if (!p) return false;
  if (game.settings.mode === 'jug') return (game.winnerTank || game.mode.ranking()[0]) === p;
  return game.winner === p.team;
}

function condMet(c, game) {
  const p = game.players[0], st = p.stats;
  const other = game.def.teams ? game.teams[1 - p.team] : null, mine = game.def.teams ? game.teams[p.team] : null;
  const results = game.mode.results || [];
  switch (c.t) {
    case 'deaths': return st.deaths <= c.n;
    case 'time': return game.liveTime <= c.n;
    case 'kills': return st.kills >= c.n;
    case 'damage': return st.damage >= c.n;
    case 'mvp': {
      const top = game.tanks.filter(t => !t.isConvoy).sort((a, b) => b.stats.xp - a.stats.xp || b.stats.kills - a.stats.kills)[0];
      return top === p;
    }
    case 'margin': return Math.floor(mine.score) - Math.floor(other.score) >= c.n;
    case 'caps': return st.caps >= c.n;
    case 'ace': return game.aceKills > 0;
    case 'flawless': return Math.floor(other.score) === 0;
    case 'convoyKill': return results.some(r => r.attackers === p.team && r.destroyed);
    case 'convoySafe': return results.some(r => r.attackers !== p.team && !r.destroyed);
    case 'convoyFast': return results.some(r => r.attackers === p.team && r.destroyed && r.time <= c.n);
    case 'points': return p.score >= c.n;
  }
  return false;
}

// Stars earned this attempt: the first for winning, the others for mastery
// conditions (which only count on a win).
function evaluateMission(game, level) {
  const won = missionWon(game);
  const conds = [{ text: 'Win the mission', ok: won }].concat(level.stars.map(c => ({ text: condText(c), ok: won && condMet(c, game), raw: condMet(c, game) })));
  return { won, flags: conds.map(c => c.ok), conds };
}

// Pays out and records stars. Stars add up across attempts; the full reward
// comes with the first win, replays pay a share, and a loss still pays salvage.
function applyMissionResult(save, level, ev) {
  const prev = levelStars(save, level.id);
  const now = prev.map((b, i) => b || ev.flags[i]);
  const lines = [];
  if (ev.won) lines.push(prev[0] ? ['Mission reward (replay)', Math.round(level.reward * 0.35)] : ['Mission reward', level.reward]);
  else lines.push(['Salvage', Math.round(level.reward * 0.15)]);
  for (let i = 1; i < 3; i++) if (now[i] && !prev[i]) lines.push([`Star bonus: ${condText(level.stars[i - 1])}`, Math.round(level.reward * 0.5)]);
  const total = lines.reduce((n, l) => n + l[1], 0);
  save.money += total;
  save.stars[level.id] = now;
  saveCampaign(save);
  return { lines, total, newStars: starCount(now) - starCount(prev), stars: now };
}

function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
