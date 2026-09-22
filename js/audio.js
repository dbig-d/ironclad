'use strict';
// ---------------------------------------------------------------------------
// Synthesized sound effects. No audio files: everything is shaped noise and
// oscillators. Positional volume/pan relative to the camera.
// ---------------------------------------------------------------------------

class Sfx {
  constructor() {
    this.ac = null;
    this.volume = 0.7;
    this.muted = false;
    this.budget = 0;
    this.baked = {};      // name -> [AudioBuffer variations]
    this.pending = new Map();  // sounds waiting for a quiet moment to bake
    this.noBake = false;
  }

  unlock() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ac = new AC();
    this.master = this.ac.createGain();
    this.comp = this.ac.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 6;
    this.master.connect(this.comp);
    this.comp.connect(this.ac.destination);
    this.applyVolume();
    const len = this.ac.sampleRate;
    this.noise = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startEngine();
    this.warmCommon();
  }

  applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume * 0.8;
  }
  setVolume(v) { this.volume = v; this.applyVolume(); }
  toggleMute() { this.muted = !this.muted; this.applyVolume(); return this.muted; }

  // ---- building blocks ----------------------------------------------------------------
  out(vol, pan) {
    const g = this.ac.createGain();
    g.gain.value = vol;
    if (this.ac.createStereoPanner) {
      const p = this.ac.createStereoPanner();
      p.pan.value = clamp(pan || 0, -0.9, 0.9);
      g.connect(p);
      p.connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  noiseBurst(dest, dur, type, f0, f1, gain, q = 0.8, delay = 0) {
    if (this.dry) { this.end = Math.max(this.end, delay + dur + 0.05); return; }
    const ac = this.ac, t = ac.currentTime + delay;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rand(0.85, 1.15);
    const f = ac.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t, rand(0, 0.5));
    src.stop(t + dur + 0.05);
  }

  tone(dest, dur, type, f0, f1, gain, delay = 0, attack = 0.005) {
    if (this.dry) { this.end = Math.max(this.end, delay + dur + 0.05); return; }
    const ac = this.ac, t = ac.currentTime + delay;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Distance attenuation from the nearest listener (camera). With two
  // split-screen listeners, panning is disabled since left/right is ambiguous.
  spatial(x, y, listeners, range = 1400) {
    if (!listeners) return { vol: 1, pan: 0 };
    const list = Array.isArray(listeners) ? listeners : [listeners];
    let near = list[0], d = Infinity;
    for (const l of list) {
      const dl = dist(x, y, l.x, l.y);
      if (dl < d) { d = dl; near = l; }
    }
    return { vol: Math.pow(clamp(1 - d / range, 0, 1), 1.4), pan: list.length > 1 ? 0 : (x - near.x) / 700 };
  }

  // ---- sounds ---------------------------------------------------------------------------
  // The sounds any battle will fire within seconds.
  warmCommon() {
    this.warm(['shot', 'hit', 'explosion', 'ricochet', 'bounce', 'pickup', 'click', 'spawn', 'death', 'mboom']);
  }

  play(name, x, y, listener, extra) {
    if (!this.ac || this.muted || this.ac.state !== 'running') return;
    const range = name === 'explosion' || name === 'mboom' || name === 'longgun' || name === 'bomb' ? 2200 : name === 'plane' ? 3200 : name === 'mbeep' || name === 'mg' || name === 'flame' || name === 'coaxmg' || name === 'bounce' ? 900 : 1400;
    const sp = x === undefined ? { vol: 1, pan: 0 } : this.spatial(x, y, listener, range);
    if (sp.vol < 0.02) return;
    if (this.budget > (LOW_MEM ? 7 : 10)) return;
    this.budget++;
    // Replay a pre-rendered take when there is one; otherwise build it live (and bake it for next time).
    const key = extra && extra.mine ? name + ':mine' : name, takes = this.baked[key];
    const o = this.out(sp.vol, sp.pan);
    if (takes && takes.length) {
      const src = this.ac.createBufferSource();
      src.buffer = takes[(Math.random() * takes.length) | 0];
      src.connect(o);
      src.start();
      return;
    }
    if (!takes && !this.noBake && !this.pending.has(key)) this.pending.set(key, { name, extra });
    this.synth(name, o, extra);
  }

  // Bake one queued sound. Called when there is time to spare — between
  // rounds, on menus, during the countdown — never mid-battle.
  pumpBake() {
    if (this.noBake || !this.ac || this.ac.state !== 'running' || !this.pending.size) return false;
    const key = this.pending.keys().next().value, job = this.pending.get(key);
    this.pending.delete(key);
    if (this.baked[key] && this.baked[key].length) return false;
    this.bake(key, job.name, job.extra);
    return true;
  }

  // Queue the sounds a battle always needs, so the first shot is never the one
  // that pays for them.
  warm(names) {
    for (const n of names) if (!this.baked[n] && !this.pending.has(n)) this.pending.set(n, { name: n, extra: null });
  }

  // Render a sound offline into a few buffers (the noise and pitch jitter make each take differ).
  bake(key, name, extra) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const takes = this.baked[key] = [];
    if (!OAC) { this.noBake = true; return; }
    const live = this.ac;
    try {
      this.dry = true; this.end = 0;
      this.synth(name, null, extra);
      this.dry = false;
      const len = Math.max(1, Math.ceil(this.end * live.sampleRate));
      for (let v = 0; v < 3; v++) {
        const off = new OAC(1, len, live.sampleRate);
        this.ac = off;
        this.synth(name, off.destination, extra);
        this.ac = live;
        const done = buf => { if (buf) takes.push(buf); };
        const p = off.startRendering();
        if (p && p.then) p.then(done, () => {});
        else off.oncomplete = e => done(e.renderedBuffer);
      }
    } catch (e) {
      this.noBake = true;
    } finally {
      this.ac = live;
      this.dry = false;
    }
  }

  synth(name, o, extra) {
    switch (name) {
      case 'shot': {
        const mine = extra && extra.mine;
        this.noiseBurst(o, 0.35, 'lowpass', 3200, 240, mine ? 0.9 : 0.6, 0.7);
        this.noiseBurst(o, 0.05, 'highpass', 2500, 1800, 0.35);
        this.tone(o, 0.22, 'sine', 120, 42, mine ? 0.9 : 0.55);
        break;
      }
      case 'explosion':
        this.noiseBurst(o, 1.4, 'lowpass', 1400, 90, 1.0, 0.6);
        this.noiseBurst(o, 0.5, 'bandpass', 900, 300, 0.5, 1.2, 0.04);
        this.tone(o, 0.8, 'sine', 70, 28, 1.0);
        break;
      case 'hit':
        this.tone(o, 0.16, 'triangle', 620, 380, 0.45);
        this.tone(o, 0.1, 'square', 1480, 900, 0.1);
        this.noiseBurst(o, 0.08, 'bandpass', 3200, 2000, 0.4, 2);
        break;
      case 'wall':
        this.noiseBurst(o, 0.18, 'lowpass', 1200, 200, 0.5);
        this.tone(o, 0.1, 'sine', 160, 70, 0.25);
        break;
      case 'shield':
        this.tone(o, 0.18, 'sine', 900, 1500, 0.2);
        break;
      case 'fizzle':
        this.noiseBurst(o, 0.12, 'bandpass', 700, 400, 0.12, 1.5);
        break;
      case 'mg':
        this.noiseBurst(o, 0.07, 'bandpass', 2600, 1400, 0.35, 1.4);
        this.tone(o, 0.05, 'square', 180, 90, 0.08);
        break;
      case 'rocket':
        this.noiseBurst(o, 0.5, 'bandpass', 500, 1800, 0.5, 1.1);
        this.tone(o, 0.25, 'sine', 110, 45, 0.6);
        break;
      case 'minedrop':
        this.tone(o, 0.08, 'triangle', 240, 160, 0.3);
        this.noiseBurst(o, 0.08, 'lowpass', 900, 300, 0.25);
        break;
      case 'arty':
        this.tone(o, 0.2, 'sine', 95, 50, 0.7);
        this.noiseBurst(o, 0.18, 'lowpass', 1200, 300, 0.5);
        break;
      case 'whistle':
        this.tone(o, 0.9, 'sine', 1800, 700, 0.07, 0, 0.2);
        break;
      case 'smoke':
        this.noiseBurst(o, 1.2, 'highpass', 1800, 3000, 0.35, 0.7);
        break;
      case 'levelup':
        [660, 880, 1175].forEach((f, i) => this.tone(o, 0.22, 'triangle', f, f, 0.22, i * 0.08));
        break;
      case 'upgrade':
        this.tone(o, 0.12, 'triangle', 1320, 1320, 0.2);
        this.tone(o, 0.2, 'sine', 1760, 1760, 0.14, 0.07);
        break;
      case 'overheat':
        this.noiseBurst(o, 0.6, 'highpass', 3000, 5000, 0.25, 0.8);
        this.tone(o, 0.3, 'sawtooth', 300, 150, 0.08);
        break;
      case 'horn':
        this.tone(o, 0.45, 'sawtooth', 220, 218, 0.12);
        this.tone(o, 0.45, 'sawtooth', 277, 275, 0.1);
        break;
      case 'streak':
        [523, 784].forEach((f, i) => this.tone(o, 0.18, 'square', f, f, 0.08, i * 0.1));
        break;
      case 'missile':
        this.noiseBurst(o, 0.7, 'bandpass', 380, 2400, 0.55, 1.2);
        this.noiseBurst(o, 0.25, 'lowpass', 1400, 200, 0.5);
        this.tone(o, 0.3, 'sine', 90, 40, 0.5);
        break;
      case 'flame':
        this.noiseBurst(o, 0.16, 'bandpass', 700, 420, 0.22, 0.6);
        break;
      case 'longgun':
        this.noiseBurst(o, 0.5, 'lowpass', 4200, 200, 1.0, 0.7);
        this.noiseBurst(o, 0.07, 'highpass', 3200, 2200, 0.5);
        this.tone(o, 0.32, 'sine', 95, 34, 0.9);
        break;
      case 'ram':
        this.noiseBurst(o, 0.3, 'lowpass', 900, 120, 0.9, 0.9);
        this.tone(o, 0.25, 'square', 140, 60, 0.18);
        this.tone(o, 0.14, 'triangle', 820, 540, 0.22);
        break;
      case 'repairkit':
        this.tone(o, 0.1, 'square', 880, 880, 0.06);
        this.tone(o, 0.1, 'square', 1175, 1175, 0.06, 0.1);
        this.noiseBurst(o, 0.8, 'highpass', 4000, 6000, 0.12, 1, 0.1);
        break;
      case 'overdrive':
        this.tone(o, 0.9, 'sawtooth', 60, 180, 0.18, 0, 0.05);
        this.noiseBurst(o, 0.6, 'bandpass', 300, 900, 0.3, 1.2);
        break;
      case 'round':
        this.tone(o, 0.3, 'triangle', 392, 392, 0.25);
        this.tone(o, 0.5, 'triangle', 523, 523, 0.25, 0.22);
        break;
      case 'star':
        this.tone(o, 0.25, 'triangle', 1046, 1046, 0.22);
        this.tone(o, 0.35, 'sine', 1568, 1568, 0.14, 0.06);
        break;
      case 'coin':
        this.tone(o, 0.08, 'square', 988, 988, 0.07);
        this.tone(o, 0.22, 'square', 1318, 1318, 0.07, 0.07);
        break;
      case 'mbeep':
        this.tone(o, 0.05, 'sine', 1560, 1560, 0.14);
        break;
      case 'mboom':
        this.noiseBurst(o, 1.0, 'lowpass', 1800, 110, 0.9, 0.6);
        this.tone(o, 0.6, 'sine', 80, 32, 0.8);
        break;
      case 'ready':
        this.tone(o, 0.09, 'triangle', 880, 880, 0.18);
        this.tone(o, 0.16, 'triangle', 1320, 1320, 0.18, 0.08);
        break;
      case 'hitmarker':
        this.tone(o, 0.06, 'square', 1900, 1900, 0.06);
        break;
      case 'kill':
        this.tone(o, 0.12, 'triangle', 988, 988, 0.22);
        this.tone(o, 0.22, 'triangle', 1318, 1318, 0.22, 0.09);
        break;
      case 'objective':
        this.tone(o, 0.18, 'sine', 523, 523, 0.3);
        this.tone(o, 0.18, 'sine', 659, 659, 0.3, 0.12);
        this.tone(o, 0.35, 'sine', 784, 784, 0.3, 0.24);
        break;
      case 'alarm':
        this.tone(o, 0.25, 'sawtooth', 440, 330, 0.12);
        this.tone(o, 0.25, 'sawtooth', 440, 330, 0.12, 0.3);
        break;
      case 'beep':
        this.tone(o, 0.12, 'sine', 660, 660, 0.3);
        break;
      case 'go':
        this.tone(o, 0.4, 'sine', 990, 990, 0.35);
        this.tone(o, 0.4, 'sine', 1320, 1320, 0.2);
        break;
      case 'click':
        this.tone(o, 0.05, 'sine', 1200, 900, 0.12);
        break;
      case 'victory':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(o, 0.5, 'triangle', f, f, 0.25, i * 0.13));
        break;
      case 'coaxmg':
        this.noiseBurst(o, 0.05, 'bandpass', 3000, 1700, 0.2, 1.4);
        break;
      case 'hesh':
        this.noiseBurst(o, 0.4, 'lowpass', 2400, 160, 0.9, 0.7);
        this.tone(o, 0.3, 'sine', 100, 36, 0.85);
        this.tone(o, 0.08, 'triangle', 420, 300, 0.12);
        break;
      case 'heshhit':
        this.noiseBurst(o, 0.45, 'lowpass', 1500, 140, 0.6, 0.7);
        this.tone(o, 0.3, 'sine', 95, 40, 0.5);
        break;
      case 'wire':
        this.noiseBurst(o, 0.8, 'bandpass', 300, 1300, 0.45, 1.1);
        this.tone(o, 0.25, 'sine', 80, 40, 0.45);
        this.tone(o, 0.5, 'sawtooth', 520, 640, 0.03, 0.1, 0.1);
        break;
      case 'grenade':
        this.tone(o, 0.12, 'sine', 320, 110, 0.4);
        this.noiseBurst(o, 0.1, 'lowpass', 1400, 400, 0.3);
        break;
      case 'bounce':
        this.tone(o, 0.07, 'triangle', 980, 760, 0.12);
        break;
      case 'gboom':
        this.noiseBurst(o, 0.7, 'lowpass', 1700, 130, 0.8, 0.6);
        this.tone(o, 0.45, 'sine', 90, 38, 0.7);
        break;
      case 'salvo':
        this.noiseBurst(o, 0.35, 'bandpass', 600, 2000, 0.4, 1.1);
        this.tone(o, 0.15, 'sine', 130, 60, 0.35);
        break;
      case 'flak':
        this.tone(o, 0.05, 'square', 240, 120, 0.1);
        this.noiseBurst(o, 0.06, 'highpass', 2400, 1600, 0.3);
        this.noiseBurst(o, 0.25, 'lowpass', 1100, 200, 0.35, 0.8, 0.07);
        break;
      case 'radio':
        this.noiseBurst(o, 0.3, 'bandpass', 1900, 1700, 0.18, 3);
        this.tone(o, 0.07, 'square', 1040, 1040, 0.05, 0.3);
        this.tone(o, 0.07, 'square', 1040, 1040, 0.05, 0.42);
        break;
      case 'plane':
        this.tone(o, 2.6, 'sawtooth', 78, 118, 0.12, 0, 1.1);
        this.tone(o, 2.6, 'sawtooth', 81, 122, 0.09, 0, 1.1);
        this.noiseBurst(o, 2.4, 'lowpass', 500, 900, 0.3, 0.8);
        break;
      case 'bomb':
        this.noiseBurst(o, 1.1, 'lowpass', 1600, 90, 1.0, 0.6);
        this.tone(o, 0.7, 'sine', 72, 28, 0.9);
        break;
      case 'defeat':
        [392, 330, 262].forEach((f, i) => this.tone(o, 0.55, 'triangle', f, f * 0.98, 0.25, i * 0.18));
        break;
    }
  }

  startEngine() {
    const ac = this.ac;
    this.engOsc = ac.createOscillator();
    this.engOsc.type = 'sawtooth';
    this.engOsc.frequency.value = 36;
    this.engFilter = ac.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 220;
    this.engGain = ac.createGain();
    this.engGain.gain.value = 0;
    this.engOsc.connect(this.engFilter);
    this.engFilter.connect(this.engGain);
    this.engGain.connect(this.master);
    this.engOsc.start();
  }

  // Called once per frame with the human tanks (engine follows the busiest one).
  frame(tanks) {
    this.budget = 0;
    if (!this.ac || !this.engGain) return;
    const t = this.ac.currentTime;
    let load = 0, tank = null;
    for (const k of tanks || []) {
      if (!k || !k.alive) continue;
      const l = Math.max(Math.min(1, Math.hypot(k.vx, k.vy) / TANK.maxSpeed), Math.min(1, Math.abs(k.turnVel) / TANK.turnRate) * 0.6);
      if (!tank || l > load) { load = l; tank = k; }
    }
    this.engOsc.frequency.setTargetAtTime(34 + load * 26, t, 0.15);
    this.engFilter.frequency.setTargetAtTime(180 + load * 380, t, 0.15);
    this.engGain.gain.setTargetAtTime(tank && tank.alive ? 0.05 + load * 0.08 : 0, t, 0.2);
  }
}
