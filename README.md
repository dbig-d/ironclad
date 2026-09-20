# Ironclad

A top-down WWII-era tank game that runs in the browser. No engine, no build step: plain HTML, CSS and JavaScript on a canvas.

**Play it: https://dbig-d.github.io/ironclad/**

## What's in it

- **Skirmish** — one player, or two on one screen. Nine modes: team deathmatch, king of the hill, capture the flag, one shot, escort, hardcore, battle royale (up to 40 tanks), juggernaut and free-for-all sizes from 1v1 to 10v10.
- **Campaign** — "The Iron Road": 42 missions across seven regions on a connected world map, with money, stars, five pilot saves and a hangar for buying and fitting parts.
- **43 tank parts** — weapons, hulls, running gear and specials, from a plain cannon to wire-guided missiles, airstrikes and bouncing grenades.
- **Online** — host a room, share the five-character code, and up to four tanks play together from any mix of phones and computers. The host runs the battle; everyone else sends their controls and sees it play out. Direct peer-to-peer where the network allows it, otherwise relayed.
- **Progression** — standard, in-match leveling, freeplay loadouts, or the campaign hangar.
- Procedurally built battlefields in seven biomes, with weather, night missions, fog and sandstorms.

## Controls

**Keyboard and mouse**

| | |
|---|---|
| W / S | Drive |
| A / D | Turn the hull |
| Mouse | Aim the turret |
| Click or Space | Fire |
| Right-click | Use your special |
| R | Autofire on / off |
| 1 / 2 / 3 | Pick an upgrade (leveling) |
| Tab | Scoreboard |
| Esc / M | Pause · mute |

**Two players on one keyboard** — player 1 drives with WASD and fires with Left Shift; player 2 uses the arrow keys and Space.

**Touch** — twin sticks: the left thumb drives, the right aims and fires, with buttons for the special, autofire, scoreboard and pause.

## Running it locally

Any static file server works, for example:

```sh
npx serve .
# or
python -m http.server 8000
```

Then open the address it prints. Opening `index.html` directly from disk also works, since the game uses classic scripts rather than modules.

## Layout

```
index.html        markup for every screen
css/style.css     all styling
js/
  util.js         maths, RNG, colour and canvas helpers
  config.js       tunable game rules and biome definitions
  parts.js        tank parts and their stats
  campaign.js     campaign levels, pilot saves, progression
  map.js          procedural map generation, collision, pathfinding
  tank.js         tank physics, shells, missiles
  ai.js           bot brains
  modes.js        game modes
  game.js         the simulation (no DOM, fixed 60 Hz steps)
  art.js          procedural sprite art
  terrain.js      terrain painting, tracks, scorch marks
  fx.js           particles, damage numbers, wrecks
  hud.js          in-match HUD and minimap
  render.js       world renderer and camera
  worldmap.js     campaign world map and hangar turntable
  audio.js        synthesized sound effects
  input.js        keyboard, mouse and touch input
  ui.js           menus, screens, overlays
  main.js         bootstrap and main loop
```

The simulation in `game.js` is deliberately free of DOM and rendering: it advances in fixed 60 Hz steps from each tank's inputs and emits events that the effects, audio and UI layers consume.

## Licence

CC0 1.0 Universal — see [LICENSE](LICENSE).
