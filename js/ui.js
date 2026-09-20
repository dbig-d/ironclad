'use strict';
// ---------------------------------------------------------------------------
// DOM UI: menu, match HUD panels, kill feed, announcements, pause and results.
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICONS = {
  tdm: '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.6"><circle cx="20" cy="20" r="11"/><circle cx="20" cy="20" r="2.5" fill="currentColor" stroke="none"/><path d="M20 3v8M20 29v8M3 20h8M29 20h8"/></svg>',
  koth: '<svg viewBox="0 0 40 40" fill="currentColor"><path d="M7 29l-2-17 9 8 6-12 6 12 9-8-2 17z"/><rect x="7" y="31" width="26" height="4" rx="1"/></svg>',
  ctf: '<svg viewBox="0 0 40 40" fill="currentColor"><rect x="9" y="5" width="3" height="31" rx="1"/><path d="M12 6c6-3 10 3 17 0v14c-7 3-11-3-17 0z"/></svg>',
  oneshot: '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.6"><circle cx="20" cy="20" r="14"/><path d="M17 15l4-3v17" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 3v4M20 33v4M3 20h4M33 20h4"/></svg>',
  jug: '<svg viewBox="0 0 40 40" fill="currentColor"><path d="M10 15l-1.6-9 6.2 5.2L20 4l5.4 7.2L31.6 6 30 15z"/><rect x="6" y="19" width="26" height="15" rx="3.5"/><rect x="22" y="24.5" width="15" height="4" rx="1.5"/></svg>',
  escort: '<svg viewBox="0 0 40 40" fill="currentColor"><rect x="3" y="12" width="22" height="16" rx="2.5"/><path d="M25 16h7l5 6v6H25z"/><circle cx="10" cy="30" r="3.4"/><circle cx="30" cy="30" r="3.4"/><rect x="6" y="8" width="3" height="4"/></svg>',
  hardcore: '<svg viewBox="0 0 40 40" fill="currentColor"><path fill-rule="evenodd" d="M20 4C11.7 4 6.5 9.8 6.5 17.2c0 4.4 2 7.8 5 9.7V33.5h17v-6.6c3-1.9 5-5.3 5-9.7C33.5 9.8 28.3 4 20 4zM14.3 14.6a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4zm11.4 0a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4zM20 22.5l-2.3 4.3h4.6z"/><path d="M16 29.5h1.8v4H16zM19.1 29.5h1.8v4h-1.8zM22.2 29.5H24v4h-1.8z" fill="#161a16"/></svg>',
  br: '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.6"><circle cx="20" cy="20" r="15" stroke-dasharray="4 3.2"/><circle cx="23" cy="17" r="7.5"/><circle cx="23" cy="17" r="1.8" fill="currentColor" stroke="none"/></svg>',
};
const FEED_ICON = '<svg viewBox="0 0 22 12" fill="currentColor"><rect x="0" y="3" width="11" height="6" rx="1.5"/><rect x="10" y="5" width="12" height="2"/><rect x="1" y="1" width="9" height="1.4"/><rect x="1" y="9.6" width="9" height="1.4"/></svg>';
const ZONE_ICON = '<svg viewBox="0 0 22 12" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="6" r="4.5" stroke-dasharray="2 1.6"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.1l-6.1 3.5 1.5-6.8-5.2-4.6 6.9-.7z"/></svg>';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const SETTINGS_KEY = 'ironclad.settings.v1';
// Per-player key labels for the HUD panels (single player uses the mouse).
const PANEL_KEYS = {
  solo: { missile: 'RMB', auto: 'R' },
  two: [{ missile: 'Q', auto: 'E', hint: 'L-Shift fire · Q special · E auto', picks: ['1', '2', '3'] },
        { missile: 'ENTER', auto: 'R-SHIFT', hint: 'Space fire · Enter special · R-Shift auto', picks: [',', '.', '/'] }],
};
PANEL_KEYS.solo.picks = ['1', '2', '3'];

class UI {
  constructor(app) {
    this.app = app;
    this.settings = Object.assign({
      mode: 'tdm', size: 4, brSize: 10, jugSize: 6, difficulty: 'normal', biome: 'random', steering: 'tank',
      volume: 0.7, party: 'solo', hits: HITS.default,
      progression: 'standard', loadout: Object.assign({}, DEFAULT_LOADOUT), botLoadout: 'standard',
      playerName: '', p2Name: '',
    }, this.load());
    this.settings.loadout = Object.assign({}, DEFAULT_LOADOUT, this.settings.loadout);
    this.loDesc = '';
    // Older saves stored a player count instead of a party type.
    if (!['solo', 'coop', 'versus'].includes(this.settings.party)) this.settings.party = this.settings.players === 2 ? 'coop' : 'solo';
    this.lastSb = '';
    this.cp = loadCampaign(this.settings.playerName || 'Pilot 1');
    this.hgTab = 'weapon';
    this.hgSel = null;     // part being previewed in the hangar
    this.buildMenu();
    this.bind();
  }

  load() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }
  save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* storage unavailable */ }
  }

  // ---- menu ------------------------------------------------------------------------
  radio(container, items, current, onPick, render) {
    container.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(it.value === current));
      b.innerHTML = render(it);
      if (it.disabled) { b.disabled = true; b.title = it.disabled; }
      b.addEventListener('click', () => { this.app.sfx.play('click'); onPick(it.value); });
      if (it.cls) b.className = it.cls;
      container.appendChild(b);
    }
  }

  buildMenu() {
    const s = this.settings;
    const coop = s.party === 'coop';
    this.radio($('mode-list'), Object.values(MODES).map(m => ({ value: m.id, m, cls: 'mode' })), s.mode,
      v => { s.mode = v; this.save(); this.buildMenu(); },
      it => `${ICONS[it.value]}<span class="m-name">${it.m.name}</span>`);
    $('mode-blurb').textContent = MODES[s.mode].blurb;

    // Free-for-all modes pick a tank count; team modes pick a squad size.
    const ffaList = s.mode === 'br' ? BR_SIZES : s.mode === 'jug' ? JUG_SIZES : null;
    const sizeKey = s.mode === 'br' ? 'brSize' : s.mode === 'jug' ? 'jugSize' : 'size';
    $('size-label').textContent = ffaList ? 'Tanks in the match' : 'Squad size';
    // Co-op needs at least two tanks on your side.
    if (coop && !ffaList && s.size < 2) s.size = 2;
    const sizes = ffaList ? ffaList.map(n => ({ value: n, label: n + ' tanks' }))
      : TEAM_SIZES.map(n => ({ value: n, label: `${n}v${n}`, disabled: coop && n < 2 ? 'Co-op needs a squad of 2 or more' : '' }));
    this.radio($('size-list'), sizes, s[sizeKey],
      v => { s[sizeKey] = v; this.save(); this.buildMenu(); },
      it => it.label);

    this.radio($('diff-list'), DIFFICULTIES.map(d => ({ value: d.id, d })), s.difficulty,
      v => { s.difficulty = v; this.save(); this.buildMenu(); },
      it => {
        const n = it.d.id === 'mixed' ? 0 : it.d.tiers[0];
        return it.d.name + (n ? `<span class="chev">${'<i></i>'.repeat(n)}</span>` : '');
      });
    $('diff-blurb').textContent = DIFFICULTIES.find(d => d.id === s.difficulty).blurb;

    // The campaign is single player.
    const camp = s.progression === 'campaign';
    const soloOnly = camp ? 'The campaign is single player' : LOW_MEM ? 'Two-player modes need a keyboard' : '';
    this.radio($('players-list'), [{ value: 'solo', label: '1 Player' }, { value: 'coop', label: '2 · Co-op', disabled: soloOnly }, { value: 'versus', label: '2 · Versus', disabled: soloOnly }], camp ? 'solo' : s.party,
      v => { s.party = v; this.save(); this.buildMenu(); },
      it => it.label);
    if (LOW_MEM && s.party !== 'solo') s.party = 'solo';

    this.radio($('steer-list'), [{ value: 'tank', label: 'Tank' }, { value: 'arcade', label: 'Arcade' }], s.steering,
      v => { s.steering = v; this.save(); this.buildMenu(); },
      it => it.label);

    const biomes = [{ value: 'random', label: 'Random', chip: 'conic-gradient(#6b8a43 0 14%, #d2b27a 0 28%, #e8eef2 0 43%, #c06b40 0 57%, #ec9fbd 0 71%, #d56f2a 0 86%, #58673f 0)' }]
      .concat(BIOME_IDS.map(id => ({ value: id, label: BIOMES[id].name, chip: `linear-gradient(135deg, ${BIOMES[id].ground[2]}, ${BIOMES[id].ground[0]} 55%, ${BIOMES[id].dirt})` })));
    this.radio($('biome-list'), biomes.map(b => ({ ...b, cls: 'swatch' })), s.biome,
      v => { s.biome = v; this.save(); this.buildMenu(); },
      it => `<span class="chip" style="background:${it.chip}"></span>${it.label}`);

    this.radio($('prog-list'), [
      { value: 'standard', label: 'Standard' }, { value: 'leveling', label: 'Leveling' }, { value: 'freeplay', label: 'Freeplay' },
    ], s.progression, v => { s.progression = v; this.save(); this.buildMenu(); }, it => it.label);
    $('prog-blurb').textContent = {
      standard: 'Everyone drives the standard tank.',
      leveling: 'Earn XP in the match to unlock part upgrades as you go.',
      freeplay: 'Build your own tank from every part.',
      campaign: 'Missions across a connected world map. Earn money and stars, and outfit your tank in the hangar.',
    }[s.progression];
    for (const el of document.querySelectorAll('.std-only')) el.hidden = camp;
    $('name-p2').hidden = s.party === 'solo' || camp;
    $('name-p1').placeholder = s.party === 'solo' ? 'Your callsign' : 'Player 1 callsign';
    if (document.activeElement !== $('name-p1')) $('name-p1').value = s.playerName || '';
    if (document.activeElement !== $('name-p2')) $('name-p2').value = s.p2Name || '';
    $('cp-card').hidden = !camp;
    $('deploy').innerHTML = camp ? 'Campaign <kbd>Enter</kbd>' : 'Deploy <kbd>Enter</kbd>';
    if (camp) this.renderCampaignCard();
    this.buildLoadout();

    const hits = $('hits');
    hits.min = HITS.min; hits.max = HITS.max;
    hits.value = s.hits;
    // One Shot ignores armor: every hit kills.
    hits.disabled = s.mode === 'oneshot';
    $('hits-out').textContent = s.mode === 'oneshot' ? '1 hit' : `${s.hits} hits`;
    this.renderControls();
  }

  // Freeplay: pick one part per slot, and what the bots drive.
  buildLoadout() {
    const s = this.settings, card = $('loadout-card');
    card.hidden = s.progression !== 'freeplay';
    if (card.hidden) return;
    const slots = $('lo-slots');
    slots.innerHTML = '';
    for (const slot of SLOTS) {
      const row = document.createElement('div');
      row.className = 'lo-slot';
      row.innerHTML = `<span class="lo-name">${SLOT_NAMES[slot]}</span><div class="seg small" role="radiogroup" aria-label="${SLOT_NAMES[slot]}"></div>`;
      slots.appendChild(row);
      this.radio(row.querySelector('.seg'), Object.keys(PARTS[slot]).map(id => ({ value: id })), s.loadout[slot],
        v => { s.loadout[slot] = v; this.loDesc = PARTS[slot][v].name + ': ' + PARTS[slot][v].desc; this.save(); this.buildLoadout(); },
        it => partIcon(it.value) + PART_SHORT[it.value]);
    }
    $('lo-desc').textContent = this.loDesc || 'Every part replaces the standard one in its slot.';
    this.radio($('lo-bots'), [
      { value: 'standard', label: 'Standard' }, { value: 'player', label: 'Your loadout' }, { value: 'random', label: 'Random' },
    ], s.botLoadout, v => { s.botLoadout = v; this.save(); this.buildLoadout(); }, it => it.label);
    $('lo-bots').classList.add('small');
  }

  renderControls() {
    const s = this.settings, tank = s.steering === 'tank';
    const k = (...keys) => `<span class="keys">${keys.map(x => `<kbd${x.length > 1 ? ' class="wide"' : ''}>${x}</kbd>`).join('')}</span>`;
    let rows;
    if (this.app.input && this.app.input.touchMode && s.party === 'solo') {
      rows = [
        [k('Left thumb'), 'Drive: the tank heads where you push'],
        [k('Right thumb'), 'Aim and fire (locks on to nearby enemies)'],
        [k('Special'), 'Use your special when the ring is full'],
        [k('Auto'), 'Autofire on / off'],
        [k('≡'), 'Hold for the scoreboard'],
      ];
      $('controls-card').innerHTML = rows.map(([a, b]) => `<div class="ctl">${a}<span>${b}</span></div>`).join('');
      return;
    }
    if (s.party !== 'solo') {
      const pl = i => `<span class="pl" style="color:${PLAYER_COLORS[i]}">P${i + 1}</span>`;
      const vs = s.party === 'versus', lev = s.progression === 'leveling';
      $('controls-card').innerHTML =
        `<div class="ctl-line">${pl(0)}${k('W', 'A', 'S', 'D')}<span>drive</span>${k('L-Shift')}<span>fire</span>${k('Q')}<span>special</span>${k('E')}<span>auto</span>${lev ? k('1', '2', '3') + '<span>upgrade</span>' : ''}</div>` +
        `<div class="ctl-line">${pl(1)}${k('↑', '←', '↓', '→')}<span>drive</span>${k('Space')}<span>fire</span>${k('Enter')}<span>special</span>${k('R-Shift')}<span>auto</span>${lev ? k(',', '.', '/') + '<span>upgrade</span>' : ''}</div>` +
        `<div class="ctl">${k('Tab')}<span>Scoreboard</span></div>` +
        `<div class="ctl">${k('Esc', 'M')}<span>Pause · Mute</span></div>` +
        `<p class="ctl-note">${vs ? 'P1 leads Cobalt, P2 leads Ember. ' : ''}Turrets lock onto the nearest enemy ahead of your hull. Missiles charge as you deal damage. P1 can also fire with F.</p>`;
      return;
    }
    rows = [
      [k('W', 'A', 'S', 'D'), tank ? 'W/S drive · A/D turn hull' : 'Drive in the pressed direction'],
      [k('Mouse'), 'Aim the turret'],
      [k('Click', 'Space'), 'Fire'],
      [k('Right-click'), 'Use your special'],
      [k('R'), 'Autofire on / off'],
      ...(s.progression === 'leveling' ? [[k('1', '2', '3'), 'Pick an upgrade']] : []),
      [k('Tab'), 'Scoreboard'],
      [k('Esc', 'M'), 'Pause · Mute'],
    ];
    $('controls-card').innerHTML = rows.map(([a, b]) => `<div class="ctl">${a}<span>${b}</span></div>`).join('');
  }

  bind() {
    $('deploy').addEventListener('click', () => this.app.startMatch());
    $('menu-back').addEventListener('click', () => { this.app.sfx.play('click'); this.app.toTitle(); });
    $('t-skirmish').addEventListener('click', () => { this.app.sfx.play('click'); this.app.toMenu(); });
    $('t-campaign').addEventListener('click', () => { this.app.sfx.play('click'); this.app.openCampaign(); });
    $('t-online').addEventListener('click', () => { this.app.sfx.play('click'); this.app.toOnline(); });
    $('on-back').addEventListener('click', () => { this.app.sfx.play('click'); this.app.leaveOnline(); });
    $('p-resume').addEventListener('click', () => this.app.setPaused(false));
    $('p-restart').addEventListener('click', () => this.app.startMatch());
    // Fullscreen gives phones the whole screen.
    document.querySelectorAll('[data-fs]').forEach(b => b.addEventListener('click', () => { this.app.sfx.play('click'); b.blur(); this.toggleFullscreen(); }));
    const fsChange = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      document.body.classList.toggle('fs-on', on);
      $('p-full').textContent = on ? 'Exit fullscreen' : 'Fullscreen';
      document.querySelectorAll('.fs-btn, .fs-inline').forEach(b => b.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen'));
    };
    document.addEventListener('fullscreenchange', fsChange);
    document.addEventListener('webkitfullscreenchange', fsChange);
    $('p-menu').addEventListener('click', () => (this.app.mission ? this.app.openCampaign() : this.app.toMenu()));
    $('e-again').addEventListener('click', () => this.app.startMatch());
    $('e-menu').addEventListener('click', () => (this.app.mission ? this.app.openCampaign() : this.app.toMenu()));
    $('cp-back').addEventListener('click', () => { this.app.sfx.play('click'); this.app.toTitle(); });
    $('cp-pilot').addEventListener('click', () => { this.app.sfx.play('click'); this.showPilots(); });
    $('cpc-pilots').addEventListener('click', () => { this.app.sfx.play('click'); this.showPilots(); });
    $('pilots-close').addEventListener('click', () => { this.app.sfx.play('click'); $('pilots').hidden = true; });
    $('pilot-new').addEventListener('submit', e => { e.preventDefault(); this.newPilot(); });
    $('cf-cancel').addEventListener('click', () => this.closeConfirm(false));
    $('cf-ok').addEventListener('click', () => this.closeConfirm(true));
    $('cf-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.closeConfirm(true); } });
    for (const [id, key] of [['name-p1', 'playerName'], ['name-p2', 'p2Name']]) {
      $(id).maxLength = PILOT_MAX_LEN;
      $(id).addEventListener('input', () => { this.settings[key] = cleanName($(id).value, ''); this.save(); });
    }
    $('cp-hangar').addEventListener('click', () => { this.app.sfx.play('click'); this.app.openHangar(); });
    $('hg-back').addEventListener('click', () => { this.app.sfx.play('click'); this.app.openCampaign(); });
    $('br-watch').addEventListener('click', () => { $('br-out').hidden = true; this.brDismissed = true; });
    $('br-again').addEventListener('click', () => this.app.startMatch());
    $('br-menu').addEventListener('click', () => this.app.toMenu());
    for (const b of $('ladder-tabs').children) b.addEventListener('click', () => { this.app.sfx.play('click'); this.renderLadder(b.dataset.l); });
    const hits = $('hits');
    hits.addEventListener('input', () => {
      this.settings.hits = parseInt(hits.value, 10);
      $('hits-out').textContent = `${this.settings.hits} hits`;
      this.save();
    });
    const vol = $('p-volume');
    vol.value = this.settings.volume;
    vol.addEventListener('input', () => {
      this.settings.volume = parseFloat(vol.value);
      this.app.sfx.setVolume(this.settings.volume);
      this.save();
    });
  }

  matchSettings() {
    const s = this.settings, br = s.mode === 'br';
    return {
      playerName: s.playerName || (s.party === 'solo' ? 'You' : 'P1'),
      p2Name: s.p2Name || 'P2',
      mode: s.mode,
      size: s.mode === 'br' ? s.brSize : s.mode === 'jug' ? s.jugSize : (s.party === 'coop' ? Math.max(2, s.size) : s.size),
      difficulty: s.difficulty,
      biome: s.biome === 'random' ? randPick(BIOME_IDS) : s.biome,
      steering: s.steering,
      players: s.party === 'solo' ? 1 : 2,
      versus: s.party === 'versus',
      hits: s.hits,
      progression: s.progression,
      loadout: Object.assign({}, s.loadout),
      botLoadout: s.botLoadout,
    };
  }

  // Title screen: skirmish, campaign or (later) online.
  showTitle() {
    $('title').hidden = true;
    $('online').hidden = true;
    $('menu').hidden = true;
    $('campaign').hidden = true;
    $('hangar').hidden = true;
    $('hud').hidden = true;
    $('pause').hidden = true;
    $('end').hidden = true;
    document.body.classList.remove('playing');
    this.renderTitle();
    $('title').hidden = false;
  }

  renderTitle() {
    const s = this.settings, save = this.cp;
    const modeName = (MODES[s.mode] || MODES.tdm).name;
    const size = s.mode === 'br' ? s.brSize + ' tanks' : s.mode === 'jug' ? s.jugSize + ' tanks' : `${s.size}v${s.size}`;
    $('tc-skirmish').textContent = `Last played · ${modeName} · ${size}`;
    const stars = totalStars(save), done = CAMPAIGN_LEVELS.filter(l => levelStars(save, l.id)[0]).length;
    $('tc-campaign').textContent = done
      ? `${esc(save.pilot)} · ${done} / ${CAMPAIGN_LEVELS.length} missions · ${stars}★`
      : 'New campaign · Mission 1';
  }

  // Online: host a room, or join one with a code.
  showOnline() {
    $('title').hidden = true;
    $('online').hidden = true;
    $('menu').hidden = true;
    $('campaign').hidden = true;
    $('hangar').hidden = true;
    $('hud').hidden = true;
    $('pause').hidden = true;
    $('end').hidden = true;
    document.body.classList.remove('playing');
    this.renderOnline();
    $('online').hidden = false;
  }

  renderOnline() {
    const el = $('on-body');
    if (!el) return;
    const net = this.app.net, s = this.settings;
    const esc2 = t => esc(String(t));
    if (net.state === 'off') {
      let framed = false;
      try { framed = window.top !== window.self; } catch (e) { framed = true; }
      const embedNote = framed
        ? `<p class="on-err">Online play needs the game's own page: this viewer blocks the connection.
             <br><b>${NET.home}</b></p>`
        : '';
      el.innerHTML = `${embedNote}${net.error ? `<p class="on-err">${esc2(net.error)}</p>` : ''}
        <section class="field"><h2 class="label"><label for="on-name">Callsign</label></h2>
          <div class="names"><input id="on-name" type="text" autocomplete="off" spellcheck="false" maxlength="14" placeholder="Your callsign" value="${esc2(s.playerName || '')}"></div></section>
        <div class="on-actions">
          <button type="button" class="btn big" id="on-host">Host a game</button>
          <div class="on-join"><input id="on-code" autocomplete="off" spellcheck="false" maxlength="5" placeholder="CODE" aria-label="Room code"><button type="button" class="btn" id="on-join">Join</button></div>
        </div>
        <p class="hint">One player hosts and reads out the code. Up to four tanks, on any mix of phones and computers.</p>`;
      const name = () => cleanName($('on-name').value) || 'Player';
      const remember = () => { s.playerName = cleanName($('on-name').value); this.save(); };
      $('on-host').addEventListener('click', async () => { remember(); this.app.sfx.play('click'); await net.host(name()); this.renderOnline(); });
      const join = async () => {
        const code = ($('on-code').value || '').trim().toUpperCase();
        if (code.length < 4) return this.toast('Enter the five-character code from the host.');
        remember();
        this.app.sfx.play('click');
        await net.join(code, name());
        this.renderOnline();
      };
      $('on-join').addEventListener('click', join);
      $('on-code').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
      return;
    }
    if (net.state === 'connecting') {
      el.innerHTML = `<p class="on-wait">${net.isHost ? 'Opening a room\u2026' : 'Looking for that room\u2026'}</p>
        <div class="on-foot"><button type="button" class="btn ghost" id="on-leave">Cancel</button></div>`;
      $('on-leave').addEventListener('click', () => { net.leave(); this.renderOnline(); });
      return;
    }
    // Lobby.
    const host = net.isHost, L = net.lobby, team = MODES[L.mode].teams;
    const rows = net.roster.map(r => `<div class="on-row">
        <span class="nm">${esc2(r.name)}</span>
        ${r.you ? '<span class="on-tag you">You</span>' : ''}
        ${r.host ? '<span class="on-tag">Host</span>' : ''}
        ${!r.you && r.mode === 'relay' ? '<span class="on-tag relay">Relayed</span>' : ''}
        ${!r.you && r.ping ? `<span class="on-tag">${r.ping} ms</span>` : ''}
        <span class="sp"></span>
        ${team ? `<span class="on-teams">${[0, 1].map(t => `<button type="button" class="${r.team === t ? 'on' : ''}" data-team="${t}" data-id="${r.id}" ${host ? '' : 'disabled'}>${t === 0 ? 'A' : 'B'}</button>`).join('')}</span>` : ''}
      </div>`).join('');
    el.innerHTML = `${host ? `<div class="on-codebox"><span class="label">Room code</span><b>${net.code}</b><button type="button" class="btn ghost small" id="on-copy">Copy</button></div>`
        : `<p class="on-wait">Room ${net.code} \u00b7 waiting for the host to start</p>`}
      <div class="on-players">${rows}</div>
      ${host ? `<section class="field"><h2 class="label">Operation</h2><div class="seg" id="on-mode"></div></section>
        <section class="field split"><div><h2 class="label">Squad size</h2><div class="seg" id="on-size"></div></div>
          <div><h2 class="label">Armor</h2><div class="seg" id="on-hits"></div></div></section>`
        : `<p class="hint">${MODES[L.mode].name} \u00b7 ${team ? L.size + 'v' + L.size : L.size + ' tanks'} \u00b7 ${L.hits} hits</p>`}
      <div class="on-foot">
        ${host ? '<button type="button" class="btn big" id="on-start">Start match</button>' : ''}
        <button type="button" class="btn ghost" id="on-leave">Leave</button>
      </div>`;
    if (host) {
      $('on-copy').addEventListener('click', () => {
        const done = () => this.toast('Code ' + net.code + ' copied. Send it to your friend.');
        if (navigator.clipboard) navigator.clipboard.writeText(net.code).then(done, () => this.toast('Room code: ' + net.code));
        else this.toast('Room code: ' + net.code);
      });
      this.radio($('on-mode'), NET.modes.map(id => ({ value: id, label: MODES[id].name })), L.mode, v => net.setLobby({ mode: v }), it => it.label);
      const sizes = MODES[L.mode].teams ? [1, 2, 4] : [4, 6, 10];
      this.radio($('on-size'), sizes.map(n => ({ value: n, label: MODES[L.mode].teams ? n + 'v' + n : n + ' tanks' })), sizes.includes(L.size) ? L.size : sizes[1], v => net.setLobby({ size: v }), it => it.label);
      this.radio($('on-hits'), [5, 7, 9].map(n => ({ value: n, label: n + ' hits' })), L.hits, v => net.setLobby({ hits: v }), it => it.label);
      $('on-start').addEventListener('click', () => { this.app.sfx.play('click'); net.start(); });
      el.querySelectorAll('.on-teams button').forEach(b => b.addEventListener('click', () => net.setTeam(b.dataset.id, +b.dataset.team)));
    }
    $('on-leave').addEventListener('click', () => { this.app.sfx.play('click'); this.app.leaveOnline(); });
  }

  showMenu() {
    $('title').hidden = true;
    $('campaign').hidden = true;
    $('hangar').hidden = true;
    this.buildMenu();
    $('menu').hidden = false;
    $('hud').hidden = true;
    $('pause').hidden = true;
    $('end').hidden = true;
    document.body.classList.remove('playing');
  }

  // ---- HUD ---------------------------------------------------------------------------
  showHud(game) {
    this.game = game;
    $('campaign').hidden = true;
    $('hangar').hidden = true;
    $('p-menu').textContent = game.campaign ? 'Leave mission' : 'Main menu';
    $('p-restart').textContent = game.campaign ? 'Restart mission' : 'Restart match';
    $('title').hidden = true;
    $('online').hidden = true;
    $('menu').hidden = true;
    $('hud').hidden = false;
    $('pause').hidden = true;
    $('end').hidden = true;
    $('br-out').hidden = true;
    $('tabboard').hidden = true;
    $('spectate').hidden = true;
    $('killfeed').innerHTML = '';
    $('announce').innerHTML = '';
    $('center-msg').innerHTML = '';
    // Seats at this screen: both players in local co-op, only yours online.
    const seats = game.locals || game.players;
    const coop = seats.length > 1; // split screen (co-op or versus)
    $('hud').classList.toggle('coop', coop);
    // One status panel and one death card per human player.
    $('panels').innerHTML = seats.map((p, i) => `
      <div class="player-panel" data-i="${i}" style="${coop ? '--pc:' + PLAYER_COLORS[i] + ';' : ''}">
        <div class="pp-top"><span class="pp-id"><span class="pp-name">${esc(p.name)}</span><span class="pp-auto" title="Autofire">AUTO ${keys(i).auto}</span></span><span class="pp-kd"></span></div>
        <div class="hpbar"><div class="pp-hp"></div><div class="segs"></div></div>
        <div class="pp-row"><span class="pp-hpnum"></span><div class="reload"><div class="pp-reload"></div></div><span class="pp-lbl">READY</span></div>
        <div class="ms-row"><span class="ms-lbl">Missile</span><div class="ms-bar"><div class="ms-fill"></div></div><kbd class="ms-key">${keys(i).missile}</kbd></div>
        ${game.leveling ? '<div class="xp-row"><span class="xp-lvl">LV 1</span><div class="xp-bar"><div class="xp-fill"></div></div><span class="xp-num"></span></div>' : ''}
        ${coop ? `<div class="pp-keys">${PANEL_KEYS.two[i].hint}</div>` : ''}
      </div>`).join('');
    function keys(i) { return coop ? PANEL_KEYS.two[i] : PANEL_KEYS.solo; }
    $('deaths').innerHTML = seats.map((p, i) => `
      <div class="death-card" data-i="${i}" hidden>
        <p class="death-title"></p><p class="death-by"></p><p class="death-timer"></p>
      </div>`).join('');
    this.panels = [...document.querySelectorAll('#panels .player-panel')].map((el, i) => ({
      root: el, name: el.querySelector('.pp-name'), pc: coop ? PLAYER_COLORS[i] : '', segs: 0, shown: null,
      hp: el.querySelector('.pp-hp'), num: el.querySelector('.pp-hpnum'), rl: el.querySelector('.pp-reload'),
      lbl: el.querySelector('.pp-lbl'), kd: el.querySelector('.pp-kd'),
      auto: el.querySelector('.pp-auto'), msRow: el.querySelector('.ms-row'), msFill: el.querySelector('.ms-fill'),
      msLbl: el.querySelector('.ms-lbl'), xpLvl: el.querySelector('.xp-lvl'), xpFill: el.querySelector('.xp-fill'), xpNum: el.querySelector('.xp-num'),
    }));
    $('offers').innerHTML = '';
    this.offerEls = [];
    this.deathCards = [...document.querySelectorAll('#deaths .death-card')];
    this.brDismissed = false;
    this.lastSb = '';
    this.lastCount = null;
    document.body.classList.add('playing');
  }

  frame(game, humans, spectating, autofire) {
    this.scoreboard(game, humans);
    // While dead, your panel shows whoever you're spectating.
    humans.forEach((p, i) => {
      const watch = !p.alive && spectating[i] && spectating[i] !== p ? spectating[i] : null;
      this.updatePanel(game, watch || p, this.panels[i], watch ? false : autofire[i], p);
    });

    this.renderOffers(game, humans);

    // Intro countdown.
    if (game.phase === 'intro') {
      const n = Math.ceil(game.introT);
      if (n !== this.lastCount && n > 0 && n <= 3) {
        this.lastCount = n;
        $('center-msg').innerHTML = `<div class="count">${n}</div><div class="count-sub">${esc(game.def.name)}</div>`;
        this.app.sfx.play('beep');
      }
    } else if (this.lastCount) {
      // An online joiner can miss the "go" event; never leave the count on screen.
      this.lastCount = 0;
      const cm = $('center-msg');
      if (cm.querySelector('.count') && !cm.querySelector('.go')) cm.innerHTML = '';
    }

    // Death cards: respawn countdown, or (battle royale) who you're watching.
    const coop = humans.length > 1;
    humans.forEach((p, i) => {
      const card = this.deathCards[i];
      const hc = game.settings.mode === 'hardcore';
      const soloBR = game.settings.mode === 'br' && !coop;
      const show = !p.alive && game.phase === 'live' && !soloBR;
      card.hidden = !show;
      if (!show) return;
      const k = p.killedBy, sp = spectating[i];
      const title = game.def.respawn ? 'Destroyed' : 'Eliminated';
      const by = k && k !== p ? `by <b style="color:${k.color.ui}">${esc(k.name)}</b>` : game.def.respawn || hc ? 'by the battlefield' : 'by the zone';
      const watch = sp ? `Watching <b style="color:${sp.isPlayer ? PLAYER_COLORS[sp.humanIndex] : sp.color.ui}">${esc(sp.name)}</b>` : '';
      const timer = game.def.respawn ? 'Respawning in ' + Math.max(1, Math.ceil(p.respawnT))
        : hc ? (game.mode.state === 'break' ? 'Next round in ' + Math.max(1, Math.ceil(game.mode.breakT)) : (watch ? watch + ' · ' : '') + 'Out until next round') : watch;
      const html = [title, by, timer];
      const els = card.children;
      for (let j = 0; j < 3; j++) if (els[j].innerHTML !== html[j]) els[j].innerHTML = html[j];
    });

    // Solo battle royale spectator bar.
    const sp = $('spectate'), me = humans[0], target = spectating[0];
    if (!coop && !game.def.respawn && target && !me.alive && game.phase === 'live' && (this.brDismissed || game.settings.mode === 'hardcore')) {
      sp.hidden = false;
      const html = `Spectating <b style="color:${target.color.ui}">${esc(target.name)}</b> · Click to switch`;
      if (sp.innerHTML !== html) sp.innerHTML = html;
    } else sp.hidden = true;

    // Tab scoreboard (or the touch board button, held).
    const tab = (this.app.input.keys.has('Tab') || this.app.input.boardHeld) && game.phase !== 'over';
    $('tabboard').hidden = !tab;
    if (tab) this.renderTab(game);
  }

  // Touch controls: sticks follow the thumbs; the special button shows its charge.
  touchFrame(game, show, p, auto) {
    const layer = $('touch');
    layer.hidden = !show;
    if (!show) { this.hintShown = false; return; }
    const inp = this.app.input;
    for (const k of ['l', 'r']) {
      const el = $('stick-' + k), s = inp.sticks[k];
      el.classList.toggle('on', !!s);
      if (!s) continue;
      el.style.transform = `translate(${s.ox}px, ${s.oy}px)`;
      const dx = s.x - s.ox, dy = s.y - s.oy, d = Math.hypot(dx, dy), m = Math.min(1, STICK_RADIUS / (d || 1));
      el.firstChild.style.transform = `translate(${dx * m}px, ${dy * m}px)`;
    }
    const cost = game.specialCost(p), f = clamp(p.missileCharge / cost, 0, 1);
    const sp = $('t-special');
    sp.style.setProperty('--f', (f * 100).toFixed(1) + '%');
    sp.classList.toggle('ready', (f >= 1 || p.grenadeAmmo > 0) && p.alive);
    if (this.touchSpecialId !== p.loadout.special) { this.touchSpecialId = p.loadout.special; $('t-ico').innerHTML = partIcon(p.loadout.special); }
    $('t-auto').classList.toggle('on', !!auto);
    if (!this.hintShown) {
      this.hintShown = true;
      const h = $('t-hint');
      h.classList.remove('gone'); void h.offsetWidth;
      clearTimeout(this.hintT);
      this.hintT = setTimeout(() => h.classList.add('gone'), 5000);
    }
  }

  // Real fullscreen where the browser allows it. Embedded viewers (like the
  // artifact view in an app) and iPhones don't, so fall back to opening the game
  // in its own browser tab, and explain the options if even that is blocked.
  toggleFullscreen() {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      if (exit) { const p = exit.call(d); if (p && p.catch) p.catch(() => {}); }
      return;
    }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const fallback = () => {
      let framed = false;
      try { framed = window.top !== window.self; } catch (e) { framed = true; }
      if (framed && /^https?:/.test(location.protocol)) {
        let w = null;
        // (no 'noopener' feature: with it, open() returns null even when the tab opens)
        try { w = window.open(location.href, '_blank'); } catch (e) { w = null; }
        if (w) { try { w.opener = null; } catch (e) { /* cross-origin */ } return; }
      }
      this.toast(framed
        ? 'Fullscreen is blocked inside this viewer. Open the game in your browser (the viewer\u2019s menu \u2192 open in browser), then tap Fullscreen again.'
        : 'This browser can\u2019t go fullscreen here. Add the page to your home screen to play it full-screen.');
    };
    if (req && (d.fullscreenEnabled || d.webkitFullscreenEnabled)) {
      try {
        const p = req.call(el, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(fallback);
      } catch (e) { fallback(); }
    } else fallback();
  }

  toast(text) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => t.classList.remove('show'), 6000);
  }

  // Level-up choices: three cards per player, picked with keys or a click.
  renderOffers(game, humans) {
    const two = humans.length > 1;
    humans.forEach((p, i) => {
      const o = p.offer;
      let el = this.offerEls[i];
      if (!o) { if (el) { el.remove(); this.offerEls[i] = null; } return; }
      if (!el || el.offer !== o) {
        if (el) el.remove();
        el = document.createElement('div');
        el.className = 'offer';
        el.dataset.i = i;
        el.offer = o;
        const picks = two ? PANEL_KEYS.two[i].picks : PANEL_KEYS.solo.picks;
        el.innerHTML = `<div class="offer-head"><span class="offer-lvl">Level ${o.level}</span><span class="offer-sub">${two ? esc(p.name) + ' · ' : ''}Choose an upgrade · invulnerable briefly</span><span class="offer-timer"><i></i></span></div>
          <div class="offer-cards">${o.options.map((op, k) => `<button type="button" class="offer-card" data-k="${k}">${partIcon(op.id)}<span class="oc-slot">${SLOT_NAMES[op.slot]}</span><span class="oc-name">${PARTS[op.slot][op.id].name}</span><span class="oc-desc">${PARTS[op.slot][op.id].desc}</span><kbd>${picks[k]}</kbd></button>`).join('')}</div>`;
        el.querySelectorAll('.offer-card').forEach(b => b.addEventListener('click', () => { game.pickOffer(p, +b.dataset.k); this.app.sfx.play('click'); }));
        $('offers').appendChild(el);
        this.offerEls[i] = el;
        // Cards take clicks only after a moment, so a panel popping up mid-fight doesn't eat shots.
        setTimeout(() => el.classList.add('armed'), 450);
      }
      el.querySelector('.offer-timer i').style.width = (clamp((o.expires - game.time) / OFFER.time, 0, 1) * 100).toFixed(1) + '%';
    });
  }

  updatePanel(game, p, el, auto, owner) {
    if (el.shown !== p) {
      el.shown = p;
      const watching = p !== owner;
      el.root.classList.toggle('watching', watching);
      el.name.innerHTML = watching ? `<span class="pp-watch">Watching</span>${esc(p.name)}` : esc(p.name);
      const pc = watching ? p.color.ui : el.pc;
      if (pc) el.root.style.setProperty('--pc', pc); else el.root.style.removeProperty('--pc');
    }
    // One armor segment per average hit, capped so a Juggernaut bar stays readable.
    const segs = Math.min(12, Math.max(1, Math.round(p.maxHp / TANK.shellDamage)));
    if (el.segs !== segs) { el.segs = segs; el.root.style.setProperty('--segs', segs); }
    el.auto.classList.toggle('on', !!auto);
    const cost = game.specialCost(p), mf = clamp(p.missileCharge / cost, 0, 1);
    el.msFill.style.width = (mf * 100).toFixed(1) + '%';
    const ready = mf >= 1;
    const spName = PART_SHORT[p.loadout.special];
    const msTxt = p.boostT > 0 ? 'Overdrive' : p.repairT > 0 ? 'Repairing' : p.flakT > 0 ? 'Anti-air · ' + Math.ceil(p.flakT) + 's'
      : p.grenadeAmmo > 0 ? 'Grenades · 1 loaded' : ready ? spName + ' ready' : spName;
    el.msRow.classList.toggle('ready', ready || p.grenadeAmmo > 0);
    if (el.msLbl.textContent !== msTxt) el.msLbl.textContent = msTxt;
    if (el.xpFill) {
      const lvl = p.level, lo = lvl > 1 ? XP.levels[lvl - 2] : 0, hi = XP.levels[lvl - 1];
      const xp = Math.floor(p.stats.xp);
      el.xpFill.style.width = hi ? (clamp((xp - lo) / (hi - lo), 0, 1) * 100).toFixed(1) + '%' : '100%';
      const lv = 'LV ' + lvl, num = hi ? `${xp} / ${hi} XP` : `${xp} XP · max`;
      if (el.xpLvl.textContent !== lv) el.xpLvl.textContent = lv;
      if (el.xpNum.textContent !== num) el.xpNum.textContent = num;
    }
    const hpf = clamp(p.hp / p.maxHp, 0, 1);
    el.hp.style.width = (hpf * 100).toFixed(1) + '%';
    const cls = 'pp-hp' + (p.repairing ? ' repair' : hpf < 0.3 ? ' low' : hpf < 0.6 ? ' mid' : '');
    if (el.hp.className !== cls) el.hp.className = cls;
    const num = game.oneShot ? (p.alive ? '1 HIT' : '0') : String(Math.ceil(Math.max(0, p.hp)));
    if (el.num.textContent !== num) el.num.textContent = num;
    // Machine gun / flamethrower: the bar shows heat instead of reload.
    const mg = p.loadout.weapon === 'mg' || p.loadout.weapon === 'flame';
    const rl = p.alive ? (mg ? p.heat / 100 : 1 - p.reload / p.reloadTime) : 0;
    el.rl.style.width = (rl * 100).toFixed(1) + '%';
    el.rl.classList.toggle('heat', mg);
    const txt = !p.alive ? '—' : p.repairing ? 'REPAIRING' : mg ? (p.overheatT > 0 ? 'OVERHEAT' : 'HEAT') : rl >= 1 ? 'READY' : 'LOADING';
    const lcls = 'pp-lbl' + (p.repairing && p.alive ? ' fix' : mg ? (p.overheatT > 0 ? ' hot' : '') : rl >= 1 ? '' : ' wait');
    if (el.lbl.textContent !== txt) el.lbl.textContent = txt;
    if (el.lbl.className !== lcls) el.lbl.className = lcls;
    const kd = game.settings.mode === 'jug' ? `${Math.floor(p.score)} pts · ${plural(p.stats.kills, 'kill')}`
      : plural(p.stats.kills, 'kill') + ' · ' + plural(p.stats.deaths, 'death');
    if (el.kd.textContent !== kd) el.kd.textContent = kd;
  }

  scoreboard(game, humans) {
    const h = game.mode.hud();
    const coop = humans.length > 1;
    let html;
    if (h.kind === 'escort') {
      const m = game.mode, [a, b] = game.teams;
      const res = team => {
        const r = m.results.find(x => x.attackers === team);
        if (!r) return m.attackers === team && m.state === 'round' ? `${Math.round(m.convoy.maxHp - Math.max(0, m.convoy.hp))}` : '—';
        return r.destroyed ? '☠ ' + fmtTime(r.time) : String(r.damage);
      };
      const lab = team => (game.settings.versus ? ' · ' + esc(humans[team] ? humans[team].name : '') : team ? '' : coop ? ' · P1 + P2' : ' · ' + esc(humans[0].name));
      const side = (t, right) => `<div class="sb-team ${right ? 'right' : ''}"><span class="nm" style="color:${t.color.ui}">${t.name}${lab(t.id)}</span><span class="sc" style="color:${shade(t.color.ui, 0.35)};font-size:26px">${res(t.id)}</span><span class="nm" style="opacity:.6">${m.attackers === t.id && m.state === 'round' ? 'attacking' : m.defenders === t.id && m.state === 'round' ? 'escorting' : 'convoy dmg'}</span></div>`;
      const c = m.convoy, hpf = c ? clamp(c.hp / c.maxHp, 0, 1) : 0;
      const mid = m.state === 'break' ? `<span class="sb-clock">${Math.ceil(m.breakT)}</span><span class="sb-goal">Round 2 soon</span>`
        : `<span class="sb-clock">${fmtTime(m.eta)}</span><span class="sb-goal">Round ${m.round + 1} · to extraction</span>`;
      html = `<div class="sb-main">${side(a, false)}<div class="sb-mid">${mid}</div>${side(b, true)}</div>`;
      if (m.state === 'round' && c) html += `<div class="sb-status"><span><span class="dot" style="background:${game.teams[m.defenders].color.ui}"></span>Convoy <b>${Math.round(hpf * 100)}%</b> · ${Math.round(c.progress * 100)}% of the way</span></div>`;
    } else if (h.kind === 'jug') {
      const j = game.mode.jug, low = game.clock < 30 && game.phase === 'live';
      const mine = humans.length > 1 ? humans.map(p => Math.floor(p.score)).join(' / ') : Math.floor(humans[0].score);
      const lead = game.mode.ranking()[0];
      html = `<div class="sb-main">
        <div class="sb-team"><span class="nm" style="color:#ffc850">Juggernaut</span><span class="sc" style="color:${j ? shade(j.color.ui, 0.35) : 'var(--ink)'}; font-size:24px">${j ? esc(j.name) : '—'}</span><div class="sb-bar"><i style="width:${j ? (clamp(j.hp / j.maxHp, 0, 1) * 100).toFixed(1) : 0}%;background:#ffc850"></i></div></div>
        <div class="sb-mid"><span class="sb-clock ${low ? 'low' : ''}">${fmtTime(game.clock)}</span><span class="sb-goal">${game.mode.overtime ? 'Overtime' : 'Most points wins'}</span></div>
        <div class="sb-team right"><span class="nm">${humans.length > 1 ? 'P1 / P2 points' : 'Your points'}</span><span class="sc">${mine}</span></div>
      </div>
      <div class="sb-status"><span>Leader <b style="color:${lead.color.ui}">${esc(lead.name)}</b> · ${Math.floor(lead.score)} pts</span></div>`;
    } else if (h.kind === 'br') {
      const m = game.mode, alive = game.tanks.filter(t => t.alive).length;
      const zoneTxt = m.state === 'shrink' ? 'Zone closing' : m.state === 'done' ? 'Final zone' : 'Zone closes in';
      const clock = m.state === 'wait' || m.state === 'shrink' ? fmtTime(m.timer) : '—';
      const kills = game.settings.versus ? humans.map(p => p.stats.kills).join(' / ') : humans.reduce((a, p) => a + p.stats.kills, 0);
      html = `<div class="sb-main">
        <div class="sb-team"><span class="nm">Alive</span><span class="sc">${alive}<small style="font-size:16px;color:var(--ink-dim)"> / ${game.tanks.length}</small></span></div>
        <div class="sb-mid"><span class="sb-clock ${m.state === 'shrink' ? 'low pulse' : ''}">${clock}</span><span class="sb-goal">${zoneTxt}</span></div>
        <div class="sb-team right"><span class="nm">${game.settings.versus ? 'P1 / P2 kills' : coop ? 'Duo kills' : 'Your kills'}</span><span class="sc">${kills}</span></div>
      </div>`;
    } else {
      const [a, b] = game.teams;
      const sa = Math.floor(a.score), sb = Math.floor(b.score);
      const pa = clamp(a.score / h.target, 0, 1) * 100, pb = clamp(b.score / h.target, 0, 1) * 100;
      const low = game.clock < 30 && game.phase === 'live';
      const versus = game.settings.versus;
      const myTeam = humans.length ? humans[0].team : 0;
      const tag = right => versus ? ' · ' + esc(humans[right ? 1 : 0].name)
        : coop ? (right ? '' : ' · P1 + P2')
        : ((right ? 1 : 0) === myTeam ? ' · ' + esc(humans[0].name) : '');
      const team = (t, s, p, right) => `<div class="sb-team ${right ? 'right' : ''}"><span class="nm" style="color:${t.color.ui}">${t.name}${tag(right)}</span><span class="sc" style="color:${shade(t.color.ui, 0.35)}">${s}</span><div class="sb-bar"><i style="width:${p.toFixed(1)}%;background:${t.color.ui}"></i></div></div>`;
      const goal = game.mode.overtime ? 'Overtime' : `First to ${h.target} ${h.label}`;
      html = `<div class="sb-main">${team(a, sa, pa, false)}
        <div class="sb-mid"><span class="sb-clock ${low ? 'low' : ''}">${fmtTime(game.clock)}</span><span class="sb-goal">${goal}</span></div>
        ${team(b, sb, pb, true)}</div>`;
      const st = this.statusLine(game);
      if (st) html += `<div class="sb-status">${st}</div>`;
    }
    if (html !== this.lastSb) {
      $('scoreboard').innerHTML = html;
      this.lastSb = html;
    }
  }

  statusLine(game) {
    const m = game.mode;
    if (m instanceof HardcoreMode) {
      const pips = team => game.tanks.filter(t => t.team === team).map(t => `<i class="hc-pip${t.alive ? '' : ' out'}" style="--c:${game.teams[team].color.ui}"></i>`).join('');
      const mid = m.state === 'break' ? `Next round in ${Math.max(1, Math.ceil(m.breakT))}` : `Round ${m.round + 1}`;
      return `<span class="hc-side">${pips(0)}</span><span><b>${mid}</b></span><span class="hc-side">${pips(1)}</span>`;
    }
    if (m instanceof OneShotMode) return '<span><span class="dot" style="background:#ff6b52"></span><b>One Shot</b> · every hit kills</span>';
    if (game.visibility) {
      const v = { night: ['#8fb4ff', 'Night', 'stay near your lights'], fog: ['#d8dde0', 'Fog', 'tanks appear at close range'], sandstorm: ['#e0b070', 'Sandstorm', 'visibility is low'] }[game.visibility];
      return `<span><span class="dot" style="background:${v[0]}"></span><b>${v[1]}</b> · ${v[2]}</span>`;
    }
    if (m instanceof KOTHMode) {
      if (m.contested) return '<span class="pulse"><span class="dot" style="background:#ffd35a"></span><b>Hill contested</b></span>';
      if (m.owner >= 0) {
        const t = game.teams[m.owner];
        const cap = m.progress < 1 ? ` · ${Math.round(m.progress * 100)}%` : '';
        return `<span><span class="dot" style="background:${t.color.ui}"></span><b style="color:${t.color.ui}">${t.name}</b> holds the hill${cap}</span>`;
      }
      if (m.capTeam >= 0 && m.progress > 0) {
        const t = game.teams[m.capTeam];
        return `<span><span class="dot" style="background:${t.color.ui}"></span><b style="color:${t.color.ui}">${t.name}</b> capturing ${Math.round(m.progress * 100)}%</span>`;
      }
      return '<span><span class="dot" style="background:#f3ecd6"></span>Hill neutral</span>';
    }
    if (m instanceof CTFMode) {
      const part = f => {
        const t = game.teams[f.team];
        const who = game.settings.versus ? t.name + ' flag' : f.team === 0 ? 'Your flag' : 'Enemy flag';
        const state = f.state === 'home' ? 'at base' : f.state === 'carried' ? `taken by <b>${esc(f.carrier.name)}</b>` : `dropped · ${Math.ceil(f.dropT)}s`;
        return `<span class="${f.state === 'home' ? '' : 'pulse'}"><span class="dot" style="background:${t.color.ui}"></span>${who} ${state}</span>`;
      };
      return part(m.flags[0]) + part(m.flags[1]);
    }
    return '';
  }

  renderTab(game) {
    const row = t => `<tr class="${t.isPlayer ? 'me' : ''} ${t.alive ? '' : 'dead'}"><td><span class="pip" style="background:${t.color.ui}"></span>${game.leveling ? '<small style="color:#ffc850">' + t.level + '</small> ' : ''}${esc(t.name)}</td><td>${t.skill ? t.skill.name : 'Player'}</td><td>${Math.floor(t.stats.xp)}</td><td>${t.stats.kills}</td><td>${t.stats.deaths}</td><td>${Math.round(t.stats.damage)}</td></tr>`;
    const head = '<tr><th>Tank</th><th>Crew</th><th>Score</th><th>K</th><th>D</th><th>Dmg</th></tr>';
    const sortK = (a, b) => b.stats.kills - a.stats.kills || a.stats.deaths - b.stats.deaths;
    let html;
    if (game.def.teams) {
      html = '<div class="tb-cols">' + game.teams.map(tm => {
        const list = game.tanks.filter(t => t.team === tm.id && !t.isConvoy).sort((a, b) => b.stats.xp - a.stats.xp);
        return `<div><div class="tb-head" style="color:${tm.color.ui}"><span>${tm.name}</span><span>${Math.floor(tm.score)}</span></div><table class="board">${head}${list.map(row).join('')}</table></div>`;
      }).join('') + '</div>';
    } else if (game.settings.mode === 'jug') {
      const jrow = t => `<tr class="${t.isPlayer ? 'me' : ''} ${t.alive ? '' : 'dead'}"><td><span class="pip" style="background:${t.color.ui}"></span>${t.jug ? '♛ ' : ''}${esc(t.name)}</td><td>${t.skill ? t.skill.name : 'Player'}</td><td>${Math.floor(t.score)}</td><td>${t.stats.kills}</td><td>${t.stats.deaths}</td></tr>`;
      html = `<div class="tb-head"><span>Juggernaut</span><span>${fmtTime(game.clock)} left</span></div><table class="board"><tr><th>Tank</th><th>Crew</th><th>Pts</th><th>K</th><th>D</th></tr>${game.mode.ranking().map(jrow).join('')}</table>`;
    } else {
      const list = game.tanks.slice().sort((a, b) => (b.alive - a.alive) || sortK(a, b));
      html = `<div class="tb-head"><span>Battle Royale</span><span>${game.tanks.filter(t => t.alive).length} alive</span></div><table class="board">${head}${list.map(row).join('')}</table>`;
    }
    const tb = $('tabboard');
    if (tb.innerHTML !== html) tb.innerHTML = html;
  }

  // ---- event-driven bits --------------------------------------------------------------
  killfeedAdd(e) {
    const k = e.killer, v = e.victim;
    const li = document.createElement('li');
    if ((k && k.isPlayer) || v.isPlayer) li.className = 'me';
    const name = t => `<span style="color:${shade(t.color.ui, 0.25)}">${esc(t.name)}</span>`;
    li.innerHTML = k && k !== v ? `${name(k)}${FEED_ICON}${name(v)}` : `${ZONE_ICON}${name(v)}`;
    const list = $('killfeed');
    list.prepend(li);
    while (list.children.length > 6) list.lastChild.remove();
    setTimeout(() => li.classList.add('out'), 5200);
    setTimeout(() => li.remove(), 5800);
  }

  announce(text, sub, color) {
    const box = $('announce');
    const d = document.createElement('div');
    d.className = 'ann';
    d.innerHTML = `<div class="t" style="color:${color || 'var(--ink)'}">${esc(text)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}`;
    box.prepend(d);
    while (box.children.length > 2) box.lastChild.remove();
    setTimeout(() => d.remove(), 3300);
  }

  go() {
    $('center-msg').innerHTML = '<div class="count go">GO</div>';
    setTimeout(() => { if ($('center-msg').querySelector('.go')) $('center-msg').innerHTML = ''; }, 900);
  }

  killConfirm(victim, killer) {
    const c = $('center-msg');
    if (c.querySelector('.count')) return;
    const who = this.game && this.game.players.length > 1 ? `<span style="color:${PLAYER_COLORS[killer.humanIndex]}">${esc(killer.name)}</span> destroyed` : 'Destroyed';
    c.innerHTML = `<div class="kill-confirm">${who} <b>${esc(victim.name)}</b></div>`;
    clearTimeout(this.kcT);
    this.kcT = setTimeout(() => { if (c.querySelector('.kill-confirm')) c.innerHTML = ''; }, 1600);
  }

  // Battle royale: shown once every human player is out.
  showBROut(game) {
    if (this.brDismissed) return;
    const humans = game.players, total = game.tanks.length;
    const place = Math.min(...humans.map(p => p.place || total));
    $('br-place').innerHTML = `#${place}<small> of ${total}</small>`;
    const last = humans.slice().sort((a, b) => (a.place || 99) - (b.place || 99))[0];
    const k = last.killedBy;
    $('br-by').innerHTML = k && !k.isPlayer ? `Destroyed by <b style="color:${k.color.ui}">${esc(k.name)}</b>` : 'Caught outside the zone';
    $('br-out').hidden = false;
  }

  showPause(show) {
    $('pause').hidden = !show;
    document.body.classList.toggle('playing', !show);
  }

  showEnd(game, camp) {
    const humans = game.players, p = humans[0], s = game.settings, coop = humans.length > 1;
    $('br-out').hidden = true;
    $('spectate').hidden = true;
    $('tabboard').hidden = true;
    this.deathCards.forEach(c => (c.hidden = true));
    document.body.classList.remove('playing');
    const diff = DIFFICULTIES.find(d => d.id === s.difficulty).name;
    const sizeLbl = game.def.teams ? (s.teamSizes ? `${s.teamSizes[0]}v${s.teamSizes[1]}` : `${s.size}v${s.size}`) : `${s.size} tanks`;
    const party = s.versus ? ' · Versus' : coop ? ' · Co-op' : '';
    $('end-eyebrow').textContent = camp
      ? `${CAMPAIGN.regions[camp.level.region].name} · ${camp.level.name} · ${game.def.name} ${sizeLbl} · ${fmtTime(game.time)}`
      : `${game.def.name} · ${sizeLbl} · ${diff}${party} · ${fmtTime(game.time)}`;
    const title = $('end-title'), sub = $('end-sub');
    let result;
    const jug = s.mode === 'jug';
    if (jug) {
      // Juggernaut: ranked by points.
      const top = game.winnerTank || game.mode.ranking()[0];
      const human = humans.includes(top) ? top : null;
      const best = humans.slice().sort((a, b) => a.place - b.place)[0];
      result = human ? 'win' : 'lose';
      if (coop) {
        title.textContent = human ? `${human.name} wins` : `#${best.place}`;
        title.style.color = human ? PLAYER_COLORS[human.humanIndex] : '';
        sub.textContent = humans.map(q => `${q.name} ${ordinal(q.place)} · ${Math.floor(q.score)} pts`).join('  ·  ') + (human ? '' : `  ·  ${top.name} won with ${Math.floor(top.score)}`);
      } else {
        title.style.color = '';
        title.textContent = human ? 'Winner' : `#${p.place}`;
        sub.textContent = human ? `Top score: ${Math.floor(p.score)} points` : `You scored ${Math.floor(p.score)} · ${top.name} won with ${Math.floor(top.score)}`;
      }
    } else if (s.versus && s.mode === 'escort') {
      const champ = game.winner === null ? null : humans.find(q => q.team === game.winner) || null;
      result = champ ? 'win' : 'draw';
      title.textContent = champ ? `${champ.name} wins` : 'Draw';
      title.style.color = champ ? PLAYER_COLORS[champ.humanIndex] : '';
      sub.textContent = this.escortSummary(game);
    } else if (s.versus) {
      // Versus: which player came out on top.
      let champ = null;
      if (game.def.teams) champ = game.winner === null ? null : humans.find(q => q.team === game.winner) || null;
      else {
        const place = q => (q.alive ? 1 : q.place || 99);
        champ = place(humans[0]) === place(humans[1]) ? null : place(humans[0]) < place(humans[1]) ? humans[0] : humans[1];
      }
      result = champ ? 'win' : 'draw';
      title.textContent = champ ? `${champ.name} wins` : 'Draw';
      title.style.color = champ ? PLAYER_COLORS[champ.humanIndex] : '';
      if (game.def.teams) {
        const [a, b] = game.teams;
        sub.textContent = `${a.name} ${Math.floor(a.score)} – ${Math.floor(b.score)} ${b.name}`;
      } else {
        sub.textContent = humans.map(q => `${q.name} placed ${ordinal(q.alive ? 1 : q.place || game.tanks.length)}`).join(' · ') + ` of ${game.tanks.length}`;
      }
    } else if (game.def.teams) {
      title.style.color = '';
      result = game.winner === null ? 'draw' : game.winner === p.team ? 'win' : 'lose';
      title.textContent = result === 'win' ? 'Victory' : result === 'lose' ? 'Defeat' : 'Draw';
      const [a, b] = game.teams;
      sub.textContent = s.mode === 'escort' ? this.escortSummary(game) : `${a.name} ${Math.floor(a.score)} – ${Math.floor(b.score)} ${b.name}`;
    } else {
      title.style.color = '';
      const won = game.winner === p.team;
      const place = won ? 1 : Math.min(...humans.map(q => q.place || 2));
      result = won ? 'win' : 'lose';
      title.textContent = won ? 'Winner' : `#${place}`;
      const you = coop ? 'Your duo' : 'You';
      sub.textContent = won ? `${coop ? 'Last duo' : 'Last tank'} standing out of ${game.tanks.length}` : `${you} placed ${ordinal(place)} of ${game.tanks.length}`;
    }
    title.className = 'end-title ' + (result === 'win' ? 'win' : result === 'lose' ? 'lose' : '');

    const cards = q => {
      const acc = q.stats.shots ? Math.round((q.stats.hits / q.stats.shots) * 100) + '%' : '—';
      const stats = [['Kills', q.stats.kills], ['Deaths', q.stats.deaths], ['Damage', Math.round(q.stats.damage)], ['Accuracy', acc]];
      if (s.mode === 'ctf') stats.push(['Captures', q.stats.caps]);
      if (s.mode === 'escort') stats.push(['Convoy dmg', Math.round(q.stats.convoy)]);
      if (jug) stats.unshift(['Points', Math.floor(q.score)]);
      else stats.unshift(['Score', Math.floor(q.stats.xp)]);
      return stats.map(([k, v]) => `<div class="stat"><span class="v">${v}</span><span class="k">${k}</span></div>`).join('');
    };
    $('end-stats').innerHTML = coop
      ? humans.map((q, i) => `<div class="stat-row"><span class="who" style="color:${PLAYER_COLORS[i]}">${esc(q.name)}</span><div class="stats">${cards(q)}</div></div>`).join('')
      : `<div class="stats">${cards(p)}</div>`;

    // Team modes get the Lobby / Team ladder toggle; free-for-all modes rank by placement.
    this.endGame = game;
    const tabs = $('ladder-tabs');
    tabs.hidden = !game.def.teams;
    this.renderLadder(game.def.teams ? 'lobby' : 'place');
    this.renderMissionResult(camp);
    $('e-again').textContent = camp ? 'Retry' : 'Play again';
    $('e-menu').textContent = camp ? 'Continue' : 'Main menu';
    $('e-menu').className = camp ? 'btn' : 'btn ghost';
    $('e-again').className = camp ? 'btn ghost' : 'btn';
    $('end').hidden = false;
    return result;
  }

  // Campaign: stars (lit one by one), mastery conditions and the payout.
  renderMissionResult(camp) {
    const box = $('end-camp');
    box.hidden = !camp;
    if (!camp) return;
    const { ev, pay } = camp;
    $('ec-stars').innerHTML = ev.flags.map((on, i) => `<span class="ec-star${on ? ' on' : ''}" style="animation-delay:${0.25 + i * 0.35}s">${STAR_SVG}</span>`).join('');
    $('ec-conds').innerHTML = ev.conds.map((c, i) => `<li class="${c.ok ? 'ok' : ''}"><span class="ec-mark">${c.ok ? '✓' : '✗'}</span>${esc(c.text)}${pay.stars[i] && !c.ok ? '<small>earned before</small>' : ''}</li>`).join('');
    $('ec-pay').innerHTML = pay.lines.map(([k, v]) => `<div><span>${esc(k)}</span><b>+${fmtMoney(v)}</b></div>`).join('') +
      `<div class="ec-total"><span>Total · balance ${fmtMoney(this.cp.money)}</span><b>+${fmtMoney(pay.total)}</b></div>`;
    ev.flags.forEach((on, i) => { if (on) setTimeout(() => this.app.sfx.play('star'), 250 + i * 350); });
    setTimeout(() => this.app.sfx.play('coin'), 350 + ev.flags.length * 350);
  }

  // ---- campaign ------------------------------------------------------------------------------
  renderCampaignCard() {
    const save = this.cp, front = CAMPAIGN_LEVELS[frontierLevel(save)], stars = totalStars(save);
    const done = CAMPAIGN_LEVELS.filter(l => levelStars(save, l.id)[0]).length;
    $('cpc-stars').innerHTML = `${STAR_SVG}${stars} / ${CAMPAIGN_MAX_STARS}`;
    $('cpc-next').innerHTML = done === CAMPAIGN_LEVELS.length
      ? '<b>All missions complete</b> · new regions are on the way'
      : `Next: <b>${esc(front.name)}</b> · ${CAMPAIGN.regions[front.region].name} · ${MODES[front.mode].name}`;
    $('cpc-bar').style.width = (done / CAMPAIGN_LEVELS.length * 100).toFixed(1) + '%';
    $('cpc-money').textContent = fmtMoney(save.money);
    $('cpc-prog').textContent = `${done} of ${CAMPAIGN_LEVELS.length} missions`;
    $('cpc-pilot').textContent = save.pilot;
  }

  showCampaign() {
    $('title').hidden = true;
    $('online').hidden = true;
    $('menu').hidden = true;
    $('hud').hidden = true;
    $('end').hidden = true;
    $('pause').hidden = true;
    $('hangar').hidden = true;
    $('campaign').hidden = false;
    document.body.classList.remove('playing');
    if (!this.world) this.world = new WorldMap($('world'), this);
    this.renderWallet();
    this.world.open(this.cp);
  }

  renderWallet() {
    $('cp-pilot').innerHTML = `<span class="cp-pl">Pilot</span>${esc(this.cp.pilot)}`;
    $('cp-stars').innerHTML = `${STAR_SVG}${totalStars(this.cp)}<small> / ${CAMPAIGN_MAX_STARS}</small>`;
    $('cp-money').textContent = fmtMoney(this.cp.money);
    $('hg-money').textContent = fmtMoney(this.cp.money);
  }

  renderBrief(n) {
    const el = $('cp-brief'), save = this.cp, reg = CAMPAIGN.regions[n.region];
    const head = `<p class="br-region">Region ${ROMAN[n.region]} · ${esc(reg.name)}</p>`;
    if (n.ghost) {
      this.briefLevel = null;
      el.innerHTML = head + `<h3 class="br-name">Coming soon</h3><p class="br-text">${reg.soon ? 'This front opens in a future update. The road is already built.' : 'More missions are on the way.'}</p>`;
      return;
    }
    const L = n.level, st = levelStars(save, L.id), open = levelUnlocked(save, L.order), m = MODES[L.mode];
    const size = L.sizes ? `${L.sizes[0]}v${L.sizes[1]}` : `${L.size} tanks`;
    const twists = missionTwists(L);
    const skill = Math.round(L.foes.reduce((a, b) => a + b, 0) / L.foes.length);
    const tech = `<span class="tier">${[0, 1, 2, 3, 4, 5].map(i => `<i class="${i < L.tier ? 'on' : ''}"></i>`).join('')}</span>`;
    const conds = ['Win the mission', ...L.stars.map(condText)];
    el.innerHTML = head +
      `<h3 class="br-name">${L.boss ? '<span class="br-boss">Boss</span>' : `<span class="br-num">${n.j + 1}</span>`}${esc(L.name)}</h3>
      <div class="br-mode">${ICONS[L.mode]}<span>${m.name}</span><b>${size}</b></div>
      <p class="br-text">${esc(L.brief)}</p>
      ${twists.length ? `<ul class="br-twists">${twists.map(t => `<li><b>${t.name}</b>${esc(t.desc)}</li>`).join('')}</ul>` : ''}
      <div class="br-intel"><span>Enemy crews <span class="chev">${'<i></i>'.repeat(skill)}</span> ${SKILLS[skill - 1].name}</span><span>Enemy tech ${tech}</span></div>
      <ul class="br-stars">${conds.map((c, i) => `<li class="${st[i] ? 'got' : ''}">${STAR_SVG}<span>${esc(c)}</span></li>`).join('')}</ul>
      <div class="br-reward"><span>Reward</span><b>${fmtMoney(st[0] ? L.reward * 0.35 : L.reward)}</b><small>${st[0] ? 'replay · ' : ''}+${fmtMoney(L.reward * 0.5)} per new star</small></div>
      ${open ? '<button type="button" class="deploy" id="cp-deploy">Deploy <kbd>Enter</kbd></button>' : '<p class="br-locked">Win the previous mission to unlock this one.</p>'}`;
    this.briefLevel = open ? L : null;
    if (open) $('cp-deploy').addEventListener('click', () => this.app.startMission(L));
  }

  // ---- hangar ----------------------------------------------------------------------------------
  showHangar() {
    $('campaign').hidden = true;
    $('hangar').hidden = false;
    this.hgSel = null;
    if (!this.preview) this.preview = new HangarPreview($('hg-preview'));
    this.preview.resize();
    this.renderHangar();
  }

  // Numbers for the stat panel from a loadout plus the workshop upgrades.
  buildStats(L, save) {
    const hull = PARTS.hull[L.hull], tire = PARTS.tires[L.tires], w = L.weapon;
    const hp = 140 * hull.hpMul * (1 + UPGRADES.hp * save.armor), dm = 1 + UPGRADES.dmg * save.gun;
    const shot = { cannon: 20, double: 40, twin: 40, mg: 6, bazooka: 46, flame: 3, longgun: 32, coax: 20, hesh: HESH.damage + HESH.splashDamage, wire: WIRE.damage }[w] * dm;
    const dps = w === 'flame' ? (FLAME.damage / PARTS.weapon.flame.reload + FLAME.burn) * dm
      : w === 'coax' ? (shot / PARTS.weapon.coax.reload + COAX.damage / COAX.interval * 0.85 * dm)
      : shot / PARTS.weapon[w].reload * (w === 'twin' ? 0.5 : 1);
    const spd = TANK.maxSpeed * hull.speedMul;
    return { hp, shot, dps, road: spd * tire.road, off: spd * tire.off, water: spd * tire.water, flame: w === 'flame', special: PARTS.special[L.special].name };
  }

  renderHangar() {
    const save = this.cp, E = save.equip, sel = this.hgSel;
    const P = sel ? Object.assign({}, E, { [sel.slot]: sel.id }) : E;
    this.renderWallet();
    this.preview.setLoadout(P);
    $('hg-previewing').hidden = !sel;
    if (sel) $('hg-previewing').innerHTML = `Previewing <b>${PARTS[sel.slot][sel.id].name}</b>`;
    // Stats of the build on the turntable, with the change from what's fitted now.
    const now = this.buildStats(E, save), nx = this.buildStats(P, save);
    const bar = (v, max) => `<span class="hg-bar"><i style="width:${clamp(v / max, 0, 1) * 100}%"></i></span>`;
    const delta = (a, b, fmt = Math.round) => {
      if (!sel || Math.abs(b - a) < 0.5) return '';
      return `<em class="${b > a ? 'up' : 'down'}">${b > a ? '▲' : '▼'} ${fmt(Math.abs(b - a))}</em>`;
    };
    $('hg-stats').innerHTML = [
      ['Armor', Math.round(nx.hp) + delta(now.hp, nx.hp), bar(nx.hp, 320)],
      ['Damage / shot', (nx.flame ? `${nx.shot.toFixed(1)} + burn` : Math.round(nx.shot)) + delta(now.shot, nx.shot), bar(nx.shot, 50)],
      ['Firepower', Math.round(nx.dps) + ' dps' + delta(now.dps, nx.dps), bar(nx.dps, 70)],
      ['Speed', `${Math.round(nx.road)} road · ${Math.round(nx.off)} field · ${Math.round(nx.water)} water` + delta(now.road + now.off, nx.road + nx.off), bar(Math.max(nx.road, nx.off), 270)],
      ['Special', nx.special, ''],
    ].map(([k, v, b]) => `<div class="hg-stat"><span class="k">${k}</span><span class="v">${v}</span>${b}</div>`).join('');
    // Workshop upgrades.
    const ups = [['armor', 'Armor plating', `+${Math.round(UPGRADES.hp * 100)}% armor per level`], ['gun', 'Gun calibre', `+${Math.round(UPGRADES.dmg * 100)}% damage per level`]];
    $('hg-ups').innerHTML = ups.map(([key, name, desc]) => {
      const lv = save[key], cost = upgradeCost(lv), max = lv >= UPGRADES.max;
      return `<div class="hg-up"><div><b>${name}</b><small>${desc}</small></div>
        <span class="hg-pips">${Array.from({ length: UPGRADES.max }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</span>
        <button type="button" class="btn small${max || cost > save.money ? ' off' : ''}" data-up="${key}">${max ? 'Maxed' : 'Upgrade · ' + fmtMoney(cost)}</button></div>`;
    }).join('');
    $('hg-ups').querySelectorAll('button[data-up]').forEach(b => b.addEventListener('click', () => this.buyUpgrade(b.dataset.up)));
    // Part catalog for the selected slot.
    this.radio($('hg-tabs'), SLOTS.map(sl => ({ value: sl, label: SLOT_NAMES[sl] })), this.hgTab, v => { this.hgTab = v; this.hgSel = null; this.renderHangar(); }, it => it.label);
    const slot = this.hgTab;
    $('hg-parts').innerHTML = Object.keys(PARTS[slot]).map(id => {
      const part = PARTS[slot][id], owned = save.owned[slot].includes(id), eq = E[slot] === id;
      const tag = eq ? 'Equipped' : owned ? 'Owned' : fmtMoney(part.price);
      const cls = 'hg-part' + (eq ? ' eq' : owned ? ' own' : part.price > save.money ? ' poor' : '') + (sel && sel.slot === slot && sel.id === id ? ' sel' : '');
      return `<button type="button" class="${cls}" data-id="${id}" aria-pressed="${!!(sel && sel.id === id)}">${partIcon(id)}<span class="hp-name">${part.name}</span><span class="hp-desc">${part.desc}</span><span class="hp-tag">${tag}</span></button>`;
    }).join('');
    $('hg-parts').querySelectorAll('.hg-part').forEach(b => b.addEventListener('click', () => this.previewPart(slot, b.dataset.id)));
    this.renderHangarAction();
  }

  // The bar under the catalog: what's being previewed and what it would cost.
  renderHangarAction() {
    const bar = $('hg-action'), sel = this.hgSel, save = this.cp;
    if (!sel) {
      bar.innerHTML = '<p class="hg-hint">Pick a part to preview it on your tank. Nothing is bought until you confirm.</p>';
      return;
    }
    const part = PARTS[sel.slot][sel.id], owned = save.owned[sel.slot].includes(sel.id), short = part.price - save.money;
    const main = owned
      ? '<button type="button" class="btn" id="hg-buy">Equip</button>'
      : short > 0
        ? `<button type="button" class="btn off" id="hg-buy" disabled>Need ${fmtMoney(short)} more</button>`
        : `<button type="button" class="btn" id="hg-buy">Buy & equip · ${fmtMoney(part.price)}</button>`;
    bar.innerHTML = `<div class="hg-sel">${partIcon(sel.id)}<div><b>${part.name}</b><small>${owned ? 'Owned' : fmtMoney(part.price)} · ${SLOT_NAMES[sel.slot]}</small></div></div>
      <div class="hg-act-btns"><button type="button" class="btn ghost" id="hg-cancel">Cancel</button>${main}</div>`;
    $('hg-cancel').addEventListener('click', () => { this.app.sfx.play('click'); this.hgSel = null; this.renderHangar(); });
    const buy = $('hg-buy');
    if (!buy.disabled) buy.addEventListener('click', () => this.confirmPart());
  }

  previewPart(slot, id) {
    this.app.sfx.play('click');
    // Picking what's already fitted (or the same part again) ends the preview.
    this.hgSel = this.cp.equip[slot] === id || (this.hgSel && this.hgSel.slot === slot && this.hgSel.id === id) ? null : { slot, id };
    this.renderHangar();
  }

  buyUpgrade(key) {
    const save = this.cp, cost = upgradeCost(save[key]);
    if (cost > save.money) { this.app.sfx.play('click'); this.flashMoney(); return; }
    save.money -= cost;
    save[key]++;
    saveCampaign(save);
    this.app.sfx.play('upgrade');
    this.renderHangar();
  }

  confirmPart() {
    const save = this.cp, sel = this.hgSel;
    if (!sel) return;
    const { slot, id } = sel, P = PARTS[slot][id];
    if (!save.owned[slot].includes(id)) {
      if (P.price > save.money) { this.app.sfx.play('click'); this.flashMoney(); return; }
      save.money -= P.price;
      save.owned[slot].push(id);
      this.app.sfx.play('coin');
    } else this.app.sfx.play('upgrade');
    save.equip[slot] = id;
    this.hgSel = null;
    saveCampaign(save);
    this.renderHangar();
  }

  // ---- pilots (campaign saves) ------------------------------------------------------------
  showPilots() {
    this.renderPilots();
    $('pilot-name').value = '';
    $('pilots').hidden = false;
  }

  renderPilots() {
    const list = listPilots(), active = this.cp.id;
    $('pilot-list').innerHTML = list.map(p => {
      const done = missionsDone(p);
      return `<li class="pilot${p.id === active ? ' active' : ''}" data-id="${p.id}">
        <div class="pl-info"><div class="pl-name"><b>${esc(p.pilot)}</b>${p.id === active ? '<span class="pl-tag">Active</span>' : ''}</div>
          <small>${STAR_SVG}${totalStars(p)} / ${CAMPAIGN_MAX_STARS} · ${fmtMoney(p.money)} · ${done} of ${CAMPAIGN_LEVELS.length} missions</small></div>
        <div class="pl-btns">
          ${p.id === active ? '' : '<button type="button" class="btn small" data-act="play">Play</button>'}
          <button type="button" class="btn ghost small" data-act="rename">Rename</button>
          <button type="button" class="btn ghost small" data-act="reset">Restart</button>
          <button type="button" class="btn ghost small danger" data-act="delete">Delete</button>
        </div></li>`;
    }).join('');
    $('pilot-list').querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => {
      this.app.sfx.play('click');
      this.pilotAction(b.dataset.act, b.closest('.pilot').dataset.id);
    }));
    const full = list.length >= MAX_PILOTS;
    $('pilot-name').disabled = full;
    $('pilot-new').querySelector('button').disabled = full;
    $('pilot-name').placeholder = full ? `Up to ${MAX_PILOTS} pilots` : 'New pilot name';
  }

  pilotAction(act, id) {
    const p = loadPilot(id);
    if (!p) return;
    if (act === 'play') { this.switchPilot(setActivePilot(id)); return; }
    if (act === 'rename') {
      this.confirm({ title: 'Rename pilot', text: 'Shown on the scoreboard and ladders in campaign missions.', ok: 'Rename', input: p.pilot }, name => {
        renamePilot(p, name);
        if (p.id === this.cp.id) this.cp.pilot = p.pilot;
        this.afterPilotChange();
      });
    } else if (act === 'reset') {
      this.confirm({ title: `Restart ${p.pilot}'s campaign?`, text: 'All progress, stars, money and hangar upgrades for this pilot are wiped and the campaign starts again from the first mission. This can\'t be undone.', ok: 'Restart campaign', danger: true }, () => {
        const fresh = resetPilot(id);
        if (id === this.cp.id) this.switchPilot(fresh); else this.afterPilotChange();
      });
    } else if (act === 'delete') {
      this.confirm({ title: `Delete ${p.pilot}?`, text: 'This pilot and all of their campaign progress are removed for good. This can\'t be undone.', ok: 'Delete pilot', danger: true }, () => {
        deletePilot(id);
        if (id === this.cp.id) this.switchPilot(loadCampaign(this.settings.playerName || 'Pilot 1'));
        else this.afterPilotChange();
      });
    }
  }

  newPilot() {
    if (listPilots().length >= MAX_PILOTS) return;
    this.app.sfx.play('click');
    this.switchPilot(createPilot($('pilot-name').value));
    $('pilot-name').value = '';
  }

  switchPilot(save) {
    if (!save) return;
    this.cp = save;
    this.hgSel = null;
    this.afterPilotChange();
    if (this.world && !$('campaign').hidden) this.world.open(this.cp);
  }

  afterPilotChange() {
    this.renderPilots();
    this.renderWallet();
    if (this.settings.progression === 'campaign') this.renderCampaignCard();
    if (!$('hangar').hidden) this.renderHangar();
  }

  // In-page confirmation (no blocking browser dialogs). opts: { title, text, ok, danger, input }
  confirm(opts, onOk) {
    this.confirmCb = onOk;
    $('cf-title').textContent = opts.title;
    $('cf-text').textContent = opts.text || '';
    $('cf-ok').textContent = opts.ok || 'OK';
    $('cf-ok').className = 'btn' + (opts.danger ? ' danger' : '');
    const inp = $('cf-input');
    inp.hidden = opts.input === undefined;
    inp.maxLength = PILOT_MAX_LEN;
    inp.value = opts.input || '';
    $('confirm').hidden = false;
    (opts.input !== undefined ? inp : $('cf-cancel')).focus();
  }

  closeConfirm(ok) {
    this.app.sfx.play('click');
    $('confirm').hidden = true;
    const cb = this.confirmCb;
    this.confirmCb = null;
    if (ok && cb) cb($('cf-input').value);
  }

  flashMoney() {
    const el = $('hg-money');
    el.classList.remove('short'); void el.offsetWidth; el.classList.add('short');
  }

  escortSummary(game) {
    const txt = r => {
      const t = game.teams[r.attackers];
      return r.destroyed ? `${t.name} destroyed it in ${fmtTime(r.time)}` : `${t.name} dealt ${r.damage} damage`;
    };
    return game.mode.results.map(txt).join(' · ');
  }

  // lobby: every tank ranked by combat score (MVP on top). team: per-team tables.
  // place: free-for-all placement.
  renderLadder(kind) {
    const game = this.endGame, s = game.settings, jug = s.mode === 'jug', caps = s.mode === 'ctf', esc2 = s.mode === 'escort';
    for (const b of $('ladder-tabs').children) b.setAttribute('aria-checked', String(b.dataset.l === kind));
    $('ladder-label').textContent = kind === 'team' ? 'Team ladder' : kind === 'lobby' ? 'Lobby ladder' : 'Standings';
    const tanks = game.tanks.filter(t => !t.isConvoy);
    const extraH = (caps ? '<th>Caps</th>' : '') + (esc2 ? '<th>Convoy</th>' : '');
    const extra = t => (caps ? `<td>${t.stats.caps}</td>` : '') + (esc2 ? `<td>${Math.round(t.stats.convoy)}</td>` : '');
    const lvl = t => (game.leveling ? `<small style="color:#ffc850">Lv${t.level}</small> ` : '');
    let html;
    if (kind === 'place') {
      const placeOf = t => (jug ? t.place : t.alive ? 1 : t.place);
      const rows = tanks.slice().sort((x, y) => (placeOf(x) || 99) - (placeOf(y) || 99));
      html = `<tr><th>Place · Tank</th><th>Crew</th>${jug ? '<th>Pts</th>' : '<th>Score</th>'}<th>K</th><th>D</th><th>Dmg</th></tr>` +
        rows.map(t => `<tr class="${t.isPlayer ? 'me' : ''}"><td><span class="pip" style="background:${t.color.ui}"></span>#${placeOf(t)} · ${lvl(t)}${esc(t.name)}</td><td>${t.skill ? t.skill.name : 'Player'}</td><td>${Math.floor(jug ? t.score : t.stats.xp)}</td><td>${t.stats.kills}</td><td>${t.stats.deaths}</td><td>${Math.round(t.stats.damage)}</td></tr>`).join('');
    } else if (kind === 'lobby') {
      const rows = tanks.slice().sort((x, y) => y.stats.xp - x.stats.xp || y.stats.kills - x.stats.kills);
      html = `<tr><th># · Tank</th><th>Team</th><th>Crew</th><th>Score</th><th>K</th><th>A</th><th>D</th><th>Dmg</th>${extraH}</tr>` +
        rows.map((t, i) => `<tr class="${t.isPlayer ? 'me' : ''}"><td>${i + 1} · ${lvl(t)}${esc(t.name)}${i === 0 ? '<span class="mvp">MVP</span>' : ''}</td><td><span class="pip" style="background:${t.color.ui}"></span>${game.teams[t.team].name}</td><td>${t.skill ? t.skill.name : 'Player'}</td><td>${Math.floor(t.stats.xp)}</td><td>${t.stats.kills}</td><td>${t.stats.assists}</td><td>${t.stats.deaths}</td><td>${Math.round(t.stats.damage)}</td>${extra(t)}</tr>`).join('');
    } else {
      html = game.teams.map(tm => {
        const rows = tanks.filter(t => t.team === tm.id).sort((x, y) => y.stats.xp - x.stats.xp);
        return `<tr><th colspan="2" style="color:${tm.color.ui};text-align:left">${tm.name}</th><th>Score</th><th>K</th><th>A</th><th>D</th><th>Dmg</th>${extraH}</tr>` +
          rows.map(t => `<tr class="${t.isPlayer ? 'me' : ''}"><td><span class="pip" style="background:${t.color.ui}"></span>${lvl(t)}${esc(t.name)}</td><td>${t.skill ? t.skill.name : 'Player'}</td><td>${Math.floor(t.stats.xp)}</td><td>${t.stats.kills}</td><td>${t.stats.assists}</td><td>${t.stats.deaths}</td><td>${Math.round(t.stats.damage)}</td>${extra(t)}</tr>`).join('');
      }).join('');
    }
    $('end-board').innerHTML = html;
  }
}

function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
