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
  snapHz: 15,          // world updates per second over a direct connection
  relaySnapHz: 9,      // slower when bouncing through Supabase
  inputHz: 30,
  p2pTimeout: 9000,    // give up on a direct connection after this and relay
  interp: 0.12,        // render this far behind the host, in seconds
  codeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  modes: ['tdm', 'oneshot', 'koth', 'ctf', 'br'],
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
    this.sb = window.supabase.createClient(NET.url, NET.anon, { realtime: { params: { eventsPerSecond: 40 } } });
    this.channel = this.sb.channel('ic-' + code, { config: { broadcast: { self: false } } });
    this.channel.on('broadcast', { event: 'sig' }, m => this.onSig(m.payload));
    const status = await new Promise(res => {
      const done = s => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) res(s); };
      this.channel.subscribe(done);
      setTimeout(() => res('TIMED_OUT'), 12000);
    });
    if (status !== 'SUBSCRIBED') throw new Error('no-room');
  }

  sig(msg) {
    if (!this.channel) return;
    msg.from = this.me;
    this.channel.send({ type: 'broadcast', event: 'sig', payload: msg });
  }

  // ---- host / join ---------------------------------------------------------------------
  async host(name) {
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
    if (!quiet && this.channel) this.sig({ t: 'bye' });
    this.reset();
    try { if (this.channel) this.channel.unsubscribe(); } catch (e) {}
    try { if (this.sb) this.sb.removeAllChannels(); } catch (e) {}
    this.channel = null;
    this.sb = null;
    this.role = null;
    this.state = 'off';
    this.code = '';
  }

  // ---- signalling ----------------------------------------------------------------------
  async onSig(m) {
    if (!m || m.from === this.me) return;
    if (m.to && m.to !== this.me) return;
    if (m.t === 'hello' && this.isHost) {
      if (this.state !== 'lobby') return this.sig({ t: 'busy', to: m.from });
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
      peer.send({ t: 'name', name: this.name });
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
    const rows = [{ id: this.me, name: this.name, team: this.myTeam || 0, you: true, host: this.isHost, mode: 'host', ping: 0 }];
    for (const p of this.peers.values()) rows.push({ id: p.id, name: p.name, team: p.team, you: false, host: false, mode: p.mode, ping: Math.round(p.ping) });
    this.roster = rows;
  }

  sendLobby() {
    if (!this.isHost) return;
    this.refreshRoster();
    const msg = { t: 'lobby', roster: this.roster.map(r => ({ id: r.id, name: r.name, team: r.team, host: r.host })), set: this.lobby };
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
    const size = team ? Math.max(L.size, Math.ceil(players.length / 2)) : Math.max(L.size, players.length);
    const slots = [];
    if (team) {
      const used = [0, 0];
      for (const r of players) {
        const t = clamp(r.team | 0, 0, 1);
        const idx = used[t]++;
        slots.push({ id: r.id, name: r.name, team: t, idx: Math.min(idx, size - 1) });
      }
    } else {
      players.forEach((r, i) => slots.push({ id: r.id, name: r.name, team: i, idx: i }));
    }
    const settings = {
      mode: L.mode, size, hits: L.hits, difficulty: L.difficulty,
      biome: L.biome === 'random' ? randPick(BIOME_IDS) : L.biome,
      seed: (Math.random() * 1e9) >>> 0,
      progression: 'standard', netSlots: slots,
    };
    this.state = 'playing';
    for (const p of this.peers.values()) p.send({ t: 'start', s: settings });
    this.app.startOnline(settings, 'host');
  }

  // ---- messages between peers -----------------------------------------------------------
  onPeerMessage(peer, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    peer.lastSeen = performance.now();
    switch (m.t) {
      case 'name':
        peer.name = (m.name || 'Player').slice(0, 14);
        this.refreshRoster();
        this.sendLobby();
        this.app.ui.renderOnline();
        break;
      case 'lobby':
        this.roster = m.roster.map(r => ({ ...r, you: r.id === this.me, mode: peer.mode, ping: Math.round(peer.ping) }));
        this.lobby = m.set;
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
        Math.round(t.hp), (t.alive ? 1 : 0) | (t.input.fire ? 2 : 0) | (t.boostT > 0 ? 4 : 0) | (t.burnT > 0 ? 8 : 0) | (t.repairing ? 16 : 0),
        Math.round(t.treadL), Math.round(t.treadR), Math.round(t.missileCharge)]);
    }
    const sh = g.shells.map(s => [Math.round(s.x), Math.round(s.y), Math.round(s.angle * 100), SHELL_NET.indexOf(s.kind), Math.round(s.speed)]);
    const ms = g.missiles.map(m => [Math.round(m.x), Math.round(m.y), Math.round(m.angle * 100), MISSILE_NET.indexOf(m.kind), m.owner ? m.owner.netIdx : -1, Math.round((m.blink || 0) * 100)]);
    const gr = g.grenades.map(x => [Math.round(x.x), Math.round(x.y), Math.round(x.spin * 100), Math.round(x.fuse * 100)]);
    const mi = g.mines.map(x => [Math.round(x.x), Math.round(x.y), x.team, x.arm > 0 ? 1 : 0, Math.round(x.blink * 100)]);
    const sm = g.smokes.map(x => [Math.round(x.x), Math.round(x.y), Math.round(x.r), Math.round(x.life * 100), x.seed]);
    const ar = g.artillery.map(x => [Math.round(x.x), Math.round(x.y), Math.round(x.h), Math.round(x.tx), Math.round(x.ty), Math.round(x.k * 100), Math.round(x.sx), Math.round(x.sy)]);
    const as = g.airstrikes.map(x => [Math.round(x.x), Math.round(x.y), Math.round(x.a * 100), Math.round(x.t * 100), x.along === undefined ? 0 : Math.round(x.along), x.owner ? x.owner.netIdx : -1]);
    return { t: 's', k: g.time, tk, sh, ms, gr, mi, sm, ar, as, ob: this.packObjective(g), ev: this.packEvents(g) };
  }

  packObjective(g) {
    const o = { ph: g.phase, cl: Math.round(g.clock), sc: g.teams.map(t => Math.round(t.score)), it: Math.round(g.introT * 10), ot: Math.round(g.overT * 10), wn: g.winner };
    const m = g.mode;
    if (m instanceof KOTHMode) o.k = [m.owner, Math.round(m.progress * 100), m.contested ? 1 : 0, m.capTeam === undefined ? -1 : m.capTeam];
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
    m.at = performance.now();
    this.snapBuf.push(m);
    if (this.snapBuf.length > 12) this.snapBuf.shift();
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
      if (!ev.__drop) g.events.push(ev);
    }
  }

  // Rebuild the world from the two snapshots either side of "now minus a little".
  clientFrame(dt, g) {
    const buf = this.snapBuf;
    if (!buf.length) return;
    const now = performance.now() - NET.interp * 1000;
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) if (buf[i].at <= now && buf[i + 1].at >= now) { a = buf[i]; b = buf[i + 1]; break; }
    const span = b.at - a.at;
    const f = span > 0 ? clamp((now - a.at) / span, 0, 1) : 1;
    const mine = g.locals[0];
    for (const row of b.tk) {
      const t = g.tanks[row[0]];
      if (!t) continue;
      const prev = a.tk.find(r => r[0] === row[0]) || row;
      const px = lerp(prev[1], row[1], f), py = lerp(prev[2], row[2], f);
      const pa = lerpAngle(prev[3] / 100, row[3] / 100, f), pt = lerpAngle(prev[4] / 100, row[4] / 100, f);
      t.vx = (row[1] - prev[1]) / Math.max(0.001, span / 1000);
      t.vy = (row[2] - prev[2]) / Math.max(0.001, span / 1000);
      t.hp = row[5];
      const flags = row[6];
      const wasAlive = t.alive;
      t.alive = !!(flags & 1);
      t.input.fire = !!(flags & 2);
      t.boostT = (flags & 4) ? 1 : 0;
      t.burnT = (flags & 8) ? 1 : 0;
      t.repairing = !!(flags & 16);
      t.treadL = row[7]; t.treadR = row[8];
      t.missileCharge = row[9];
      if (!wasAlive && t.alive) { t.x = px; t.y = py; }        // respawned: no sliding in from the grave
      if (t === mine && t.alive) { this.reconcile(t, px, py, pa); continue; }
      t.x = px; t.y = py; t.angle = pa; t.turret = pt;
      t.speed = Math.hypot(t.vx, t.vy);
    }
    this.applyList(g.shells, b.sh, (o, r) => { o.x = r[0]; o.y = r[1]; o.angle = r[2] / 100; o.kind = SHELL_NET[r[3]]; o.speed = r[4]; o.bullet = o.kind === 'bullet' || o.kind === 'coax'; o.flame = o.kind === 'flame'; o.hesh = o.kind === 'hesh'; o.age = o.age || 0.05; o.radius = 4; });
    this.applyList(g.missiles, b.ms, (o, r) => { o.x = r[0]; o.y = r[1]; o.angle = r[2] / 100; o.kind = MISSILE_NET[r[3]]; o.rocket = o.kind === 'rocket' || o.kind === 'salvo'; o.wire = o.kind === 'wire'; o.owner = g.tanks[r[4]] || null; o.blink = r[5] / 100; o.team = o.owner ? o.owner.team : -1; o.age = o.age || 0.1; o.alive = true; });
    this.applyList(g.grenades, b.gr, (o, r) => { o.x = r[0]; o.y = r[1]; o.spin = r[2] / 100; o.fuse = r[3] / 100; o.alive = true; });
    this.applyList(g.mines, b.mi, (o, r) => { o.x = r[0]; o.y = r[1]; o.team = r[2]; o.arm = r[3]; o.blink = r[4] / 100; o.alive = true; o.owner = o.owner || { color: (g.teams[r[2]] || g.teams[0] || {}).color || TEAM_COLORS[0] }; });
    this.applyList(g.smokes, b.sm, (o, r) => { o.x = r[0]; o.y = r[1]; o.r = r[2]; o.life = r[3] / 100; o.max = SMOKE.life; o.seed = r[4]; });
    this.applyList(g.artillery, b.ar, (o, r) => { o.x = r[0]; o.y = r[1]; o.h = r[2]; o.tx = r[3]; o.ty = r[4]; o.k = r[5] / 100; o.sx = r[6]; o.sy = r[7]; o.peak = Math.max(1, o.h || 1); });
    this.applyList(g.airstrikes, b.as, (o, r) => { o.x = r[0]; o.y = r[1]; o.a = r[2] / 100; o.t = r[3] / 100; o.along = r[4]; o.owner = g.tanks[r[5]] || g.tanks[0]; });
    this.applyObjective(g, b.ob);
  }

  applyList(list, rows, fill) {
    list.length = rows.length;
    for (let i = 0; i < rows.length; i++) {
      if (!list[i]) list[i] = {};
      fill(list[i], rows[i]);
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
    else if (o.f && m instanceof CTFMode) o.f.forEach((r, i) => { const f = m.flags[i]; if (!f) return; f.x = r[0]; f.y = r[1]; f.carrier = r[2] >= 0 ? g.tanks[r[2]] : null; f.home = !!r[3]; f.dropT = r[4] / 10; });
    else if (o.z && m instanceof BRMode) { const z = m.zone; z.x = o.z[0]; z.y = o.z[1]; z.r = o.z[2]; z.tx = o.z[3]; z.ty = o.z[4]; z.tr = o.z[5]; m.phase = o.z[6]; m.state = o.z[7] ? 'shrink' : 'wait'; m.timer = o.z[8] / 10; }
    // Carried flags ride along with their carrier.
    for (const t of g.tanks) t.carrying = null;
    if (o.f && m instanceof CTFMode) for (const f of m.flags) if (f.carrier) f.carrier.carrying = f;
  }

  // Our own tank is simulated locally so steering feels instant; nudge it back
  // toward the host's version instead of snapping.
  reconcile(t, x, y, a) {
    const d = dist(t.x, t.y, x, y);
    if (d > 90) { t.x = x; t.y = y; t.angle = a; return; }
    const k = clamp(d / 90, 0, 1) * 0.25 + 0.05;
    t.x = lerp(t.x, x, k);
    t.y = lerp(t.y, y, k);
    t.angle = lerpAngle(t.angle, a, 0.12);
  }
}

// Shell and missile kinds, by index, so snapshots stay small.
const SHELL_NET = ['shell', 'bullet', 'flame', 'long', 'hesh', 'coax'];
const MISSILE_NET = ['missile', 'rocket', 'salvo', 'wire'];
// Events that are either local-only or rebuilt from the snapshot itself.
const NET_SKIP_EVENTS = new Set(['missile_ready', 'levelup', 'upgrade']);
const NET_REF_FIELDS = new Set(['tank', 'target', 'shooter', 'victim', 'killer', 'owner', 'missile', 'strike']);
