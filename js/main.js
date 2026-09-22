'use strict';
// ---------------------------------------------------------------------------
// App bootstrap and main loop.
// ---------------------------------------------------------------------------

const App = {
  init() {
    this.canvas = $('game');
    this.renderer = new Renderer(this.canvas);
    this.input = new Input(this.canvas);
    this.sfx = new Sfx();
    this.ui = new UI(this);
    this.net = new Net(this);
    this.sfx.setVolume(this.ui.settings.volume);
    this.setFpsCap(this.ui.settings.fpsCap);
    this.paused = false;
    this.locks = [null, null];
    this.spectate = [null, null];
    this.autofire = [false, false]; // per player, kept between matches
    this.toTitle();

    window.addEventListener('resize', () => {
      this.renderer.resize();
      if (this.state === 'campaign' && this.ui.world) { this.ui.world.resize(); this.ui.world.focus(this.ui.world.sel, true); }
      if (this.state === 'hangar' && this.ui.preview) this.ui.preview.resize();
    });
    const unlock = () => this.sfx.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('touchend', unlock);
    window.addEventListener('keydown', unlock);
    this.input.setupTouch($('touch'));
    $('t-pause').addEventListener('click', () => this.setPaused(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing' && this.game.phase !== 'over') this.setPaused(true);
    });
    this.last = performance.now();
    requestAnimationFrame(t => this.loop(t));
  },

  startDemo() {
    this.state = 'menu';
    this.game = new Game({ mode: randPick(['tdm', 'koth', 'ctf']), size: 4, difficulty: 'mixed', biome: randPick(BIOME_IDS), demo: true });
    this.renderer.setGame(this.game, []);
    this.demoFocus = null;
    this.demoT = 0;
  },

  // Deploy from the menu (or restart): a campaign mission replays itself;
  // choosing Campaign in the menu opens the world map instead.
  startMatch() {
    if (this.net.active) return this.backToLobby();
    if (this.mission) return this.startMission(this.mission);
    if (this.ui.settings.progression === 'campaign') return this.openCampaign();
    this.launch(this.ui.matchSettings());
  },

  startMission(level) {
    this.mission = level;
    this.launch(missionSettings(level, this.ui.cp, { steering: this.ui.settings.steering }));
  },

  openCampaign() {
    this.mission = null;
    this.paused = false;
    this.state = 'campaign';
    this.ui.showCampaign();
  },

  openHangar() {
    this.state = 'hangar';
    this.ui.showHangar();
  },

  launch(s) {
    this.sfx.unlock();
    // Drop focus from the menu button so Space/Enter don't re-trigger it.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.steering = s.steering;
    this.game = new Game(s);
    this.renderer.setGame(this.game, this.game.players);
    // Sprites this battle will need, built through the countdown rather than
    // during the first firefight.
    this.warmJobs = TankArt.warmJobs(this.game);
    this.state = 'playing';
    this.paused = false;
    this.locks = [null, null];
    this.spectate = [null, null];
    this.endShown = false;
    this.ui.showHud(this.game);
  },

  // ---- online ----------------------------------------------------------------------------
  // Host and joiners build the same world from the same settings and seed; only
  // the moving parts travel over the wire.
  startOnline(settings, role) {
    this.sfx.unlock();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.mission = null;
    this.steering = this.ui.settings.steering;
    const g = this.game = new Game(settings);
    const slots = settings.netSlots;
    const mySlot = Math.max(0, slots.findIndex(sl => sl.id === this.net.me));
    const mine = g.players[mySlot] || g.players[0];
    g.locals = [mine];
    if (role === 'host') {
      for (const p of this.net.peers.values()) {
        const k = slots.findIndex(sl => sl.id === p.id);
        p.tank = k >= 0 ? g.players[k] : null;
        p.lastSeq = -1;
      }
    }
    this.renderer.setGame(g, [mine]);
    this.state = 'playing';
    this.paused = false;
    this.locks = [null, null];
    this.spectate = [null, null];
    this.endShown = false;
    this.ui.showHud(g);
  },

  // A joiner's own tank runs the same movement code locally, then eases back
  // toward the host's version whenever a snapshot lands (see Net.reconcile).
  predictLocal(dt, t, g, canDrive) {
    if (!t || !t.alive || !canDrive) return;
    const tire = PARTS.tires[t.loadout.tires];
    t.surfaceMul = g.map.onWater(t.x, t.y) ? tire.water : g.map.onRoad(t.x, t.y) ? tire.road : tire.off;
    t.move(dt);
    g.map.resolveCircle(t, t.radius);
    t.settle(dt);
  },

  // Upgrade choices are the host's to apply; a joiner asks for one.
  pickOffer(p, k) {
    if (this.net.isClient) this.net.everyPeer({ t: 'pick', k });
    this.game.pickOffer(p, k);
  },

  onlinePlayerLeft(peer) {
    if (peer.tank) {
      // Hand the empty seat to the computer so the match can finish.
      peer.tank.brain = peer.tank.brain || new BotBrain(peer.tank, SKILLS[2], (Math.random() * 1e9) | 0);
      this.ui.announce(peer.name + ' left', 'a crew took over', '#ffb347');
    }
  },

  onlineMatchOver(m) { /* the snapshot already carries the result */ },

  onlineEnded(reason) {
    this.net.leave(true);
    this.toTitle();
    this.ui.showOnline();
    this.ui.toast(reason);
  },

  // Back to the room between matches: the host can set up the next one.
  backToLobby(fromHost) {
    if (!this.net.active) return this.toTitle();
    this.net.state = 'lobby';
    this.net.snapBuf.length = 0;
    if (this.net.isHost && !fromHost) this.net.sendLobby();
    this.paused = false;
    this.endShown = false;
    this.ui.showOnline();
    this.startDemo();
    this.state = 'online';
  },

  toOnline() {
    this.mission = null;
    this.paused = false;
    this.ui.showOnline();
    if (!this.game || this.state === 'playing') this.startDemo();
    this.state = 'online';
  },

  leaveOnline() {
    this.net.leave();
    this.toTitle();
  },

  // The title screen: the way into skirmish, campaign or online.
  toTitle() {
    if (this.net.active) this.net.leave();
    this.mission = null;
    this.paused = false;
    this.ui.showTitle();
    this.startDemo();
    this.state = 'title';
  },

  toMenu() {
    if (this.net.active) return this.leaveOnline();
    this.mission = null;
    this.paused = false;
    // The campaign has its own way in from the title screen.
    if (this.ui.settings.progression === 'campaign') { this.ui.settings.progression = 'standard'; this.ui.save(); }
    this.ui.showMenu();
    this.startDemo();
  },

  setPaused(p) {
    if (this.state !== 'playing' || this.endShown) return;
    // Online, one player's menu can't stop everyone else's battle.
    if (this.net.active && p) { this.ui.toast('The battle keeps running while you are in here.'); }
    this.paused = p;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.ui.showPause(p);
  },

  // Draw no faster than the game needs. A 120 Hz screen gets the same battle
  // for half the work, which is the difference between a warm laptop and a loud
  // one; the menus idle slower still, since nothing there is being played.
  setFpsCap(fps) {
    this.frameInterval = fps > 0 ? 1000 / fps : 0;
    this.nextFrame = 0;
  },

  loop(now) {
    requestAnimationFrame(t => this.loop(t));
    // Keep to the chosen rate on a fixed cadence: aiming at slots rather than
    // measuring gaps means a 120 Hz screen lands on an even half instead of
    // stuttering between skipped and drawn frames. Menus idle slower still.
    const idle = this.state !== 'playing' || this.paused;
    const interval = idle ? Math.max(this.frameInterval || 0, 33.3) : this.frameInterval || 0;
    if (interval) {
      if (now < this.nextFrame) return;
      this.nextFrame = Math.max(now + 1, this.nextFrame + interval);
    }
    const raw = now - this.last;
    const dt = Math.min(0.05, raw / 1000);
    this.last = now;
    if (dt <= 0) return;
    if (this.state === 'playing' && !this.paused) this.govern(raw);
    try {
      this.frame(dt);
    } catch (err) {
      console.error(err);
    }
    this.input.endFrame();
  },

  // Frame-rate governor: when frames run long, step down render resolution and
  // effects; when there's headroom for a while, step back up. Each fallback makes
  // the next step up wait longer so it can't flip-flop.
  govern(ms) {
    const P = this.perf || (this.perf = { ema: 16.7, low: 0, high: 0, wait: 8000, drops: 0 });
    if (ms > 250) return;  // tab switch or a hitch, not a trend
    // Judge frames against the rate we asked for, not always 60: a 30 fps cap
    // is a choice, not a struggling machine.
    const target = this.frameInterval || 16.7;
    P.ema += (ms - P.ema) * 0.06;
    if (P.ema > target * 1.29) { P.low += ms; P.high = 0; }
    else if (P.ema < target * 1.07) { P.high += ms; P.low = 0; }
    else { P.low = 0; P.high = 0; }
    if (P.low > 1500) {
      P.low = 0;
      if (this.renderer.setQuality(-1)) { P.drops++; P.wait = 8000 * Math.pow(2, P.drops); P.ema = target; }
    } else if (P.high > P.wait) {
      P.high = 0;
      this.renderer.setQuality(1);
    }
  },

  frame(dt) {
    const inp = this.input, r = this.renderer;
    // Campaign screens cover the battlefield: only they need drawing.
    if (this.state === 'campaign' || this.state === 'hangar') {
      const tag = document.activeElement && document.activeElement.tagName;
      const modal = !$('pilots').hidden || !$('confirm').hidden;
      const typing = tag === 'BUTTON' || tag === 'INPUT' || modal;
      if (modal) {
        if (inp.wasPressed('Escape')) { if (!$('confirm').hidden) this.ui.closeConfirm(false); else $('pilots').hidden = true; }
      } else if (this.state === 'campaign') {
        const w = this.ui.world;
        if (inp.wasPressed('Escape')) { if ($('squad').hidden) this.toMenu(); else this.ui.closeSquad(false); }
        else if (!typing && (inp.wasPressed('ArrowRight') || inp.wasPressed('KeyD'))) w.step(1);
        else if (!typing && (inp.wasPressed('ArrowLeft') || inp.wasPressed('KeyA'))) w.step(-1);
        else if (inp.wasPressed('Enter') && !typing && this.ui.briefLevel && $('squad').hidden) return this.ui.deploy(this.ui.briefLevel);
      } else if (inp.wasPressed('Escape')) this.openCampaign();
      if (this.state === 'campaign') this.ui.world.frame(dt);
      else if (this.state === 'hangar' && this.ui.hgView === 'bay') this.ui.preview.frame(dt);
      this.sfx.frame([]);
      return;
    }
    const typingOrModal = document.activeElement?.tagName === 'BUTTON' || !$('pilots').hidden || !$('confirm').hidden;
    if (this.state === 'menu' && !typingOrModal) {
      if (inp.wasPressed('Enter')) this.startMatch();
      else if (inp.wasPressed('Escape')) return this.toTitle();
    }
    if (this.state === 'title' && !typingOrModal && inp.wasPressed('Enter')) return this.toMenu();
    if (this.state === 'online' && !typingOrModal && inp.wasPressed('Escape')) return this.leaveOnline();
    if (this.state === 'playing') {
      if (inp.wasPressed('Escape') || inp.wasPressed('KeyP')) this.setPaused(!this.paused);
      if (inp.wasPressed('KeyM')) this.sfx.toggleMute();
    }
    const g = this.game, humans = g.locals || g.players;
    const playing = this.state === 'playing';
    const coop = humans.length > 1;
    const simulate = !(playing && this.paused) || this.net.active;
    const canDrive = playing && !this.paused && g.phase !== 'over';
    const netPlay = playing && this.net.active;

    // Controls.
    let aim = null, preview = null;
    humans.forEach((p, i) => {
      if (playing && !this.paused && inp.autoToggled(i, coop)) {
        this.autofire[i] = !this.autofire[i];
        this.sfx.play('click');
      }
      if (canDrive && p.alive) {
        if (coop) this.locks[i] = inp.applyCoop(p, i, g, this.steering, this.locks[i], this.autofire[i]);
        else {
          aim = inp.touchMode ? inp.applyTouch(p, g, this.autofire[i]) : inp.applyTo(p, r, this.steering, this.autofire[i], g);
          // Show which tank a right-click missile (or artillery strike) would lock onto.
          const sp = p.loadout.special;
          if (p.missileCharge >= g.specialCost(p) && (sp === 'missile' || sp === 'artillery' || sp === 'airstrike')) {
            const t = pickMissileTarget(p, g, aim);
            if (t && (sp === 'missile' || (dist(t.x, t.y, aim.x, aim.y) < 110 && dist(t.x, t.y, p.x, p.y) < ARTY.range))) {
              preview = { tank: t, label: sp === 'missile' ? 'MISSILE LOCK' : sp === 'airstrike' ? 'AIRSTRIKE' : 'ARTILLERY LOCK' };
            }
          }
        }
      } else {
        p.input.fire = false; p.input.throttle = 0; p.input.turn = 0; p.input.missile = false;
        this.locks[i] = null;
      }
    });

    // Level-up choices.
    if (playing && !this.paused) humans.forEach((p, i) => {
      if (!p.offer) return;
      const k = inp.pickPressed(i, coop);
      if (k >= 0) { this.pickOffer(p, k); this.sfx.play('click'); }
    });

    if (simulate && this.net.isClient && playing) {
      // A joiner doesn't simulate: it plays back what the host sends, and
      // drives its own tank locally so steering doesn't wait for the round trip.
      this.net.clientInput(dt, humans[0], g);
      this.net.clientFrame(dt, g);
      this.predictLocal(dt, humans[0], g, canDrive);
      this.processEvents();
      r.fx.update(dt, g);
    } else if (simulate) {
      // Brief slow motion as the match ends.
      const simDt = dt * (g.phase === 'over' && g.overT < 0.8 ? 0.35 : 1);
      const steps = Math.ceil(simDt / (1 / 60));
      for (let i = 0; i < steps; i++) g.update(simDt / steps);
      if (this.net.isHost && playing) this.net.collectEvents(g);
      this.processEvents();
      r.fx.update(simDt, g);
      if (this.net.isHost && playing) this.net.hostFrame(dt, g);
    }

    // A quiet moment: build one sprite and bake one sound, so the first kill of
    // the match is not the frame that pays for both.
    const quiet = !playing || this.paused || g.phase === 'intro' || g.phase === 'over';
    if (quiet) {
      const jobs = this.warmJobs;
      if (jobs && jobs.length) { for (let i = 0; i < 3 && jobs.length; i++) jobs.shift()(); }
      else this.sfx.pumpBake();
    }

    // Cameras: one per view.
    if (!playing) {
      this.demoT -= dt;
      if (!this.demoFocus || !this.demoFocus.alive || this.demoT <= 0) {
        const busy = g.tanks.filter(t => t.alive && t.brain && t.brain.target);
        this.demoFocus = randPick(busy.length ? busy : g.tanks.filter(t => t.alive)) || g.tanks[0];
        this.demoT = 9;
      }
      r.updateCamera(r.views[0], dt, this.demoFocus, null, 0.92);
      if (g.phase === 'over' && g.overT > 4) this.startDemo();
    } else {
      r.views.forEach((v, i) => {
        const p = humans[i];
        if (p.alive) {
          this.spectate[i] = null;
          r.updateCamera(v, dt, p, coop ? null : aim);
        } else r.updateCamera(v, dt, this.spectateTarget(g, p, i));
      });
    }
    this.sfx.frame(playing ? humans : []);

    if (inp.touchMode !== this.lastTouch) { this.lastTouch = inp.touchMode; this.ui.renderControls(); }
    const touch = playing && !coop && inp.touchMode;
    r.touchUI = touch;
    document.body.classList.toggle('touch', inp.touchMode);
    r.render(simulate ? dt : 0, {
      demo: !playing,
      showCrosshair: playing && !coop && !this.paused && !this.endShown && inp.mouse.inside && !inp.touchMode,
      aimLine: touch && !this.paused && !this.endShown && humans[0].alive ? humans[0] : null,
      mouse: inp.mouse,
      locks: coop ? this.locks : null,
      preview,
    });

    if (playing) {
      this.ui.touchFrame(g, touch && !this.paused && !this.endShown && g.phase !== 'over', humans[0], this.autofire[0]);
      this.ui.frame(g, humans, this.spectate, this.autofire);
      if (g.phase === 'over' && g.overT > 1.3 && !this.endShown) {
        this.endShown = true;
        let camp = null;
        if (this.mission) {
          const ev = evaluateMission(g, this.mission);
          camp = { level: this.mission, ev, pay: applyMissionResult(this.ui.cp, this.mission, ev) };
        }
        const result = this.ui.showEnd(g, camp);
        this.sfx.play(result === 'win' ? 'victory' : 'defeat');
      }
    }
  },

  // Who a dead player's view follows: their co-op partner first, then the killer.
  spectateTarget(g, p, idx) {
    const alive = g.tanks.filter(t => t.alive);
    if (!alive.length) return p;
    let cur = this.spectate[idx];
    // Solo battle royale / hardcore: click cycles survivors (hardcore: your teammates first).
    const hc = g.settings.mode === 'hardcore';
    const pool = hc && alive.some(t => t.team === p.team) ? alive.filter(t => t.team === p.team) : alive;
    if (g.players.length === 1 && !g.def.respawn && this.input.clicked && (this.ui.brDismissed || hc)) {
      const i = pool.indexOf(cur);
      cur = pool[(i + 1) % pool.length];
    }
    if (!cur || !cur.alive || (hc && pool[0].team === p.team && cur.team !== p.team)) {
      const mate = g.players.find(q => q !== p && q.alive && q.team === p.team);
      const k = p.killedBy;
      // Hardcore: stay with your own side while any of it is still fighting.
      const ally = hc ? alive.find(t => t.team === p.team) : null;
      cur = mate || ally || (k && k.alive ? k : null) || alive.find(t => t.team === p.team) || alive[0];
    }
    this.spectate[idx] = cur;
    return cur;
  },

  processEvents() {
    const g = this.game, r = this.renderer;
    const playing = this.state === 'playing';
    const cams = r.views.map(v => v.cam);
    for (const e of g.events) {
      r.fx.handle(e);
      if (playing) this.feedback(e, g, cams);
    }
    g.events.length = 0;
  },

  // Sound + HUD reactions to simulation events.
  feedback(e, g, cams) {
    const sfx = this.sfx, ui = this.ui, humans = g.players;
    switch (e.type) {
      case 'shot':
        if (e.weapon === 'mg') sfx.play('mg', e.x, e.y, cams);
        else if (e.weapon === 'flame') { if (Math.random() < 0.35) sfx.play('flame', e.x, e.y, cams); }
        else if (e.weapon === 'longgun') sfx.play('longgun', e.x, e.y, cams);
        else if (e.weapon === 'bazooka') sfx.play('rocket', e.x, e.y, cams);
        else if (e.weapon === 'coaxmg') sfx.play('coaxmg', e.x, e.y, cams);
        else if (e.weapon === 'hesh') sfx.play('hesh', e.x, e.y, cams);
        else if (e.weapon === 'wire') sfx.play('wire', e.x, e.y, cams);
        else sfx.play('shot', e.x, e.y, cams, { mine: e.tank.isPlayer });
        break;
      case 'mine_drop': sfx.play('minedrop', e.x, e.y, cams); break;
      case 'mine_boom': case 'arty_boom': sfx.play('mboom', e.x, e.y, cams); break;
      case 'arty_launch': sfx.play('arty', e.x, e.y, cams); sfx.play('whistle', e.x, e.y, cams); break;
      case 'smoke': sfx.play('smoke', e.x, e.y, cams); break;
      case 'overheat': if (e.tank.isPlayer) sfx.play('overheat'); break;
      case 'levelup': if (e.tank.isPlayer) sfx.play('levelup'); break;
      case 'upgrade':
        if (e.tank.isPlayer) {
          sfx.play('upgrade');
          ui.announce(PARTS[e.slot][e.id].name + ' fitted', humans.length > 1 ? e.tank.name : null, '#ffc850');
        }
        break;
      case 'streak':
        if (e.tank.isPlayer) { sfx.play('streak'); ui.announce(e.streak + ' kill streak', humans.length > 1 ? e.tank.name : null, '#ffb347'); }
        break;
      case 'ram': sfx.play('ram', e.x, e.y, cams); break;
      case 'repair_kit': sfx.play('repairkit', e.x, e.y, cams); break;
      case 'overdrive': sfx.play('overdrive', e.x, e.y, cams); break;
      case 'grenade_launch': sfx.play('grenade', e.x, e.y, cams); break;
      case 'grenade_bounce': sfx.play('bounce', e.x, e.y, cams); break;
      case 'grenade_boom': sfx.play('gboom', e.x, e.y, cams); break;
      case 'salvo_launch': sfx.play('salvo', e.x, e.y, cams); break;
      case 'flak_on': if (e.tank.isPlayer) sfx.play('upgrade'); break;
      case 'intercept': sfx.play('flak', e.x, e.y, cams); break;
      case 'air_call': if (e.tank.isPlayer) sfx.play('radio'); break;
      case 'air_pass': sfx.play('plane', e.x, e.y, cams); break;
      case 'air_boom': sfx.play('bomb', e.x, e.y, cams); break;
      case 'round_end': sfx.play(e.winner !== null && humans.length && e.winner === humans[0].team ? 'objective' : 'round'); break;
      case 'round_start': sfx.play('go'); break;
      case 'escort_round': sfx.play('horn'); break;
      case 'escort_end': sfx.play('objective'); break;
      case 'impact': sfx.play(e.kind === 'hesh' ? 'heshhit' : e.kind, e.x, e.y, cams); break;
      case 'hit':
        if (e.kind === 'burn' || e.kind === 'flame') break;
        sfx.play('hit', e.x, e.y, cams);
        if (e.shooter && e.shooter.isPlayer) sfx.play('hitmarker');
        break;
      case 'kill':
        sfx.play('explosion', e.x, e.y, cams);
        ui.killfeedAdd(e);
        if (e.killer && e.killer.isPlayer && e.victim !== e.killer) {
          sfx.play('kill');
          ui.killConfirm(e.victim, e.killer);
        }
        if (e.victim.isPlayer) {
          this.spectate[e.victim.humanIndex] = null;
          if (g.settings.mode === 'br' && g.phase !== 'over' && humans.every(p => !p.alive)) ui.showBROut(g);
        }
        break;
      case 'announce': ui.announce(e.text, e.sub, e.color); break;
      case 'flag':
        sfx.play(e.action === 'take' && humans.length && e.team === humans[0].team ? 'alarm' : 'objective');
        break;
      case 'hill': sfx.play('objective'); break;
      case 'jug': sfx.play(e.first ? 'go' : 'objective'); break;
      case 'missile_launch': sfx.play('missile', e.x, e.y, cams); break;
      case 'missile_beep': sfx.play('mbeep', e.x, e.y, cams); break;
      case 'missile_boom': sfx.play('mboom', e.x, e.y, cams); break;
      case 'missile_ready': if (e.tank.isPlayer) sfx.play('ready'); break;
      case 'zone': sfx.play('alarm'); break;
      case 'go': ui.go(); sfx.play('go'); break;
    }
  },
};

function boot() {
  if (App.booted) return;
  App.booted = true;
  App.init();
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot();
