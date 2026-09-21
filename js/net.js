'use strict';
// ---------------------------------------------------------------------------
// Online play. Supabase Realtime carries the handshake (room code, session
// descriptions, ICE candidates); the battle itself runs peer-to-peer over
// WebRTC data channels, and falls back to relaying through Supabase when a
// direct connection can't be made.
//
// The host simulates the whole match. Joiners send their inputs and render the
// snapshots that come back, predicting their own tank so steering feels live.
// ---------------------------------------------------------------------------

const NET = {
  url: 'https://anafibuqxaqwsybznobj.supabase.co',
  // The anon key is meant to be public: it only allows what this project's
  // policies allow, and we use it for realtime broadcast alone.
  anon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFuYWZpYnVxeGFxd3N5Ynpub2JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4OTEzMDIsImV4cCI6MjEwNTQ2NzMwMn0.NpzBh9Z1dI6WiLVWE8srUd92KBV27MoO4JEMr20gVG0',
  lib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js',
  ice: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  home: 'dbig-d.github.io/ironclad',   // where online play actually works
  maxPlayers: 4,
  snapHz: 22,          // world updates per second over a direct connection
  relaySnapHz: 10,     // slower when bouncing through Supabase
  inputHz: 30,
  p2pTimeout: 9000,    // give up on a direct connection after this and relay
  interp: 0.1,         // render this far behind the host, in seconds
  codeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  modes: ['tdm', 'koth', 'ctf', 'oneshot', 'escort', 'hardcore', 'br', 'jug'],
};

const netId = () => Array.from({ length: 8 }, () => NET.codeChars[(Math.random() * NET.codeChars.length) | 0]).join('');
const netCode = () => Array.from({ length: 5 }, () => NET.codeChars[(Math.random() * NET.codeChars.length) | 0]).join('');

// One connection to another player: a WebRTC data channel where possible,
// otherwise messages relayed through the room's Supabase channel.
class NetPeer {
  constructor(net, id, name, initiator) {
    this.net = net;
    this.id = id;
    this.name = name;
    this.initiator = initiator;
    this.mode = 'connecting';   // 'p2p' | 'relay' | 'connecting' | 'gone'
    this.ping = 0;
    this.lastSeen = performance.now();
    this.team = 0;
    this.ready = false;
    this.pending = [];          // ICE candidates that arrive before the answer
    this.open = false;
  }

  async connect() {
    const pc = this.pc = new RTCPeerConnection({ iceServers: NET.ice });
    pc.onicecandidate = e => { if (e.candidate) this.net.sig({ t: 'ice', to: this.id, c: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.fallback();
    };
    if (this.initiator) {
      this.bind(pc.createDataChannel('battle', { ordered: false, maxRetransmits: 0 }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.net.sig({ t: 'offer', to: this.id, sdp: pc.localDescription.sdp });
    } else {
      pc.ondatachannel = e => this.bind(e.channel);
    }
    // If the direct route doesn't come up, keep playing through the relay.
    this.fallbackT = setTimeout(() => this.fallback(), NET.p2pTimeout);
  }

  bind(dc) {
    this.dc = dc;
    dc.onopen = () => {
      clearTimeout(this.fallbackT);
      this.open = true;
      this.mode = 'p2p';
      this.net.onPeerUp(this);
    };
    dc.onclose = () => { this.open = false; if (this.mode === 'p2p') this.fallback(); };
    dc.onmessage = e => this.net.onPeerMessage(this, e.data);
  }

  // Direct connection unavailable: bounce messages off Supabase instead.
  fallback() {
    clearTimeout(this.fallbackT);
    if (this.mode === 'gone' || this.open) return;
    const first = this.mode !== 'relay';
    this.mode = 'relay';
    if (first) this.net.onPeerUp(this);
  }

  async handleSignal(m) {
    const pc = this.pc;
    if (!pc) return;
    if (m.t === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.net.sig({ t: 'answer', to: this.id, sdp: pc.localDescription.sdp });
    } else if (m.t === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (m.t === 'ice') {
      if (pc.remoteDescription) await pc.addIceCandidate(m.c).catch(() => {});
      else this.pending.push(m.c);
    }
  }

  send(obj) {
    const s = JSON.stringify(obj);
    if (this.open) { try { this.dc.send(s); return; } catch (e) { /* fall through to relay */ } }
    if (this.mode !== 'gone') this.net.sig({ t: 'data', to: this.id, d: s });
  }

  close() {
    this.mode = 'gone';
    clearTimeout(this.fallbackT);
    try { if (this.dc) this.dc.close(); } catch (e) {}
    try { if (this.pc) this.pc.close(); } catch (e) {}
  }
}

class Net {
  constructor(app) {
    this.app = app;
    this.role = null;          // 'host' | 'client'
    this.peers = new Map();
    this.me = netId();
    this.name = 'Player';
    this.code = '';
    this.state = 'off';        // off | connecting | lobby | playing
    this.error = '';
    this.roster = [];          // lobby rows: { id, name, team, you, host, mode, ping }
    this.snapBuf = [];         // client: recent snapshots, for interpolation
    this.sendT = 0;
    this.inputT = 0;
    this.seq = 0;
    this.oid = 0;              // ids for shells, missiles and the rest
    this.lobby = { mode: 'tdm', size: 2, hits: 7, biome: 'random', difficulty: 'normal', fill: true };
  }

  get isHost() { return this.role === 'host'; }
  get isClient() { return this.role === 'client'; }
  get active() { return this.state !== 'off'; }

  // ---- plumbing ------------------------------------------------------------------------
  async loadLib() {
    if (window.supabase && window.supabase.createClient) return true;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = NET.lib;
      s.onload = res;
      s.onerror = () => rej(new Error('offline'));
      document.head.appendChild(s);
    });
    return !!(window.supabase && window.supabase.createClient);
  }

  async openRoom(code) {
    this.code = code;
    // One client per page: opening a second room reuses it.
    this.sb = this.sb || window.supabase.createClient(NET.url, NET.anon, { realtime: { params: { eventsPerSecond: 40 } } });
    this.channel = this.sb.channel('ic-' + code, { config: { broadcast: { self: false } } });
    this.channel.on('broadcast', { event: 'sig' }, m => this.onSig(m.payload));
    const status = await new Promise(res => {
      const done = s => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) res(s); };
      this.channel.subscribe(done);
      setTimeout(() => res('TIMED_OUT'), 12000);
    });
    if (status !== 'SUBSCRIBED') throw new Error('no-room');
    // The code has to keep working between matches: rejoin the channel if it drops.
    clearInterval(this.roomT);
    this.roomT = setInterval(() => {
      const ch = this.channel;
      if (!ch || !this.active) return;
      const st = String(ch.state || '').toLowerCase();
      if (st === 'closed' || st === 'errored') { try { ch.subscribe(); } catch (e) { /* retried next tick */ } }
    }, 8000);
  }

  sig(msg) {
    if (!this.channel) return;
    msg.from = this.me;
    this.channel.send({ type: 'broadcast', event: 'sig', payload: msg });
  }

  // ---- host / join ---------------------------------------------------------------------
  async host(name) {
    if (this.channel || this.sb) this.leave();
    this.reset();
    this.role = 'host';
    this.name = name || 'Host';
    this.state = 'connecting';
    try {
      if (!(await this.loadLib())) throw new Error('offline');
      await this.openRoom(netCode());
    } catch (e) {
      this.lastErr = (e && e.stack) || String(e);
      this.fail(e.message === 'offline' ? 'Could not load the online library. Check your connection.' : 'Could not open a room. Check your connection and try again.');
      return null;
    }
    this.state = 'lobby';
    this.refreshRoster();
    return this.code;
  }

  async join(code, name) {
    if (this.channel || this.sb) this.leave();
    this.reset();
    this.role = 'client';
    this.name = name || 'Player';
    this.state = 'connecting';
    try {
      if (!(await this.loadLib())) throw new Error('offline');
      await this.openRoom(code.toUpperCase());
    } catch (e) {
      this.lastErr = (e && e.stack) || String(e);
      this.fail('Could not reach that room. Check the code and your connection.');
      return false;
    }
    // Announce ourselves; the host answers with an offer.
    this.sig({ t: 'hello', name: this.name });
    this.joinT = setTimeout(() => { if (this.state === 'connecting') this.fail('No host answered that code. Ask for a fresh one.'); }, 12000);
    return true;
  }

  fail(msg) {
    this.leave(true);
    this.error = msg;   // set after leave(): resetting the room clears it
    this.app.ui.renderOnline();
  }

  reset() {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.snapBuf.length = 0;
    this.error = '';
    this.roster = [];
    clearTimeout(this.joinT);
  }

  leave(quiet) {
    clearInterval(this.roomT);
    if (!quiet && this.channel) this.sig({ t: 'bye' });
    this.reset();
    this.playT = undefined;
    this.lastSnap = 0;
    this.hostBusy = false;
    try { if (this.channel) this.channel.unsubscribe(); } catch (e) {}
    try { if (this.sb) this.sb.removeAllChannels(); } catch (e) {}
    this.channel = null;
    this.role = null;
    this.state = 'off';
    this.code = '';
  }

  // ---- signalling ----------------------------------------------------------------------
  async onSig(m) {
    if (!m || m.from === this.me) return;
    if (m.to && m.to !== this.me) return;
    if (m.t === 'hello' && this.isHost) {
      if (this.peers.size + 1 >= NET.maxPlayers) return this.sig({ t: 'full', to: m.from });
      const peer = new NetPeer(this, m.from, (m.name || 'Player').slice(0, 14), true);
      peer.team = (this.peers.size + 1) % 2;
      this.peers.set(m.from, peer);
      this.sig({ t: 'welcome', to: m.from, name: this.name });
      await peer.connect();
      this.refreshRoster();
      return;
    }
    if (m.t === 'welcome' && this.isClient) {
      clearTimeout(this.joinT);
      this.hostId = m.from;
      const peer = new NetPeer(this, m.from, (m.name || 'Host').slice(0, 14), false);
      this.peers.set(m.from, peer);
      await peer.connect();
      return;
    }
    if (m.t === 'full' || m.t === 'busy') {
      this.fail(m.t === 'full' ? 'That game is full.' : 'That game has already started.');
      return;
    }
    const peer = this.peers.get(m.from);
    if (!peer) return;
    if (m.t === 'data') { this.onPeerMessage(peer, m.d); return; }
    if (m.t === 'bye') { this.dropPeer(peer, 'left'); return; }
    await peer.handleSignal(m).catch(() => {});
  }

  onPeerUp(peer) {
    peer.lastSeen = performance.now();
    if (this.isHost) {
      this.refreshRoster();
      this.sendLobby();
    } else {
      this.state = 'lobby';
      peer.send({ t: 'name', name: this.name, loadout: this.app.ui.settings.loadout });
    }
    this.app.ui.renderOnline();
  }

  dropPeer(peer, why) {
    peer.close();
    this.peers.delete(peer.id);
    if (this.isClient) {
      // Without the host there is no match.
      this.app.onlineEnded(why === 'left' ? 'The host left the game.' : 'Lost the connection to the host.');
      return;
    }
    this.refreshRoster();
    this.sendLobby();
    if (this.state === 'playing') this.app.onlinePlayerLeft(peer);
    this.app.ui.renderOnline();
  }

  // ---- lobby ---------------------------------------------------------------------------
  refreshRoster() {
    const mine = this.app.ui.settings.loadout;
    const rows = [{ id: this.me, name: this.name, team: this.myTeam || 0, you: true, host: this.isHost, mode: 'host', ping: 0, loadout: mine }];
    for (const p of this.peers.values()) rows.push({ id: p.id, name: p.name, team: p.team, you: false, host: false, mode: p.mode, ping: Math.round(p.ping), loadout: p.loadout });
    this.roster = rows;
  }

  sendLobby() {
    if (!this.isHost) return;
    this.refreshRoster();
    const msg = { t: 'lobby', roster: this.roster.map(r => ({ id: r.id, name: r.name, team: r.team, host: r.host })), set: this.lobby, busy: this.state === 'playing' };
    for (const p of this.peers.values()) p.send(msg);
  }

  setTeam(id, team) {
    if (!this.isHost) return;
    if (id === this.me) this.myTeam = team; else { const p = this.peers.get(id); if (p) p.team = team; }
    this.sendLobby();
    this.app.ui.renderOnline();
  }

  setLobby(patch) {
    if (!this.isHost) return;
    Object.assign(this.lobby, patch);
    this.sendLobby();
    this.app.ui.renderOnline();
  }

  // ---- starting a match ----------------------------------------------------------------
  // Both sides build the same world from the same seed, so only the moving
  // parts have to travel over the wire.
  start() {
    if (!this.isHost || this.state !== 'lobby') return;
    const L = this.lobby, team = MODES[L.mode].teams;
    const players = this.roster.slice(0, NET.maxPlayers);
    const slots = [];
    let size;
    if (team) {
      // Everyone gets their own tank: grow the squad to fit the fuller side.
      const used = [0, 0];
      for (const r of players) {
        const t = clamp(r.team | 0, 0, 1);
        slots.push({ id: r.id, name: r.name, team: t, idx: used[t]++, loadout: r.loadout });
      }
      size = rulesSize(Math.max(L.size, used[0], used[1]));
    } else {
      size = ffaSize(L.mode, Math.max(L.size, players.length));
      players.forEach((r, i) => slots.push({ id: r.id, name: r.name, team: i, idx: i, loadout: r.loadout }));
    }
    const settings = {
      mode: L.mode, size, hits: L.hits, difficulty: L.difficulty,
      biome: L.biome === 'random' ? randPick(BIOME_IDS) : L.biome,
      seed: (Math.random() * 1e9) >>> 0,
      progression: L.progression || 'standard', botLoadout: L.progression === 'freeplay' ? L.botLoadout || 'standard' : 'standard',
      netSlots: slots,
    };
    // Build our own world first: if anything goes wrong, the room stays usable.
    try {
      this.app.startOnline(settings, 'host');
    } catch (e) {
      console.error(e);
      this.app.ui.toast('That combination could not start. Try another mode or size.');
      return;
    }
    this.state = 'playing';
    for (const p of this.peers.values()) p.send({ t: 'start', s: settings });
  }

  // ---- messages between peers -----------------------------------------------------------
  onPeerMessage(peer, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    peer.lastSeen = performance.now();
    switch (m.t) {
      case 'name':
        peer.name = (m.name || 'Player').slice(0, 14);
        peer.loadout = m.loadout || null;
        this.refreshRoster();
        this.sendLobby();
        this.app.ui.renderOnline();
        break;
      case 'lobby':
        this.roster = m.roster.map(r => ({ ...r, you: r.id === this.me, mode: peer.mode, ping: Math.round(peer.ping) }));
        this.lobby = m.set;
        this.hostBusy = !!m.busy;
        if (this.state === 'playing') { this.state = 'lobby'; this.app.backToLobby(true); }
        this.app.ui.renderOnline();
        break;
      case 'start':
        this.state = 'playing';
        this.snapBuf.length = 0;
        this.app.startOnline(m.s, 'client');
        break;
      case 'in':
        if (this.isHost) this.applyRemoteInput(peer, m);
        break;
      case 's':
        if (this.isClient) this.onSnapshot(m);
        break;
      case 'ping':
        peer.send({ t: 'pong', at: m.at });
        break;
      case 'pong':
        peer.ping = performance.now() - m.at;
        break;
      case 'offer':
        if (this.isClient) {
          const p = this.app.game && this.app.game.locals[0];
          if (p) p.offer = m.o ? { options: m.o.opts.map(o => ({ slot: o[0], id: o[1] })), expires: this.app.game.time + m.o.time, level: m.o.lv } : null;
        }
        break;
      case 'pick':
        if (this.isHost && peer.tank && peer.tank.offer) this.app.game.pickOffer(peer.tank, m.k);
        break;
      case 'over':
        if (this.isClient) this.app.onlineMatchOver(m);
        break;
      case 'bye':
        this.dropPeer(peer, 'left');
        break;
    }
  }

  everyPeer(msg) { for (const p of this.peers.values()) p.send(msg); }

  // ---- host: read remote inputs, publish the world ---------------------------------------
  applyRemoteInput(peer, m) {
    const t = peer.tank;
    if (!t || !t.alive) return;
    if (m.q <= (peer.lastSeq || -1)) return;   // stale packet, the newer one wins
    peer.lastSeq = m.q;
    const d = m.d;
    t.input.throttle = d[0] / 100;
    t.input.turn = d[1] / 100;
    t.input.aim = d[2] / 1000;
    t.input.fire = !!(d[3] & 1);
    if (d[3] & 2) {
      t.input.missile = true;
      t.input.missileTarget = d[6] >= 0 ? this.app.game.tanks[d[6]] : null;
      t.input.specialPoint = d[4] !== undefined && d[4] !== null ? { x: d[4], y: d[5] } : null;
    }
  }

  hostFrame(dt, game) {
    // Upgrade choices belong to one player: send them straight to that seat.
    for (const p of this.peers.values()) {
      const t = p.tank;
      if (!t) continue;
      const o = t.offer;
      if (o && p.sentOffer !== o) {
        p.sentOffer = o;
        p.send({ t: 'offer', o: { lv: o.level, time: Math.max(0, o.expires - game.time), opts: o.options.map(x => [x.slot, x.id]) } });
      } else if (!o && p.sentOffer) {
        p.sentOffer = null;
        p.send({ t: 'offer', o: null });
      }
    }
    this.sendT -= dt;
    const fastest = [...this.peers.values()].every(p => p.mode === 'p2p');
    if (this.sendT > 0) return;
    this.sendT = 1 / (fastest ? NET.snapHz : NET.relaySnapHz);
    const snap = this.packSnapshot(game);
    this.everyPeer(snap);
    this.pingT = (this.pingT || 0) - 1;
    if (this.pingT <= 0) { this.pingT = NET.snapHz * 2; this.everyPeer({ t: 'ping', at: performance.now() }); }
  }

  packSnapshot(g) {
    const tk = [];
    for (const t of g.tanks) {
      tk.push([t.netIdx, Math.round(t.x), Math.round(t.y), Math.round(t.angle * 100), Math.round(t.turret * 100),
        Math.round(t.hp), (t.alive ? 1 : 0) | (t.input.fire ? 2 : 0) | (t.boostT > 0 ? 4 : 0) | (t.burnT > 0 ? 8 : 0) | (t.repairing ? 16 : 0) | (t.jug ? 32 : 0),
        Math.round(t.treadL), Math.round(t.treadR), Math.round(t.missileCharge),
        Math.round(t.score || 0), t.level || 1, Math.round(t.stats.xp || 0), Math.round(t.maxHp)]);
    }
    const id = o => o.nid || (o.nid = ++this.oid);
    const sh = g.shells.map(x => [id(x), Math.round(x.x), Math.round(x.y), SHELL_NET.indexOf(x.kind), Math.round(x.speed), 0, Math.round(x.angle * 100)]);
    const ms = g.missiles.map(x => [id(x), Math.round(x.x), Math.round(x.y), MISSILE_NET.indexOf(x.kind), x.owner ? x.owner.netIdx : -1, Math.round((x.blink || 0) * 100), Math.round(x.angle * 100)]);
    const gr = g.grenades.map(x => [id(x), Math.round(x.x), Math.round(x.y), Math.round(x.spin * 100), Math.round(x.fuse * 100)]);
    const mi = g.mines.map(x => [id(x), Math.round(x.x), Math.round(x.y), x.team, x.arm > 0 ? 1 : 0, Math.round(x.blink * 100)]);
    const sm = g.smokes.map(x => [id(x), Math.round(x.x), Math.round(x.y), Math.round(x.r), Math.round(x.life * 100), x.seed]);
    const ar = g.artillery.map(x => [id(x), Math.round(x.x), Math.round(x.y), Math.round(x.h), Math.round(x.tx), Math.round(x.ty), Math.round(x.k * 100), Math.round(x.sx), Math.round(x.sy)]);
    const as = g.airstrikes.map(x => [id(x), Math.round(x.x), Math.round(x.y), Math.round(x.a * 100), Math.round(x.t * 100), x.along === undefined ? 0 : Math.round(x.along), x.owner ? x.owner.netIdx : -1]);
    const snap = { t: 's', k: g.time, tk, sh, ms, gr, mi, sm, ar, as, ob: this.packObjective(g), ev: this.packEvents(g) };
    // Kills, deaths and damage change slowly: send them a few times a second.
    this.statT = (this.statT || 0) - 1;
    if (this.statT <= 0) {
      this.statT = 5;
      snap.st = g.tanks.map(t => [t.stats.kills | 0, t.stats.deaths | 0, Math.round(t.stats.damage || 0), t.stats.shots | 0, t.stats.hits | 0, Math.round(t.stats.convoy || 0)]);
    }
    return snap;
  }

  packObjective(g) {
    const o = { ph: g.phase, cl: Math.round(g.clock), sc: g.teams.map(t => Math.round(t.score)), it: Math.round(g.introT * 10), ot: Math.round(g.overT * 10), wn: g.winner };
    const m = g.mode;
    if (m instanceof KOTHMode) o.k = [m.owner, Math.round(m.progress * 100), m.contested ? 1 : 0, m.capTeam === undefined ? -1 : m.capTeam];
    else if (m instanceof EscortMode) o.e = [m.state === 'break' ? 1 : 0, m.round, Math.round(m.breakT * 10), Math.round(m.eta * 10), Math.round(m.roundTime * 10),
      m.convoy ? Math.round((m.convoy.progress || 0) * 1000) : 0, m.convoy ? m.convoy.netIdx : -1, m.convoy ? m.convoy.team : 0,
      m.results.map(r => [r.attackers, r.destroyed ? 1 : 0, Math.round(r.time * 10), Math.round(r.damage)])];
    else if (m instanceof HardcoreMode) o.h = [m.state === 'break' ? 1 : 0, m.round, Math.round(m.breakT * 10), Math.round(m.roundTime * 10), m.history];
    else if (m instanceof JuggernautMode) o.j = [m.jug ? m.jug.netIdx : -1, m.overtime ? 1 : 0];
    else if (m instanceof CTFMode) o.f = m.flags.map(f => [Math.round(f.x), Math.round(f.y), f.carrier ? f.carrier.netIdx : -1, f.home ? 1 : 0, Math.round((f.dropT || 0) * 10)]);
    else if (m instanceof BRMode) o.z = [Math.round(m.zone.x), Math.round(m.zone.y), Math.round(m.zone.r), Math.round(m.zone.tx), Math.round(m.zone.ty), Math.round(m.zone.tr), m.phase, m.state === 'shrink' ? 1 : 0, Math.round(m.timer * 10)];
    return o;
  }

  // Events carry live objects; send ids instead and rebuild them on the far side.
  packEvents(g) {
    const out = [];
    for (const e of g.events) {
      if (NET_SKIP_EVENTS.has(e.type)) continue;
      const o = {};
      for (const k in e) {
        const v = e[k];
        if (v === null || v === undefined) continue;
        if (NET_REF_FIELDS.has(k)) { if (v && v.netIdx !== undefined) o[k] = { $: v.netIdx }; continue; }
        const ty = typeof v;
        if (ty === 'number') o[k] = k === 'x' || k === 'y' || k === 'fx' || k === 'fy' ? Math.round(v) : Math.round(v * 1000) / 1000;
        else if (ty === 'string' || ty === 'boolean') o[k] = v;
        else if (k === 'muzzles' && Array.isArray(v)) o[k] = v.map(mz => mz.map(n => Math.round(n * 100) / 100));
      }
      out.push(o);
    }
    return out;
  }

  // ---- client: send input, apply snapshots ------------------------------------------------
  clientInput(dt, tank, game) {
    this.inputT -= dt;
    if (this.inputT > 0 || !tank) return;
    this.inputT = 1 / NET.inputHz;
    const inp = tank.input;
    const target = inp.missileTarget ? game.tanks.indexOf(inp.missileTarget) : -1;
    const pt = inp.specialPoint;
    this.everyPeer({ t: 'in', q: ++this.seq, d: [
      Math.round(inp.throttle * 100), Math.round(inp.turn * 100), Math.round(inp.aim * 1000),
      (inp.fire ? 1 : 0) | (inp.missile ? 2 : 0),
      pt ? Math.round(pt.x) : null, pt ? Math.round(pt.y) : null, target,
    ] });
  }

  onSnapshot(m) {
    this.lastSnap = performance.now();
    m.at = performance.now();
    const gm = this.app.game;
    if (m.st && gm) {
      m.st.forEach((r, i) => {
        const t = gm.tanks[i];
        if (!t) return;
        t.stats.kills = r[0]; t.stats.deaths = r[1]; t.stats.damage = r[2];
        t.stats.shots = r[3]; t.stats.hits = r[4]; t.stats.convoy = r[5];
      });
    }
    const buf = this.snapBuf;
    if (buf.length && m.k < buf[buf.length - 1].k) return;   // a late packet would rewind the world
    buf.push(m);
    if (buf.length > 12) buf.shift();
    const g = this.app.game;
    if (!g) return;
    // Events replay straight away: sounds and effects shouldn't wait for interpolation.
    for (const e of m.ev) {
      const ev = {};
      for (const k in e) {
        const v = e[k];
        if (v && typeof v === 'object' && v.$ !== undefined) { const t = g.tanks[v.$]; if (!t) { ev.__drop = true; continue; } ev[k] = t; }
        else ev[k] = v;
      }
      if (ev.__drop) continue;
      // Upgrades repaint the tank, so apply the part before the effects play.
      if (ev.type === 'upgrade' && ev.tank && ev.slot) { ev.tank.loadout[ev.slot] = ev.id; ev.tank.recalc(g.baseHp); }
      g.events.push(ev);
    }
  }

  // Play the match back on the host's clock, a fraction of a second behind the
  // newest snapshot, so motion is smooth however unevenly packets arrive.
  clientFrame(dt, g) {
    const buf = this.snapBuf;
    // Nothing from the host for a while: back to the room rather than a frozen battlefield.
    if (this.lastSnap && performance.now() - this.lastSnap > 9000) {
      this.lastSnap = 0;
      this.state = 'lobby';
      this.app.backToLobby(true);
      this.app.ui.toast('Lost the connection to the host.');
      return;
    }
    if (!buf.length) return;
    const newest = buf[buf.length - 1];
    const target = newest.k - NET.interp;
    if (this.playT === undefined || this.playT > newest.k || this.playT < target - 0.6) this.playT = target;
    else {
      // Drift gently toward the target instead of jumping: a step early or late
      // is far less visible than a snap.
      const off = target - this.playT;
      this.playT += dt * clamp(1 + off * 2.5, 0.75, 1.35);
    }
    const t0 = this.playT;
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) if (buf[i].k <= t0 && buf[i + 1].k >= t0) { a = buf[i]; b = buf[i + 1]; break; }
    const span = b.k - a.k;
    const f = span > 1e-4 ? clamp((t0 - a.k) / span, 0, 1) : 1;
    g.time = t0;
    const mine = g.locals[0];
    const prev = new Map();
    for (const row of a.tk) prev.set(row[0], row);
    for (const row of b.tk) {
      const t = g.tanks[row[0]];
      if (!t) continue;
      const p = prev.get(row[0]) || row;
      const px = lerp(p[1], row[1], f), py = lerp(p[2], row[2], f);
      const pa = lerpAngle(p[3] / 100, row[3] / 100, f), pt = lerpAngle(p[4] / 100, row[4] / 100, f);
      t.vx = span > 1e-4 ? (row[1] - p[1]) / span : 0;
      t.vy = span > 1e-4 ? (row[2] - p[2]) / span : 0;
      t.hp = row[5];
      const flags = row[6];
      const wasAlive = t.alive;
      t.alive = !!(flags & 1);
      t.input.fire = !!(flags & 2);
      t.boostT = (flags & 4) ? 1 : 0;
      t.burnT = (flags & 8) ? 1 : 0;
      t.repairing = !!(flags & 16);
      t.treadL = lerp(p[7], row[7], f); t.treadR = lerp(p[8], row[8], f);
      t.missileCharge = row[9];
      t.score = row[10];
      t.level = row[11];
      t.stats.xp = row[12];
      const wasJug = t.jug;
      t.jug = !!(flags & 32);
      if (t.jug !== wasJug) { t.jugHpMul = row[13] / Math.max(1, g.baseHp); t.recalc(g.baseHp); }
      t.maxHp = row[13];
      if (!wasAlive && t.alive) { t.x = px; t.y = py; t.angle = pa; }   // respawned: no sliding in from the grave
      if (t === mine && t.alive) { this.reconcile(dt, t, newest); continue; }
      t.x = px; t.y = py; t.angle = pa; t.turret = pt;
      t.speed = Math.hypot(t.vx, t.vy);
    }
    // Shells, missiles and the rest carry an id so each one keeps its identity
    // between snapshots; without that they swap places as the lists reshuffle.
    this.blend(g.shells, a.sh, b.sh, f, (o, r) => {
      o.angle = r[6] / 100; o.kind = SHELL_NET[r[3]]; o.speed = r[4];
      o.bullet = o.kind === 'bullet' || o.kind === 'coax';
      o.flame = o.kind === 'flame'; o.hesh = o.kind === 'hesh';
      o.age = (o.age || 0) + dt; o.radius = 4;
    });
    this.blend(g.missiles, a.ms, b.ms, f, (o, r) => {
      o.angle = r[6] / 100;
      o.kind = MISSILE_NET[r[3]];
      o.rocket = o.kind === 'rocket' || o.kind === 'salvo';
      o.wire = o.kind === 'wire';
      o.owner = g.tanks[r[4]] || null;
      o.blink = r[5] / 100;
      o.team = o.owner ? o.owner.team : -1;
      o.age = (o.age || 0) + dt; o.alive = true;
    });
    this.blend(g.grenades, a.gr, b.gr, f, (o, r) => { o.spin = r[3] / 100; o.fuse = r[4] / 100; o.alive = true; });
    this.blend(g.mines, a.mi, b.mi, f, (o, r) => {
      o.team = r[3]; o.arm = r[4]; o.blink = r[5] / 100; o.alive = true;
      o.owner = o.owner || { color: (g.teams[r[3]] || g.teams[0] || {}).color || TEAM_COLORS[0] };
    });
    this.blend(g.smokes, a.sm, b.sm, f, (o, r) => { o.r = r[3]; o.life = r[4] / 100; o.max = SMOKE.life; o.seed = r[5]; });
    this.blend(g.artillery, a.ar, b.ar, f, (o, r) => { o.h = r[3]; o.tx = r[4]; o.ty = r[5]; o.k = r[6] / 100; o.sx = r[7]; o.sy = r[8]; o.peak = Math.max(1, o.h || 1); });
    this.blend(g.airstrikes, a.as, b.as, f, (o, r) => { o.a = r[3] / 100; o.t = r[4] / 100; o.along = r[5]; o.owner = g.tanks[r[6]] || g.tanks[0]; });
    this.applyObjective(g, b.ob);
  }

  // Merge two snapshots of one list. Rows are [id, x, y, ...]; anything in both
  // is interpolated, anything new appears where it is.
  blend(list, rowsA, rowsB, f, fill) {
    const old = this.byId || (this.byId = new Map());
    old.clear();
    for (const r of rowsA) old.set(r[0], r);
    const keep = list.__keep || (list.__keep = new Map());
    list.length = 0;
    for (const r of rowsB) {
      let o = keep.get(r[0]);
      if (!o) { o = {}; keep.set(r[0], o); }
      const p = old.get(r[0]);
      o.nid = r[0];
      o.x = p ? lerp(p[1], r[1], f) : r[1];
      o.y = p ? lerp(p[2], r[2], f) : r[2];
      fill(o, r);
      list.push(o);
    }
    // Forget anything that has gone, so the map can't grow without bound.
    if (keep.size > rowsB.length * 3 + 40) {
      const live = new Set(rowsB.map(r => r[0]));
      for (const id of keep.keys()) if (!live.has(id)) keep.delete(id);
    }
  }

  applyObjective(g, o) {
    if (!o) return;
    g.phase = o.ph;
    g.clock = o.cl;
    g.introT = o.it / 10;
    g.overT = o.ot / 10;
    g.winner = o.wn;
    o.sc.forEach((v, i) => { if (g.teams[i]) g.teams[i].score = v; });
    const m = g.mode;
    if (o.k && m instanceof KOTHMode) { m.owner = o.k[0]; m.progress = o.k[1] / 100; m.contested = !!o.k[2]; m.capTeam = o.k[3] < 0 ? undefined : o.k[3]; }
    else if (o.e && m instanceof EscortMode) {
      m.state = o.e[0] ? 'break' : 'round';
      m.round = o.e[1]; m.breakT = o.e[2] / 10; m.eta = o.e[3] / 10; m.roundTime = o.e[4] / 10;
      m.convoy = o.e[6] >= 0 ? g.tanks[o.e[6]] : null;
      if (m.convoy) m.convoy.progress = o.e[5] / 1000;
      m.results = o.e[8].map(r => ({ attackers: r[0], destroyed: !!r[1], time: r[2] / 10, damage: r[3] }));
      if (m.convoy && m.convoy.team !== o.e[7]) { m.convoy.team = o.e[7]; m.convoy.color = g.teams[o.e[7]].color; }
    } else if (o.h && m instanceof HardcoreMode) {
      m.state = o.h[0] ? 'break' : 'round';
      m.round = o.h[1]; m.breakT = o.h[2] / 10; m.roundTime = o.h[3] / 10; m.history = o.h[4];
    } else if (o.j && m instanceof JuggernautMode) {
      m.jug = o.j[0] >= 0 ? g.tanks[o.j[0]] : null;
      m.overtime = !!o.j[1];
    }
    else if (o.f && m instanceof CTFMode) o.f.forEach((r, i) => { const f = m.flags[i]; if (!f) return; f.x = r[0]; f.y = r[1]; f.carrier = r[2] >= 0 ? g.tanks[r[2]] : null; f.home = !!r[3]; f.dropT = r[4] / 10; });
    else if (o.z && m instanceof BRMode) { const z = m.zone; z.x = o.z[0]; z.y = o.z[1]; z.r = o.z[2]; z.tx = o.z[3]; z.ty = o.z[4]; z.tr = o.z[5]; m.phase = o.z[6]; m.state = o.z[7] ? 'shrink' : 'wait'; m.timer = o.z[8] / 10; }
    // Carried flags ride along with their carrier.
    for (const t of g.tanks) t.carrying = null;
    if (o.f && m instanceof CTFMode) for (const f of m.flags) if (f.carrier) f.carrier.carrying = f;
  }

  // Our own tank is simulated locally so steering feels instant; nudge it back
  // toward the host's version instead of snapping.
  reconcile(dt, t, newest) {
    const row = newest.tk.find(r => r[0] === t.netIdx);
    if (!row) return;
    const x = row[1], y = row[2], a = row[3] / 100;
    const d = dist(t.x, t.y, x, y);
    if (d > 110) { t.x = x; t.y = y; t.angle = a; return; }   // too far out: take the host's word
    if (d < 6) return;                                        // close enough: leave it alone
    const k = 1 - Math.exp(-5 * dt);
    t.x = lerp(t.x, x, k);
    t.y = lerp(t.y, y, k);
    t.angle = lerpAngle(t.angle, a, 1 - Math.exp(-3 * dt));
  }
}

// Shell and missile kinds, by index, so snapshots stay small.
const SHELL_NET = ['shell', 'bullet', 'flame', 'long', 'hesh', 'coax'];
const MISSILE_NET = ['missile', 'rocket', 'salvo', 'wire'];
// Events that are either local-only or rebuilt from the snapshot itself.
const NET_SKIP_EVENTS = new Set(['missile_ready']);
const NET_REF_FIELDS = new Set(['tank', 'target', 'shooter', 'victim', 'killer', 'owner', 'missile', 'strike']);
