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
  ice: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // A TURN server lets two phones on mobile data (which often can't reach
    // each other directly) talk without the slow Supabase relay. Add one here:
    // { urls: 'turn:your.turn.host:3478', username: '...', credential: '...' },
  ],
  home: 'dbig-d.github.io/ironclad',   // where online play actually works
  maxPlayers: 4,
  snapHz: 30,          // world updates per second over a direct connection
  relaySnapHz: 10,     // slower when bouncing through Supabase
  inputHz: 60,         // most input sends per second over a direct connection (only when it changes)
  relayInputHz: 20,
  inputIdle: 1 / 12,   // resend unchanged input this often, in case a packet was lost
  p2pTimeout: 9000,    // give up on a direct connection after this and relay
  // Joiners render the world this far behind the newest snapshot. It adapts to
  // how evenly snapshots arrive, between these bounds (seconds).
  interpMin: 0.05,
  interpMax: 0.3,
  statsEvery: 0.25,    // kills, deaths and damage change slowly: this many seconds apart
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
    // Two channels: 'battle' is fire-and-forget for snapshots and inputs (a late
    // one is useless, the next is already coming); 'ctl' is reliable and ordered
    // for the messages that must arrive (match start, lobby, upgrade picks).
    if (this.initiator) {
      this.bind(pc.createDataChannel('battle', { ordered: false, maxRetransmits: 0 }));
      this.bind(pc.createDataChannel('ctl', { ordered: true }));
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
    const ctl = dc.label === 'ctl';
    if (ctl) this.ctl = dc; else this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      if (ctl) this.ctlOpen = true; else this.open = true;
      if (!this.open || !this.ctlOpen || this.mode === 'p2p') return;
      clearTimeout(this.fallbackT);
      this.mode = 'p2p';
      this.net.onPeerUp(this);
    };
    dc.onclose = () => {
      if (ctl) this.ctlOpen = false; else this.open = false;
      if (this.mode === 'p2p' && !this.open) this.fallback();
    };
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

  send(obj) { this.sendRaw(JSON.stringify(obj), !NET_UNRELIABLE.has(obj.t)); }

  sendRaw(s, reliable) {
    if (reliable && this.ctlOpen) { try { this.ctl.send(s); return; } catch (e) { /* try the battle channel */ } }
    if (this.open) { try { this.dc.send(s); return; } catch (e) { /* fall through to relay */ } }
    if (this.mode !== 'gone') this.net.sig({ t: 'data', to: this.id, d: s });
  }

  // Binary world snapshots: straight down the battle channel, or base64 through the relay.
  sendBin(buf) {
    if (this.open) { try { this.dc.send(buf); return; } catch (e) { /* fall through to relay */ } }
    if (this.mode !== 'gone') this.net.sig({ t: 'data', to: this.id, b: bufToB64(buf) });
  }

  close() {
    this.mode = 'gone';
    clearTimeout(this.fallbackT);
    try { if (this.dc) this.dc.close(); } catch (e) {}
    try { if (this.ctl) this.ctl.close(); } catch (e) {}
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
    this.pendingEv = [];       // host: effects waiting for the next snapshot
    this.evQueue = [];         // joiner: effects waiting for the clock to reach them
    this.lobby = { mode: 'tdm', size: 2, hits: 7, biome: 'random', difficulty: 'normal', fill: true };
    this.resetMatch();
  }

  // Per-match state on both sides: input sequencing, the joiner's prediction
  // history and its measure of how evenly snapshots arrive.
  resetMatch() {
    this.snapBuf.length = 0;
    this.playT = undefined;
    this.inputT = 0;
    this.inKey = '';
    this.inRepeat = 0;
    this.inGap = 0;
    this.spCount = 0;          // joiner: special presses so far (a lost packet can't eat one or repeat one)
    this.sentAt = new Map();   // joiner: input seq -> when it was sent
    this.hist = [];            // joiner: own tank's predicted pose each frame { at, x, y, a }
    this.corr = { x: 0, y: 0, a: 0 };   // joiner: correction still to blend in
    this.predReload = 0;       // joiner: local guess at the gun's reload, for instant muzzle flashes
    this.treads = new Map();   // joiner: tank index -> unwrapped tread distance
    this.lastRows = new Map(); // joiner: tank index -> last full snapshot row (wrecks send a stub)
    this.evSeen = new Set();   // joiner: ids of important events already played
    this.evSeq = 0;            // host: ids for important events
    this.evAgain = [];         // host: important events to repeat in the next snapshot
    this.lastArrive = 0;
    this.gapAvg = 1 / NET.snapHz;
    this.gapDev = 0.01;
    this.interp = 0.1;
    this.statT = 0;
    this.corrections = 0;      // diagnostics: how often and how far the host overruled us
    this.corrDist = 0;
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
    this.pendingEv.length = 0;
    this.evQueue.length = 0;
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
    if (m.t === 'data') { this.onPeerMessage(peer, m.b ? b64ToBuf(m.b) : m.d); return; }
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
  // Everyone who will be on the field: the humans in the room, then the bots
  // that fill the rest of the slots. Both sides compute this the same way, so a
  // joiner sees the lineup the host is about to launch.
  lineup() {
    const L = this.lobby, team = MODES[L.mode].teams;
    const players = this.roster.slice(0, NET.maxPlayers);
    const rows = [];
    const bot = (id, t) => ({ id, name: 'AI crew', team: t, bot: true });
    if (team) {
      const used = [0, 0];
      for (const r of players) used[clamp(r.team | 0, 0, 1)]++;
      const size = rulesSize(Math.max(L.size, used[0], used[1]));
      for (let t = 0; t < 2; t++) {
        const mine = players.filter(r => clamp(r.team | 0, 0, 1) === t);
        for (const r of mine) rows.push(Object.assign({}, r, { team: t, bot: false }));
        for (let i = mine.length; i < size; i++) rows.push(bot('b' + t + '_' + i, t));
      }
      return { team: true, size, rows };
    }
    const size = ffaSize(L.mode, Math.max(L.size, players.length));
    players.forEach((r, i) => rows.push(Object.assign({}, r, { team: i, bot: false })));
    for (let i = players.length; i < size; i++) rows.push(bot('b_' + i, i));
    return { team: false, size, rows };
  }

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
    peer.lastSeen = performance.now();
    if (typeof raw !== 'string') {
      // Binary is always a world snapshot from the host.
      if (this.isClient && this.app.game) {
        let m;
        try { m = this.unpackSnapshot(raw, this.app.game); } catch (e) { return; }
        this.onSnapshot(m);
      }
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    switch (m.t) {
      case 'st':
        if (this.isClient) this.applyStats(m.st);
        break;
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
        this.app.startOnline(m.s, 'client');
        break;
      case 'in':
        if (this.isHost) this.applyRemoteInput(peer, m);
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

  everyPeer(msg) {
    if (this.peers.size < 2) { for (const p of this.peers.values()) p.send(msg); return; }
    const s = JSON.stringify(msg), reliable = !NET_UNRELIABLE.has(msg.t);
    for (const p of this.peers.values()) p.sendRaw(s, reliable);
  }

  // ---- host: read remote inputs, publish the world ---------------------------------------
  applyRemoteInput(peer, m) {
    const t = peer.tank;
    if (peer.lastSeq !== undefined && m.q <= peer.lastSeq) return;   // stale packet, the newer one wins
    peer.lastSeq = m.q;
    peer.seqAt = performance.now();
    const d = m.d;
    // The special is a press count, not a flag: a lost packet can't swallow a
    // press and a repeated one can't fire it twice.
    const sp = d[7] | 0, pressed = sp !== (peer.spSeen | 0);
    peer.spSeen = sp;
    if (!t || !t.alive) return;
    t.input.throttle = d[0] / 100;
    t.input.turn = d[1] / 100;
    t.input.aim = d[2] / 1000;
    t.input.fire = !!(d[3] & 1);
    if (pressed) {
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
    this.statT -= dt;
    const fastest = [...this.peers.values()].every(p => p.mode === 'p2p');
    if (this.sendT > 0) return;
    // Snapshots are binary and a 10v10 one fits in a single packet, so even
    // big battles keep the full rate; only the 40-tank royale eases off.
    const busy = game.tanks.length > 24 ? 0.75 : 1;
    const hz = (fastest ? NET.snapHz : NET.relaySnapHz) * busy;
    // Carry the remainder so the rate holds at any frame rate (a 60 fps host
    // would otherwise round every 1/30 s wait up to three frames).
    this.sendT = Math.max(this.sendT + 1 / hz, 0);
    const snap = this.packSnapshot(game);
    for (const p of this.peers.values()) p.sendBin(snap);
    // Kills, deaths and damage change slowly: a few times a second, on their own.
    if (this.statT <= 0) {
      this.statT = NET.statsEvery;
      this.everyPeer({ t: 'st', st: this.packStats(game) });
    }
    this.pingT = (this.pingT || 0) - 1;
    if (this.pingT <= 0) { this.pingT = NET.snapHz * 2; this.everyPeer({ t: 'ping', at: performance.now() }); }
  }

  packStats(g) {
    return g.tanks.map(t => [t.stats.kills | 0, t.stats.deaths | 0, Math.round(t.stats.damage || 0), t.stats.shots | 0, t.stats.hits | 0,
      Math.round(t.stats.convoy || 0), Math.round(t.score || 0), t.level || 1, Math.round(t.stats.xp || 0), Math.round(t.maxHp), t.grenadeAmmo | 0]);
  }

  applyStats(st) {
    const gm = this.app.game;
    if (!gm || !st) return;
    st.forEach((r, i) => {
      const t = gm.tanks[i];
      if (!t) return;
      t.stats.kills = r[0]; t.stats.deaths = r[1]; t.stats.damage = r[2];
      t.stats.shots = r[3]; t.stats.hits = r[4]; t.stats.convoy = r[5];
      t.score = r[6]; t.level = r[7]; t.stats.xp = r[8]; t.maxHp = r[9]; t.grenadeAmmo = r[10];
    });
  }

  // The world as a compact binary packet (see SNAP_* below for the layout): a
  // 10v10 battle is about 0.8 KB, one network packet, where the JSON it replaced
  // was 1.5-2.5 KB and split across two or three. On a channel that never
  // resends, one lost piece used to lose the whole snapshot.
  packSnapshot(g) {
    const w = this.writer || (this.writer = new ByteWriter(2048));
    w.reset();
    w.u8(SNAP_MAGIC);
    w.f64(g.time);
    w.u16(g.tanks.length);
    for (const t of g.tanks) {
      // A wreck only needs its armor and special charge (both shown on its HUD): five bytes.
      if (!t.alive) { w.u8(t.netIdx | 0x80); w.u16(t.hp); w.u16(t.missileCharge); continue; }
      w.u8(t.netIdx);
      w.i16(t.x); w.i16(t.y);
      w.i16(angNorm(t.angle) * 1000); w.i16(angNorm(t.turret) * 1000);
      w.u16(t.hp);
      w.u16((t.alive ? 1 : 0) | (t.input.fire ? 2 : 0) | (t.boostT > 0 ? 4 : 0) | (t.burnT > 0 ? 8 : 0) | (t.repairing ? 16 : 0) | (t.jug ? 32 : 0)
        | (t.shield > 0 ? 64 : 0) | (t.invuln > 0 ? 128 : 0) | (t.flakT > 0 ? 256 : 0) | (t.repairT > 0 ? 512 : 0) | (t.overheatT > 0 ? 1024 : 0));
      // Tread distance only ever moves a little between snapshots: 16 bits,
      // unwrapped against the last value on the far side.
      w.u16(Math.round(t.treadL) & 0xffff); w.u16(Math.round(t.treadR) & 0xffff);
      w.u16(t.missileCharge);
      w.u16(t.reload * 100);
      w.u8(t.heat || 0);
      w.i16(angNorm(t.flakAngle || 0) * 1000);
    }
    const id = o => (o.nid || (o.nid = ++this.oid)) & 0xffff;
    w.u16(g.shells.length);
    for (const x of g.shells) { w.u16(id(x)); w.i16(x.x); w.i16(x.y); w.u8(SHELL_NET.indexOf(x.kind)); w.u16(x.speed); w.i16(angNorm(x.angle) * 1000); }
    w.u16(g.missiles.length);
    for (const x of g.missiles) { w.u16(id(x)); w.i16(x.x); w.i16(x.y); w.u8(MISSILE_NET.indexOf(x.kind)); w.i8(x.owner ? x.owner.netIdx : -1); w.u8((x.blink || 0) * 100); w.i16(angNorm(x.angle) * 1000); }
    w.u16(g.grenades.length);
    for (const x of g.grenades) { w.u16(id(x)); w.i16(x.x); w.i16(x.y); w.i16(angNorm(x.spin) * 1000); w.u16(Math.max(0, x.fuse) * 100); }
    w.u16(g.mines.length);
    for (const x of g.mines) { w.u16(id(x)); w.i16(x.x); w.i16(x.y); w.i8(x.team); w.u8(x.arm > 0 ? 1 : 0); w.u8(x.blink * 100); }
    w.u16(g.smokes.length);
    for (const x of g.smokes) { w.u16(id(x)); w.i16(x.x); w.i16(x.y); w.u16(x.r); w.u16(Math.max(0, x.life) * 100); w.u32(x.seed); }
    w.u16(g.artillery.length);
    for (const x of g.artillery) { w.u16(id(x)); w.i16(x.x); w.i16(x.y); w.i16(x.h); w.i16(x.tx); w.i16(x.ty); w.u16(x.k * 100); w.i16(x.sx); w.i16(x.sy); }
    w.u16(g.airstrikes.length);
    for (const x of g.airstrikes) { w.u16(id(x)); w.i16(x.x); w.i16(x.y); w.i16(angNorm(x.a) * 1000); w.u16(x.t * 100); w.i16(x.along === undefined ? 0 : x.along); w.i8(x.owner ? x.owner.netIdx : -1); }
    // Each joiner's latest input the host has applied, and how long ago it
    // arrived: lets the joiner line the host's answer up with its own past.
    const now = performance.now(), acks = [];
    for (const p of this.peers.values()) if (p.tank && p.lastSeq >= 0) acks.push(p);
    w.u8(acks.length);
    for (const p of acks) { w.u8(p.tank.netIdx); w.u32(p.lastSeq); w.u16(now - p.seqAt); }
    // Objective state and effects vary in shape: a short JSON tail.
    // Kills, captures and round changes ride twice (see NET_KEY_EVENTS), so one
    // lost packet can't drop them; the joiner keeps the first copy it sees.
    const tail = { ob: this.packObjective(g) };
    const fresh = this.pendingEv.splice(0), ev = this.evAgain.length ? this.evAgain.concat(fresh) : fresh;
    this.evAgain = fresh.filter(e => e.n !== undefined);
    if (ev.length) tail.ev = ev;
    w.str(JSON.stringify(tail));
    return w.done();
  }

  // Back into the row arrays the playback code works with (angles in
  // hundredths of a radian, as the JSON snapshots used to carry them).
  unpackSnapshot(buf, g) {
    const r = new ByteReader(buf);
    if (r.u8() !== SNAP_MAGIC) throw new Error('not a snapshot');
    const m = { t: 's', k: r.f64() };
    const tk = m.tk = [];
    const last = this.lastRows || (this.lastRows = new Map());
    for (let n = r.u16(); n > 0; n--) {
      const b0 = r.u8(), idx = b0 & 0x7f;
      if (b0 & 0x80) {
        // Destroyed: where it last stood, not alive, holding its armor and charge.
        const p = last.get(idx), hp = r.u16(), mc = r.u16();
        const t = g.tanks[idx];
        tk.push(p ? [idx, p[1], p[2], p[3], p[4], hp, 0, p[7], p[8], mc, 0, 0, p[12]]
          : [idx, t ? t.x : 0, t ? t.y : 0, t ? t.angle * 100 : 0, t ? t.turret * 100 : 0, hp, 0, 0, 0, mc, 0, 0, 0]);
        continue;
      }
      const x = r.i16(), y = r.i16(), a = r.i16() / 10, tu = r.i16() / 10, hp = r.u16(), fl = r.u16();
      const tl = this.unwrapTread(idx * 2, r.u16()), tr = this.unwrapTread(idx * 2 + 1, r.u16());
      const row = [idx, x, y, a, tu, hp, fl, tl, tr, r.u16(), r.u16(), r.u8(), r.i16() / 10];
      last.set(idx, row);
      tk.push(row);
    }
    m.sh = [];
    for (let n = r.u16(); n > 0; n--) { const id = r.u16(), x = r.i16(), y = r.i16(), k = r.u8(), sp = r.u16(); m.sh.push([id, x, y, k, sp, 0, r.i16() / 10]); }
    m.ms = [];
    for (let n = r.u16(); n > 0; n--) m.ms.push([r.u16(), r.i16(), r.i16(), r.u8(), r.i8(), r.u8(), r.i16() / 10]);
    m.gr = [];
    for (let n = r.u16(); n > 0; n--) m.gr.push([r.u16(), r.i16(), r.i16(), r.i16() / 10, r.u16()]);
    m.mi = [];
    for (let n = r.u16(); n > 0; n--) m.mi.push([r.u16(), r.i16(), r.i16(), r.i8(), r.u8(), r.u8()]);
    m.sm = [];
    for (let n = r.u16(); n > 0; n--) m.sm.push([r.u16(), r.i16(), r.i16(), r.u16(), r.u16(), r.u32()]);
    m.ar = [];
    for (let n = r.u16(); n > 0; n--) m.ar.push([r.u16(), r.i16(), r.i16(), r.i16(), r.i16(), r.i16(), r.u16(), r.i16(), r.i16()]);
    m.as = [];
    for (let n = r.u16(); n > 0; n--) m.as.push([r.u16(), r.i16(), r.i16(), r.i16() / 10, r.u16(), r.i16(), r.i8()]);
    m.ak = [];
    for (let n = r.u8(); n > 0; n--) m.ak.push([r.u8(), r.u32(), r.u16()]);
    const tail = JSON.parse(r.str());
    m.ob = tail.ob;
    m.ev = tail.ev || [];
    return m;
  }

  // A 16-bit tread reading back to the full distance: take the step from the
  // last reading that is under half the 16-bit range.
  unwrapTread(key, v) {
    const prev = this.treads.get(key);
    let full = v;
    if (prev !== undefined) {
      let d = v - (((prev % 65536) + 65536) % 65536);
      if (d > 32767) d -= 65536; else if (d < -32768) d += 65536;
      full = prev + d;
    }
    this.treads.set(key, full);
    return full;
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
  // Called every frame, before the effects layer consumes and clears the list.
  collectEvents(g) {
    if (!this.isHost || this.state !== 'playing' || !g.events.length) return;
    const out = this.pendingEv;
    for (const e of this.packEvents(g)) {
      if (NET_KEY_EVENTS.has(e.type)) e.n = ++this.evSeq;
      out.push(e);
    }
    if (out.length > 500) out.splice(0, out.length - 500);
  }

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
  // Controls go out the moment they change (up to NET.inputHz), a few frames
  // running after a change in case one is lost, and otherwise now and then.
  // Waiting for a fixed 30 Hz tick used to add up to 33 ms before the host
  // even heard about a key press.
  clientInput(dt, tank, game) {
    if (!tank) return;
    const inp = tank.input;
    // A special press is counted here and cleared, as the host's own step would.
    if (inp.missile) {
      this.spCount = (this.spCount + 1) & 255;
      this.spTarget = inp.missileTarget ? game.tanks.indexOf(inp.missileTarget) : -1;
      this.spPoint = inp.specialPoint ? { x: Math.round(inp.specialPoint.x), y: Math.round(inp.specialPoint.y) } : null;
      inp.missile = false;
      inp.specialPoint = null;
    }
    const pt = this.spPoint;
    const d = [
      Math.round(inp.throttle * 100), Math.round(inp.turn * 100), Math.round(inp.aim * 1000),
      inp.fire ? 1 : 0, pt ? pt.x : null, pt ? pt.y : null, this.spCount ? this.spTarget : -1, this.spCount,
    ];
    const key = d.join(',');
    if (key !== this.inKey) { this.inKey = key; this.inRepeat = 3; }
    this.inputT -= dt;
    this.inGap -= dt;
    const relay = !this.hostPeer() || !this.hostPeer().open;
    if (this.inGap > 0 || (this.inRepeat <= 0 && this.inputT > 0)) return;
    this.inRepeat--;
    this.inputT = NET.inputIdle;
    this.inGap = 1 / (relay ? NET.relayInputHz : NET.inputHz) - 0.002;
    const q = ++this.seq, now = performance.now();
    this.sentAt.set(q, now);
    if (this.sentAt.size > 240) for (const k of this.sentAt.keys()) { if (this.sentAt.size <= 180) break; this.sentAt.delete(k); }
    this.everyPeer({ t: 'in', q, d });
  }

  hostPeer() { return this.peers.get(this.hostId); }

  onSnapshot(m) {
    const now = performance.now();
    this.lastSnap = now;
    m.at = now;
    const g = this.app.game;
    if (!g) return;
    // How evenly do snapshots arrive? The playback delay follows: just enough
    // to always have the next one in hand, instead of a fixed tenth of a second.
    if (this.lastArrive) {
      const gap = Math.min(0.5, (now - this.lastArrive) / 1000);
      this.gapAvg += (gap - this.gapAvg) * 0.08;
      this.gapDev += (Math.abs(gap - this.gapAvg) - this.gapDev) * 0.08;
      this.interp = clamp(this.gapAvg * 1.5 + this.gapDev * 3 + 0.008, NET.interpMin, NET.interpMax);
    }
    this.lastArrive = now;
    // Events replay on the host's clock, in step with the world they belong to.
    // Important ones ride in two snapshots in a row; keep the first copy.
    for (const e of m.ev) {
      if (e.n !== undefined) { if (this.evSeen.has(e.n)) continue; this.evSeen.add(e.n); }
      const ev = {};
      for (const k in e) {
        const v = e[k];
        if (v && typeof v === 'object' && v.$ !== undefined) { const t = g.tanks[v.$]; if (!t) { ev.__drop = true; continue; } ev[k] = t; }
        else ev[k] = v;
      }
      if (ev.__drop) continue;
      this.evQueue.push({ k: m.k, ev });
    }
    if (this.evSeen.size > 600) { const keep = [...this.evSeen].slice(-300); this.evSeen = new Set(keep); }
    if (this.evQueue.length > 400) this.evQueue.splice(0, this.evQueue.length - 400);
    this.checkPrediction(m, g);
    const buf = this.snapBuf;
    if (buf.length && m.k < buf[buf.length - 1].k) return;   // a late packet would rewind the world
    buf.push(m);
    if (buf.length > 12) buf.shift();
  }

  // ---- joiner: our own tank ------------------------------------------------------------
  // It runs the real movement code locally so steering is instant. When a
  // snapshot lands, compare the host's version with where *we* were at the
  // matching moment (the input the host last applied, plus how long it has
  // been running): only a real disagreement (a shove, a collision) gets
  // corrected, and that correction is blended in over a few frames. The old
  // way compared against where we are now, so the host's view, a round trip
  // stale, kept dragging the tank back and swallowed the prediction.
  checkPrediction(m, g) {
    const t = g.locals[0];
    if (!t || !t.alive || !m.ak) return;
    const ack = m.ak.find(a => a[0] === t.netIdx), row = m.tk.find(r => r[0] === t.netIdx);
    if (!ack || !row || !(row[6] & 1)) return;
    const sent = this.sentAt.get(ack[1]);
    const H = this.hist;
    if (sent === undefined || H.length < 2) return;
    const when = sent + ack[2];
    // Our predicted pose at that moment.
    let i = H.length - 1;
    while (i > 0 && H[i - 1].at > when) i--;
    const a = H[Math.max(0, i - 1)], b = H[i];
    if (when < a.at - 50 || when > b.at + 100) return;   // outside what we remember
    const f = b.at > a.at ? clamp((when - a.at) / (b.at - a.at), 0, 1) : 1;
    const px = lerp(a.x, b.x, f), py = lerp(a.y, b.y, f), pa = lerpAngle(a.a, b.a, f);
    const ex = row[1] - px, ey = row[2] - py, ea = angDiff(pa, row[3] / 100);
    const e = Math.hypot(ex, ey);
    // Snapshot positions are whole pixels: ignore rounding.
    if (e < 1.5 && Math.abs(ea) < 0.02) return;
    this.corrections++;
    this.corrDist += e;
    if (e > 120) {
      // Far out (respawn, a big shove): take the host's word right away.
      t.x += ex; t.y += ey; t.angle = angNorm(t.angle + ea);
      this.corr.x = 0; this.corr.y = 0; this.corr.a = 0;
      this.hist.length = 0;
      return;
    }
    this.corr.x += ex; this.corr.y += ey; this.corr.a += ea;
    // Everything we predicted after that moment was off by the same amount.
    for (let k = i; k < H.length; k++) if (H[k].at >= when) { H[k].x += ex; H[k].y += ey; H[k].a += ea; }
  }

  // After the local movement step: blend in any correction, remember the pose,
  // and give our own shots their flash and bang without the round trip.
  afterPredict(dt, t, g, canDrive) {
    if (!t) return;
    if (!t.alive) { this.hist.length = 0; this.corr.x = this.corr.y = this.corr.a = 0; this.predReload = 0; return; }
    const c = this.corr, k = 1 - Math.exp(-12 * dt);
    const dx = c.x * k, dy = c.y * k, da = c.a * k;
    t.x += dx; t.y += dy; t.angle = angNorm(t.angle + da);
    c.x -= dx; c.y -= dy; c.a -= da;
    const now = performance.now();
    this.hist.push({ at: now, x: t.x + c.x, y: t.y + c.y, a: t.angle + c.a });
    while (this.hist.length > 2 && now - this.hist[0].at > 1500) this.hist.shift();
    this.predictShot(dt, t, g, canDrive);
  }

  // The host decides what a shot hits; the muzzle flash, recoil and sound are
  // ours to show at once. The host's echo of our own shot is skipped.
  predictShot(dt, t, g, canDrive) {
    this.predReload = Math.max(0, this.predReload - dt);
    const w = t.loadout.weapon;
    if (!canDrive || !t.input.fire || this.predReload > 0 || t.overheatT > 0 || g.phase !== 'live') return;
    if (w === 'wire' && g.missiles.some(m => m.wire && m.owner === t)) return;
    this.predReload = t.reloadTime;
    t.recoil = 1;
    const a = t.turret, ca = Math.cos(a), sa = Math.sin(a), L = TANK.barrelLength * t.scale, s = t.scale;
    const muzzles = w === 'double' ? [[t.x + ca * L - sa * 5.5 * s, t.y + sa * L + ca * 5.5 * s, a], [t.x + ca * L + sa * 5.5 * s, t.y + sa * L - ca * 5.5 * s, a]]
      : w === 'twin' ? [[t.x + ca * L, t.y + sa * L, a], [t.x - ca * L * 0.92, t.y - sa * L * 0.92, a + Math.PI]]
      : w === 'longgun' ? [[t.x + ca * L * 1.6, t.y + sa * L * 1.6, a]]
      : [[t.x + ca * L, t.y + sa * L, a]];
    g.events.push({ type: 'shot', x: muzzles[0][0], y: muzzles[0][1], angle: a, tank: t, weapon: w, muzzles, predicted: true });
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
    const target = newest.k - this.interp;
    if (this.playT === undefined || this.playT > newest.k || this.playT < target - 0.6) this.playT = target;
    else {
      // Drift gently toward the target instead of jumping: a step early or late
      // is far less visible than a snap.
      const off = target - this.playT;
      this.playT += dt * clamp(1 + off * 2.5, 0.75, 1.35);
    }
    const t0 = this.playT;
    const mine = g.locals[0];
    // Release the effects whose moment has arrived.
    while (this.evQueue.length && this.evQueue[0].k <= t0) {
      const ev = this.evQueue.shift().ev;
      // Our own gun already flashed when we pulled the trigger (predictShot).
      if (ev.type === 'shot' && ev.tank === mine && ev.weapon !== 'coaxmg') continue;
      // A few things the effects layer reads off the tank itself.
      if (ev.type === 'upgrade' && ev.tank && ev.slot) { ev.tank.loadout[ev.slot] = ev.id; ev.tank.recalc(g.baseHp); }
      if (ev.type === 'hit' && ev.target) ev.target.flash = 1;
      if (ev.type === 'shot' && ev.tank) ev.tank.recoil = 1;
      if (ev.type === 'respawn' && ev.tank) ev.tank.spawnFx = 1;
      g.events.push(ev);
    }
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) if (buf[i].k <= t0 && buf[i + 1].k >= t0) { a = buf[i]; b = buf[i + 1]; break; }
    const span = b.k - a.k;
    const f = span > 1e-4 ? clamp((t0 - a.k) / span, 0, 1) : 1;
    g.time = t0;
    // Recoil, hit flash and the respawn shimmer are set by events and normally
    // wound down by the physics step, which a joiner doesn't run.
    for (const t of g.tanks) {
      if (t === mine) continue;   // our own tank runs the real physics step
      t.recoil = Math.max(0, t.recoil - dt * 4.5);
      t.flash = Math.max(0, t.flash - dt * 6);
      t.spawnFx = Math.max(0, t.spawnFx - dt * 1.5);
    }
    const prev = new Map();
    for (const row of a.tk) prev.set(row[0], row);
    for (const row of b.tk) {
      const t = g.tanks[row[0]];
      if (!t) continue;
      const p = prev.get(row[0]) || row;
      const own = t === mine;
      const px = lerp(p[1], row[1], f), py = lerp(p[2], row[2], f);
      const pa = lerpAngle(p[3] / 100, row[3] / 100, f), pt = lerpAngle(p[4] / 100, row[4] / 100, f);
      if (!own) {
        t.vx = span > 1e-4 ? (row[1] - p[1]) / span : 0;
        t.vy = span > 1e-4 ? (row[2] - p[2]) / span : 0;
      }
      t.hp = row[5];
      const flags = row[6];
      const wasAlive = t.alive;
      t.alive = !!(flags & 1);
      // Our own trigger is our own: the host's copy is a round trip old.
      if (!own) t.input.fire = !!(flags & 2);
      t.boostT = (flags & 4) ? 1 : 0;
      t.burnT = (flags & 8) ? 1 : 0;
      t.repairing = !!(flags & 16);
      // Timed effects arrive as on/off: hold them up while the host says so.
      t.shield = (flags & 64) ? 0.6 : 0;
      t.invuln = (flags & 128) ? 0.6 : 0;
      t.flakT = (flags & 256) ? 1 : 0;
      t.repairT = (flags & 512) ? 1 : 0;
      t.overheatT = (flags & 1024) ? 1 : 0;
      t.reload = row[10] / 100;
      t.heat = row[11];
      t.flakAngle = row[12] / 100;
      if (!own) { t.treadL = lerp(p[7], row[7], f); t.treadR = lerp(p[8], row[8], f); }
      t.missileCharge = row[9];
      const wasJug = t.jug;
      t.jug = !!(flags & 32);
      if (t.jug !== wasJug) { t.jugHpMul = t.maxHp / Math.max(1, g.baseHp); t.recalc(g.baseHp); }
      // Respawned: straight to the spawn point, no sliding in from the grave.
      if (!wasAlive && t.alive) { t.x = row[1]; t.y = row[2]; t.angle = row[3] / 100; t.turret = row[4] / 100; t.speed = 0; }
      // Our own tank drives itself (App.predictLocal) and is corrected in checkPrediction.
      if (own && t.alive) continue;
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
}

// Shell and missile kinds, by index, so snapshots stay small.
const SHELL_NET = ['shell', 'bullet', 'flame', 'long', 'hesh', 'coax'];
const MISSILE_NET = ['missile', 'rocket', 'salvo', 'wire'];
// Events that are either local-only or rebuilt from the snapshot itself.
const NET_SKIP_EVENTS = new Set(['missile_ready']);
// Events worth sending twice: missing one would leave the kill feed, score or
// round state wrong rather than just skip a puff of smoke.
const NET_KEY_EVENTS = new Set(['kill', 'announce', 'flag', 'hill', 'jug', 'round_end', 'round_start', 'escort_round', 'escort_end',
  'match_over', 'upgrade', 'levelup', 'streak', 'respawn', 'go', 'zone']);
// Messages that go on the fire-and-forget channel; everything else must arrive.
const NET_UNRELIABLE = new Set(['in', 'ping', 'pong', 'st']);
const SNAP_MAGIC = 0x53;   // first byte of a binary snapshot

// Little-endian packing for snapshots. Numbers are rounded and clamped to the
// field's range, so a stray value can't wrap into nonsense.
class ByteWriter {
  constructor(n) { this.buf = new ArrayBuffer(n); this.dv = new DataView(this.buf); this.o = 0; }
  reset() { this.o = 0; }
  need(n) {
    if (this.o + n <= this.buf.byteLength) return;
    const nb = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.o + n));
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.o));
    this.buf = nb; this.dv = new DataView(nb);
  }
  u8(v) { this.need(1); this.dv.setUint8(this.o, clamp(Math.round(v) || 0, 0, 255)); this.o += 1; }
  i8(v) { this.need(1); this.dv.setInt8(this.o, clamp(Math.round(v) || 0, -128, 127)); this.o += 1; }
  u16(v) { this.need(2); this.dv.setUint16(this.o, clamp(Math.round(v) || 0, 0, 65535), true); this.o += 2; }
  i16(v) { this.need(2); this.dv.setInt16(this.o, clamp(Math.round(v) || 0, -32768, 32767), true); this.o += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.o, Math.max(0, Math.round(v) || 0) >>> 0, true); this.o += 4; }
  f64(v) { this.need(8); this.dv.setFloat64(this.o, v, true); this.o += 8; }
  str(s) {
    const b = (this.enc || (this.enc = new TextEncoder())).encode(s);
    this.u16(b.length);
    this.need(b.length);
    new Uint8Array(this.buf, this.o, b.length).set(b);
    this.o += b.length;
  }
  done() { return this.buf.slice(0, this.o); }
}

class ByteReader {
  constructor(buf) { this.dv = new DataView(buf); this.buf = buf; this.o = 0; }
  u8() { return this.dv.getUint8(this.o++); }
  i8() { return this.dv.getInt8(this.o++); }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  str() {
    const n = this.u16(), s = (ByteReader.dec || (ByteReader.dec = new TextDecoder())).decode(new Uint8Array(this.buf, this.o, n));
    this.o += n;
    return s;
  }
}

// Binary through the Supabase relay, which only carries JSON.
function bufToB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(s) {
  const bin = atob(s), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}
const NET_REF_FIELDS = new Set(['tank', 'target', 'shooter', 'victim', 'killer', 'owner', 'missile', 'strike']);
