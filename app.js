/* Wort. Laut. – EPUBs vorlesen lassen. Vanilla JS, keine Build-Tools. */
(function () {
  'use strict';
  const E = window.HBEpub;
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const audio = $('#audio');

  // ---------------- Einstellungen ----------------
  const DEFAULT_VOICES = [
    { id: 'de-DE-Seraphina:DragonHDLatestNeural', name: 'Seraphina HD', hd: true },
    { id: 'de-DE-Florian:DragonHDLatestNeural', name: 'Florian HD', hd: true },
    { id: 'de-DE-SeraphinaMultilingualNeural', name: 'Seraphina', multilingual: true },
    { id: 'de-DE-FlorianMultilingualNeural', name: 'Florian', multilingual: true },
    { id: 'de-DE-KatjaNeural', name: 'Katja' },
    { id: 'de-DE-ConradNeural', name: 'Conrad' },
    { id: 'de-DE-AmalaNeural', name: 'Amala' },
    { id: 'de-DE-KillianNeural', name: 'Killian' },
  ];
  const RATES = [0.85, 0.9, 1, 1.1, 1.2, 1.3];
  const CHARS_PER_SEC = 15.5; // ungefähr bei Tempo 1,0
  const isHD = (v) => /DragonHD/.test(v || '');
  const S = Object.assign(
    { code: '', ownKey: '', ownRegion: 'westeurope', voice: 'de-DE-SeraphinaMultilingualNeural', rate: 1, theme: 'auto', workerUrl: '', timer: 0, findMode: 'page', look: 'young' },
    JSON.parse(localStorage.getItem('wortlaut.settings') || '{}')
  );
  const saveSettings = () => localStorage.setItem('wortlaut.settings', JSON.stringify(S));
  // Timer ist jetzt optional: einmalig auf „Aus“ zurücksetzen
  if (!S.timerV2) { S.timer = 0; S.timerV2 = 1; saveSettings(); }
  const TIMER_OPTS = [['0', 'Aus'], ['15', '15'], ['30', '30'], ['60', '60'], ['sec', 'Kapitel']];
  const PAUSE_NEW_SESSION_MS = 15 * 60000; // nach so langer Pause beginnt eine neue Sitzung
  const workerUrl = () => (S.workerUrl || (window.HB_CONFIG && window.HB_CONFIG.workerUrl) || '').replace(/\/+$/, '');
  const hasCloudVoice = () => !!(workerUrl() && (S.code || S.ownKey));
  function authHeaders() {
    const h = {};
    if (S.ownKey) { h['X-Azure-Key'] = S.ownKey; h['X-Azure-Region'] = S.ownRegion || 'westeurope'; }
    if (S.code) h['X-Code'] = S.code;
    return h;
  }
  async function api(path, opts = {}) {
    const res = await fetch(workerUrl() + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Fehler ' + res.status), { status: res.status, code: data.code });
    return data;
  }

  // ---------------- Speicher (IndexedDB) ----------------
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('wortlaut', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const name of ['books', 'progress', 'quotes']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  const dbGet = (s, k) => tx(s, 'readonly', (o) => o.get(k));
  const dbAll = (s) => tx(s, 'readonly', (o) => o.getAll());
  const dbPut = (s, v) => tx(s, 'readwrite', (o) => o.put(v));
  const dbDel = (s, k) => tx(s, 'readwrite', (o) => o.delete(k));

  // ---------------- Hilfen ----------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = (s) => E.sentenceText(s);
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };
  const fmtHours = (chars) => {
    const h = chars / 60000;
    return h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1).replace('.', ',')} h`;
  };
  const pageLabel = (book, idx) => `${book.pageMarks ? '' : book.printPages ? 'ca. ' : '~'}S. ${E.pageOf(book, idx)}`;
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Satz kopiert'); }
    catch { prompt('Zum Kopieren markieren:', text); }
  }
  const PH_COLORS = [['#2F3B52', '#F1ECE4'], ['#D9B48F', '#3B2A18'], ['#8DA2B5', '#1C2433'], ['#9AA58C', '#232A1C'], ['#C8692E', '#2A160A'], ['#A29D76', '#232114']];
  function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
  const coverUrls = new Map();
  function coverHtml(book, cls = '') {
    if (book.cover) {
      if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(new Blob([book.cover.bytes], { type: book.cover.type })));
      return `<img class="cover ${cls}" src="${coverUrls.get(book.id)}" alt="Cover: ${esc(book.title)}">`;
    }
    const [bg, fg] = PH_COLORS[hash(book.title) % PH_COLORS.length];
    return `<div class="cover ph ${cls}" style="background:${bg};color:${fg}">${esc(book.title)}</div>`;
  }
  const I = {
    // Monogramm „w.“ mit klingendem Punkt (Logo von Wort. Laut.)
    mono: '<svg width="32" height="32" viewBox="0 0 200 200" aria-hidden="true"><rect width="200" height="200" rx="46" fill="#141414"/><g transform="translate(7 3)"><path d="M37.1 123.0 22.0 60.7H41.8L49.5 108.1H51.9L61.4 60.7H84.0L93.9 108.1H96.4L103.7 60.7H123.1L108.0 123.0H81.8L73.2 76.0H71.0L63.0 123.0Z" fill="#DDF35B"/><path d="M151.1 99.2 A18 18 0 0 1 151.1 126.8" fill="none" stroke="#FF5B3A" stroke-width="7" stroke-linecap="round"/><path d="M158.1 90.8 A29 29 0 0 1 158.1 135.2" fill="none" stroke="#FF5B3A" stroke-width="7" stroke-linecap="round" opacity=".5"/><circle cx="139.5" cy="113" r="10" fill="#FF5B3A"/></g></svg>',
    heart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.5l-1.4-1.3C5.6 14.7 2.5 11.9 2.5 8.4 2.5 5.6 4.7 3.5 7.4 3.5c1.6 0 3.1.7 4.6 2.2 1.5-1.5 3-2.2 4.6-2.2 2.7 0 4.9 2.1 4.9 4.9 0 3.5-3.1 6.3-8.1 10.8z"/></svg>',
    share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 14v5h14v-5"/></svg>',
    dots: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    // Logo-Zeichen ohne Kachel: Klangbögen (Akzent) über aufgeschlagenem Buch (Textfarbe)
    logo: '<svg width="30" height="22" viewBox="26 50 148 112" aria-hidden="true"><path d="M78 122 a22 22 0 0 1 44 0" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round"/><path d="M58 122 a42 42 0 0 1 84 0" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round" opacity=".6"/><path d="M38 122 a62 62 0 0 1 124 0" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round" opacity=".3"/><path d="M32 140 Q66 126 100 142 Q134 126 168 140" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round"/><path d="M36 156 Q68 143 100 158 Q132 143 164 156" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" opacity=".45"/></svg>',
    lib: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v16M9 4v16M13.5 5l4.5 14.5"/></svg>',
    ear: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="14" width="4" height="6" rx="1.5"/><rect x="16.5" y="14" width="4" height="6" rx="1.5"/></svg>',
    moon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    gauge: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
    pauseS: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    playM: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15l12-7.5z"/></svg>',
    back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    down: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg>',
    plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    play: '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15l12-7.5z"/></svg>',
    playS: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
    pause: '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
    prev: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/></svg>',
    next: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 7l5 5-5 5M6 7l5 5-5 5"/></svg>',
    copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  };

  // ---------------- Tag & Nacht (Sonnenstand, grob für Süddeutschland) ----------------
  function isNight(d = new Date()) {
    if (S.theme === 'day') return false;
    if (S.theme === 'night') return true;
    const lat = 48.78 * Math.PI / 180, lon = 9.18;
    const start = new Date(d.getFullYear(), 0, 0);
    const n = Math.floor((d - start) / 864e5);
    const decl = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + n) / 365);
    const ha = Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(decl)))) * 180 / Math.PI;
    const tz = -d.getTimezoneOffset() / 60;
    const noon = 12 - lon / 15 + tz;
    const h = d.getHours() + d.getMinutes() / 60;
    return h < noon - ha / 15 - 0.3 || h > noon + ha / 15 + 0.3;
  }
  const young = () => (S.look || 'young') === 'young';
  function applyTheme() {
    const y = young();
    const night = !y && isNight();
    document.body.classList.toggle('look-young', y);
    document.body.classList.toggle('night', night);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = y ? '#FAF7F2' : night ? '#1C2433' : '#EFE9E1';
  }

  // ---------------- Zustand ----------------
  const state = {
    book: null, progress: null, index: null, startIdx: null, hits: [], query: '', selHit: 0,
    me: null, voices: null,
  };
  async function loadBook(id) {
    if (state.book && state.book.id === id) return state.book;
    const book = await dbGet('books', id);
    if (!book) return null;
    state.book = book;
    state.index = null;
    state.progress = (await dbGet('progress', id)) || { id, pos: book.startAt || 0, last: null, lastAt: null };
    state.startIdx = null;
    return book;
  }
  function ensureIndex() { if (!state.index) state.index = E.buildIndex(state.book); return state.index; }
  async function saveProgress() { if (state.progress) await dbPut('progress', state.progress); }

  // ---------------- Router ----------------
  const routes = [];
  const route = (re, fn) => routes.push([re, fn]);
  // replace = true: ersetzt den aktuellen Eintrag im Verlauf, damit „Zurück“ nicht durch alle Zwischenschritte führt
  function go(hash, replace) {
    if (location.hash === hash) return render();
    if (replace) location.replace(hash); else location.hash = hash;
  }
  function tabOf(h) {
    if (/^\/(player|stopped|listen)/.test(h)) return 'listen';
    if (/^\/(settings|admin)/.test(h)) return 'settings';
    return 'lib';
  }
  async function render() {
    applyTheme();
    const h = location.hash.replace(/^#/, '') || '/';
    state.tab = tabOf(h);
    for (const [re, fn] of routes) {
      const m = h.match(re);
      if (m) { await fn(...m.slice(1)); window.scrollTo(0, 0); updateChrome(); return; }
    }
    go('#/', true);
  }
  // Untere Navigation + Mini-Player
  function updateChrome() {
    const nav = $('#tabbar');
    const tabs = [['lib', '#/', 'Bibliothek', I.lib], ['listen', '#/player', 'Hören', I.ear], ['settings', '#/settings', 'Einstellungen', I.gear]];
    nav.innerHTML = tabs.map(([k, href, label, icon]) => `<button class="tab ${state.tab === k ? 'on' : ''}" data-act="tab" data-v="${href}" ${state.tab === k ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></button>`).join('');
    updateMini();
  }
  const miniSub = () => `${pageLabel(state.book, P.idx)}${P.timer ? ' · ' + (P.timer.mode === 'sec' ? '≈ ' : '') + fmtTime(timerLeftMs()) : ''}`;
  function updateMini() {
    const mini = $('#mini');
    const show = P.started && state.book && state.tab !== 'listen';
    document.body.classList.toggle('has-mini', !!show);
    if (!show) { mini.innerHTML = ''; return; }
    const book = state.book;
    mini.innerHTML = `<button class="mini-open" data-act="openplayer" aria-label="Player öffnen">
        <span style="width:34px;flex-shrink:0">${coverHtml(book)}</span>
        <span class="col" style="gap:0;min-width:0;text-align:left"><span class="mini-title">${esc(book.title)}</span><span class="small" id="minisub">${miniSub()}</span></span>
      </button>
      <button class="mini-play" data-act="toggle" aria-label="${P.playing ? 'Pause' : 'Abspielen'}">${P.playing ? I.pauseS : I.playM}</button>`;
  }
  window.addEventListener('hashchange', render);

  // Einladungslink: #code=xxxxx-xxxxx
  (function inviteFromLink() {
    const m = location.hash.match(/code=([a-z0-9-]+)/i);
    if (m) {
      S.code = m[1];
      saveSettings();
      history.replaceState(null, '', location.pathname + '#/');
      setTimeout(() => toast('Zugang aktiviert – viel Spaß beim Hören'), 400);
    }
  })();

  // ---------------- Bibliothek ----------------
  route(/^\/$/, async () => {
    const books = await dbAll('books');
    const prog = Object.fromEntries((await dbAll('progress')).map((p) => [p.id, p]));
    books.sort((a, b) => ((prog[b.id] && prog[b.id].lastAt) || b.addedAt || '').localeCompare((prog[a.id] && prog[a.id].lastAt) || a.addedAt || ''));
    const recent = books.find((b) => prog[b.id] && prog[b.id].lastAt);
    let html = `<div class="screen">
      <div class="between">
        <div class="col" style="gap:6px">${young() ? `<span class="brand">${I.mono}<span class="wm">wort<b>.</b>laut<b>.</b></span></span><h1 class="yhead">Was hörst du <mark>heute</mark>?</h1>` : `<span class="brand">${I.logo}<span>Wort. Laut.</span></span><h1>Bibliothek</h1>`}</div>
        <div class="row" style="gap:8px">
          <button class="icon-btn" data-act="settings" aria-label="Einstellungen">${I.gear}</button>
          <button class="icon-btn" data-act="add" aria-label="EPUB hinzufügen">${I.plus}</button>
        </div>
      </div>`;
    if (recent) {
      const p = prog[recent.id];
      const pct = E.percentOf(recent, p.pos);
      const leftMin = Math.round((recent.totalChars - recent.sentences[Math.min(p.pos, recent.sentences.length - 1)].o) / CHARS_PER_SEC / 60 / (S.rate || 1));
      html += `<div class="card">
        <div class="row" style="gap:16px">
          <div style="width:68px;flex-shrink:0">${coverHtml(recent)}</div>
          <div class="col grow" style="gap:4px">
            <span class="label accent">Zuletzt gehört</span>
            <span class="serif" style="font-size:20px;font-weight:600">${esc(recent.title)}</span>
            <span class="muted">ab ${pageLabel(recent, p.pos)}</span>
            <button class="btn link" style="height:32px;justify-content:flex-start" data-act="open" data-id="${esc(recent.id)}">Andere Stelle wählen</button>
          </div>
        </div>
        <div class="row"><div class="progress" role="img" aria-label="Fortschritt ${pct} Prozent"><div style="width:${pct}%"></div></div><span class="serif" style="font-size:18px;font-weight:600">${pct} %</span></div>
        <div class="between"><span class="muted">ca. ${leftMin >= 60 ? Math.floor(leftMin / 60) + ' h ' + (leftMin % 60) + ' min' : leftMin + ' min'} übrig</span>
          <button class="btn solid" data-act="play-book" data-id="${esc(recent.id)}">${I.playS} Weiterhören</button></div>
      </div>`;
    }
    html += `<div class="col" style="gap:14px"><h2 class="label">Im Regal</h2>`;
    if (!books.length) {
      html += `<div class="empty">Noch keine Bücher.<br>Lade eine EPUB-Datei, um loszulegen.</div>
        <button class="btn solid big" data-act="add">${I.plus} EPUB laden</button>`;
    } else {
      html += `<div class="shelf">${books.map((b) => {
        const p = prog[b.id];
        const pct = p && p.lastAt ? E.percentOf(b, p.pos) : null;
        return `<button class="book-tile" data-act="open" data-id="${esc(b.id)}" aria-label="${esc(b.title)} öffnen">${coverHtml(b)}<span class="small">${pct == null ? 'Neu' : pct + ' %'}</span></button>`;
      }).join('')}<div class="book-tile"><button class="add-tile" data-act="add">${I.plus}EPUB laden</button><span class="small" aria-hidden="true">&nbsp;</span></div></div>`;
    }
    html += `</div>`;
    if (!hasCloudVoice()) html += `<div class="banner">Noch ohne Vorlesestimme aus der Cloud – es liest die einfache Handy-Stimme. <a href="#/settings">Zugang eintragen</a></div>`;
    html += `</div>`;
    app.innerHTML = html;
  });

  // ---------------- Import ----------------
  function pickFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.epub,application/epub+zip';
    inp.onchange = () => inp.files[0] && importFile(inp.files[0]);
    inp.click();
  }
  function busy(text) {
    const el = document.createElement('div');
    el.className = 'busy';
    el.innerHTML = `<div class="spinner"></div><div>${esc(text)}</div>`;
    document.body.appendChild(el);
    return () => el.remove();
  }
  async function importFile(file) {
    const done = busy('Lese Buch …');
    let book;
    try {
      const parsed = await E.parseEpub(await file.arrayBuffer(), { JSZip: window.JSZip, DOMParser: window.DOMParser });
      if (!parsed.sentences.length) throw new Error('In dieser Datei wurde kein Text gefunden.');
      const id = 'b' + hash(parsed.title + '|' + parsed.author + '|' + parsed.totalChars).toString(36);
      book = { id, ...parsed, printPages: null, addedAt: new Date().toISOString() };
    } catch (e) {
      done();
      toast(e.message || 'Datei konnte nicht gelesen werden.');
      return;
    }
    done();
    const existing = await dbGet('books', book.id);
    if (existing) { toast('Das Buch ist schon in deiner Bibliothek.'); go('#/book/' + book.id); return; }
    if (book.pageMarks) toast('Echte Seitenzahlen der Druckausgabe gefunden');
    else book.printPages = await askPages(book, null);
    await dbPut('books', book);
    await dbPut('progress', { id: book.id, pos: book.startAt || 0, last: null, lastAt: null });
    state.book = null;
    go('#/book/' + book.id);
  }
  function sheet(html) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
      const close = (v) => { ov.remove(); resolve(v); };
      ov.addEventListener('click', (e) => {
        if (e.target === ov) return close(undefined);
        const b = e.target.closest('[data-v]');
        if (b) close(b.dataset.v === '__form' ? ov.querySelector('form') : b.dataset.v);
      });
      ov.addEventListener('submit', (e) => { e.preventDefault(); close(ov.querySelector('form')); });
      document.body.appendChild(ov);
      const f = ov.querySelector('input');
      if (f) setTimeout(() => f.focus(), 50);
    });
  }
  async function askPages(book, current) {
    const res = await sheet(`<form class="col" style="gap:16px">
        <div class="row" style="gap:14px"><div style="width:56px;flex-shrink:0">${coverHtml(book)}</div>
          <div class="col" style="gap:2px"><span class="serif" style="font-size:20px;font-weight:600">${esc(book.title)}</span><span class="muted">${esc(book.author)}</span></div></div>
        <p class="muted" style="margin:0;line-height:1.5">Wie viele Seiten hat die gedruckte Ausgabe? Dann rechnet die App die Seitenzahlen passend zum Buch – auf etwa 1–2 Seiten genau. Du kannst das auch leer lassen.</p>
        <div class="split" style="grid-template-columns:1fr 1fr">
          <div class="field"><label for="pp">Seiten gesamt</label><input id="pp" name="pp" class="big" type="number" inputmode="numeric" min="1" value="${current && current.printPages ? current.printPages : ''}" placeholder="z. B. 288"></div>
          <div class="field"><label for="fp">Text beginnt auf S.</label><input id="fp" name="fp" class="big" type="number" inputmode="numeric" min="1" value="${current && current.firstPage ? current.firstPage : ''}" placeholder="z. B. 7"></div>
        </div>
        <button class="btn solid big" type="submit">Speichern</button>
        <button class="btn link" type="button" data-v="skip">Überspringen</button>
      </form>`);
    if (!res || res === 'skip') return current ? current.printPages : null;
    const pp = parseInt(res.pp.value, 10);
    const fp = parseInt(res.fp.value, 10);
    book.firstPage = fp > 0 ? fp : null;
    return pp > 0 ? pp : null;
  }

  // ---------------- Buchseite ----------------
  route(/^\/book\/([^/]+)$/, async (id) => {
    const book = await loadBook(id);
    if (!book) return go('#/');
    const p = state.progress;
    if (state.startIdx == null) state.startIdx = p.pos;
    const start = state.startIdx;
    const listenMin = Math.round(book.totalChars / CHARS_PER_SEC / 60);
    const endIdx = timerEndIdx(book, start, S.timer);
    let html = `<div class="screen">
      <a href="#/" class="icon-btn bare" aria-label="Zurück zur Bibliothek">${I.back}</a>
      <div class="row" style="gap:18px;align-items:flex-end">
        <div style="width:80px;flex-shrink:0">${coverHtml(book)}</div>
        <div class="col" style="gap:4px">
          <h1 style="font-size:26px">${esc(book.title)}</h1>
          <span class="muted" style="font-size:14px">${esc(book.author)}</span>
          <span class="muted">${book.pageMarks ? book.pageMarks[book.pageMarks.length - 1].l + ' Seiten · ' : book.printPages ? book.printPages + ' Seiten · ' : ''}ca. ${Math.floor(listenMin / 60)} h ${listenMin % 60} min Hörzeit</span>
        </div>
      </div>`;
    if (P.playing) {
      html += `<a href="#/player" class="btn solid" style="text-decoration:none">${I.playS} Zurück zum Player</a>`;
    }
    if (p.lastAt && p.last != null) {
      const when = new Date(p.lastAt);
      const whenTxt = when.toDateString() === new Date().toDateString() ? 'heute, ' + when.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : when.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
      html += `<div class="card strong">
        <div class="between" style="align-items:baseline"><span class="muted">Zuletzt gehört · ${esc(whenTxt)}</span><span class="serif" style="font-size:24px;font-weight:600">${pageLabel(book, p.last)}</span></div>
        <p class="quote" style="font-size:17px">„${esc(T(book.sentences[p.last]))}“</p>
        <button class="btn" style="align-self:flex-start;background:var(--bg)" data-act="copy-last">${I.copy} Satz kopieren</button>
      </div>`;
    }
    const quotes = await bookQuotes(book.id);
    const mode = S.findMode || 'page';
    const tabs = [['page', 'Seite'], ['words', 'Wörter'], ['chapter', 'Kapitel']];
    let finder = '';
    if (mode === 'page') {
      finder = `<div class="field"><label for="page">Seitenzahl aus deinem Buch</label><input id="page" class="big" type="number" inputmode="numeric" min="1" placeholder="${E.pageOf(book, start)}"></div>`;
    } else if (mode === 'words') {
      const hits = state.query ? E.search(book, ensureIndex(), state.query, p.pos, 8) : [];
      state.hits = hits;
      finder = `<form class="field" id="wordform"><label for="words">4–5 Wörter aus deinem E-Book einfügen</label>
          <div class="row" style="gap:6px;border-bottom:1.5px solid var(--line2)">${I.search}<input id="words" type="search" enterkeyhint="search" value="${esc(state.query)}" placeholder="Wörter einfügen" style="border:none"></div></form>
        ${state.query ? (hits.length ? `<span class="small">${hits.length === 1 ? 'Ein Treffer' : (hits.length >= 8 ? 'Mindestens 8' : hits.length) + ' Treffer – der nächste ist ausgewählt'}${hits.length > 1 ? ` · <a href="#/search/${esc(book.id)}">alle ansehen</a>` : ''}</span>` : '<span class="small">Keine Stelle gefunden. Tipp: 4–5 Wörter am Stück, ohne Satzzeichen.</span>') : '<span class="small">Die Suche läuft ab deiner letzten Stelle nach vorn.</span>'}`;
    } else {
      const sec = book.sections[book.sentences[start].s];
      finder = `<button class="list-btn" data-act="sections"><span class="col" style="gap:2px;min-width:0;text-align:left"><span style="font-weight:600">${esc(sec.doc ? sec.doc + ' · ' : '')}${esc(sec.title)}</span><span class="small">Anderes Kapitel wählen</span></span>${I.chev}</button>`;
    }
    html += `<div class="col" style="gap:10px">
      <h2 class="label">Wo geht's weiter?</h2>
      <div class="seg" role="tablist" aria-label="Stelle finden über">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${mode === k}" class="${mode === k ? 'on' : ''}" data-act="findmode" data-v="${k}">${l}</button>`).join('')}</div>
      ${finder}
      <div class="startline" id="startinfo"><span class="startdot">${I.playS}</span><span><b>Beginnt auf ${pageLabel(book, start)} mit:</b> „${esc(T(book.sentences[start]).slice(0, 110))}${T(book.sentences[start]).length > 110 ? ' …' : ''}“</span></div>
    </div>
    <div class="col" style="gap:10px">
      <h2 class="label row" style="gap:6px">${I.moon} Sleep-Timer <span style="text-transform:none;letter-spacing:0;font-weight:500">(optional)</span></h2>
      <div class="chips">${TIMER_OPTS.map(([v, l]) => `<button class="chip ${String(S.timer) === v ? 'on' : ''}" data-act="timer" data-v="${v}" aria-label="${v === '0' ? 'Kein Timer' : v === 'sec' ? 'Bis Kapitelende' : v + ' Minuten'}">${l}</button>`).join('')}</div>
      <span class="small">${endIdx != null ? `Endet ca. bei ${pageLabel(book, endIdx)} · ` : 'Läuft, bis du pausierst · '}Stimme: ${esc(voiceName(S.voice))}, ${String(S.rate).replace('.', ',')}×</span>
    </div>
    <button class="btn solid big" data-act="start">${I.playS} Ab ${pageLabel(book, start)} hören${parseInt(S.timer, 10) > 0 ? ' · ' + S.timer + ' min' : S.timer === 'sec' ? ' · bis Kapitelende' : ''}</button>
    ${quotes.length ? `<a class="list-btn" href="#/quotes/${esc(book.id)}" style="text-decoration:none;color:inherit"><span class="row" style="gap:10px">${I.heart}<span class="col" style="gap:2px"><span style="font-weight:600">Deine Zitate (${quotes.length})</span><span class="small">Ansehen, kürzen, teilen</span></span></span>${I.chev}</a>` : ''}
    <div class="between" style="margin-top:8px">
      ${book.pageMarks ? '<span class="small">Seitenzahlen exakt wie in der Druckausgabe</span>' : `<button class="btn link" data-act="pages">${book.printPages ? 'Seitenzahlen: Druckausgabe ' + book.printPages + ' S.' : 'Seitenzahl der Druckausgabe eintragen'}</button>`}
      <button class="btn link danger" data-act="delete">Entfernen</button>
    </div>
    </div>`;
    app.innerHTML = html;
    const pageInp = $('#page');
    if (pageInp) pageInp.addEventListener('change', () => {
      const n = parseInt(pageInp.value, 10);
      if (n > 0) { state.startIdx = E.indexForPage(book, n); render(); }
    });
    const wf = $('#wordform');
    if (wf) wf.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#words').value.trim();
      if (q.length < 3) return toast('Bitte ein paar Wörter mehr eingeben.');
      state.query = q;
      state.selHit = 0;
      const hits = E.search(book, ensureIndex(), q, state.progress.pos, 8);
      if (hits.length) state.startIdx = hits[0].idx;
      render();
    });
  });
  function voiceName(id) {
    const v = (state.voices || DEFAULT_VOICES).find((x) => x.id === id);
    return v ? v.name : id.replace(/^de-DE-|Multilingual|Neural/g, '');
  }
  function timerEndIdx(book, start, timer) {
    if (timer === 'sec') {
      const sec = book.sentences[start].s;
      const next = book.sections[sec + 1];
      return (next ? next.start : book.sentences.length) - 1;
    }
    const min = parseInt(timer, 10);
    if (!min) return null;
    const target = book.sentences[start].o + min * 60 * CHARS_PER_SEC * (S.rate || 1);
    return E.indexForOffset(book, target);
  }
  async function chooseSection() {
    const book = state.book;
    const cur = book.sentences[state.startIdx].s;
    const items = book.sections.map((s, i) => ({ s, i })).filter(({ s }) => s.chars > 300);
    const res = await sheet(`<h2 class="label">Abschnitt wählen</h2><div>${items.map(({ s, i }) => `<button class="list-btn" data-v="${i}">
      <span class="col" style="gap:2px;min-width:0"><span style="font-weight:${i === cur ? 700 : 500}">${esc(s.doc ? s.doc + ' · ' : '')}${esc(s.title)}${s.title.length >= 60 ? ' …' : ''}</span>
      <span class="small">${pageLabel(book, s.start)} · ${Math.max(1, Math.round(s.chars / CHARS_PER_SEC / 60))} min</span></span>${I.chev}</button>`).join('')}</div>`);
    if (res != null) { state.startIdx = book.sections[+res].start; render(); }
  }

  // ---------------- Wortsuche ----------------
  route(/^\/search\/([^/]+)$/, async (id) => {
    const book = await loadBook(id);
    if (!book) return go('#/');
    const from = state.progress.pos;
    const hits = state.query ? E.search(book, ensureIndex(), state.query, from, 8) : [];
    state.hits = hits;
    if (state.selHit >= hits.length) state.selHit = 0;
    const q = E.norm(state.query);
    const mark = (idx) => {
      const raw = T(book.sentences[idx]);
      // Treffer im Originaltext grob markieren: Wort für Wort vergleichen
      const words = raw.split(/(\s+)/);
      const qWords = q.split(' ');
      let out = '';
      for (let i = 0; i < words.length; i++) {
        let match = false;
        if (E.norm(words[i]) === qWords[0]) {
          let k = i, j = 0;
          while (k < words.length && j < qWords.length) {
            const n = E.norm(words[k]);
            if (!n) { k++; continue; }
            if (n !== qWords[j] && !(j === qWords.length - 1 && n.startsWith(qWords[j]))) break;
            j++; k++;
          }
          if (j === qWords.length) {
            out += '<mark>' + esc(words.slice(i, k).join('')) + '</mark>';
            i = k - 1;
            match = true;
          }
        }
        if (!match) out += esc(words[i]);
      }
      return out;
    };
    const ctx = (idx) => `${idx > 0 ? '… ' + esc(T(book.sentences[idx - 1]).slice(-60)) + ' ' : ''}<span style="color:var(--text)">${mark(idx)}</span>`;
    app.innerHTML = `<div class="screen">
      <div class="row" style="gap:8px"><a href="#/book/${esc(id)}" class="icon-btn bare" aria-label="Zurück zum Buch">${I.back}</a><span class="muted" style="font-size:14px">${esc(book.title)} · Stelle suchen</span></div>
      <form class="field" id="sform"><label for="sq">Wörter aus dem Text</label>
        <div class="row" style="gap:8px;border-bottom:1.5px solid var(--text)">${I.search}<input id="sq" type="search" enterkeyhint="search" value="${esc(state.query)}" style="border:none;font-size:17px"></div></form>
      <span class="muted">${hits.length ? `${hits.length === 8 ? 'Mindestens 8' : hits.length} Treffer · ab deiner letzten Stelle (${pageLabel(book, from)})` : 'Keine Stelle gefunden. Tipp: 4–5 Wörter am Stück, ohne Satzzeichen.'}</span>
      <div class="col" style="gap:10px">${hits.map((h, i) => `<button class="hit ${i === state.selHit ? 'sel' : ''}" data-act="selhit" data-v="${i}">
        <span class="between" style="width:100%;align-items:baseline"><span class="label ${i === 0 ? 'accent' : ''}">${i === 0 ? 'Nächster Treffer' : h.wrapped ? 'Weiter vorne im Buch' : 'Weiterer Treffer'}</span><span class="serif" style="font-size:${i === 0 ? 24 : 17}px;font-weight:600">${pageLabel(book, h.idx)}</span></span>
        <span class="serif" style="font-size:${i === 0 ? 17 : 15}px;line-height:1.5;color:var(--muted)">${ctx(h.idx)}</span></button>`).join('')}</div>
      ${hits.length ? `<button class="btn solid big" style="margin-top:auto" data-act="usehit">${I.playS} Ab hier · ${pageLabel(book, hits[state.selHit].idx)}</button>` : ''}
    </div>`;
    $('#sform').addEventListener('submit', (e) => { e.preventDefault(); state.query = $('#sq').value.trim(); state.selHit = 0; render(); });
  });

  // ---------------- Vorlese-Engine ----------------
  const P = {
    playing: false, loading: false, idx: 0, chunk: null, cache: new Map(), engine: 'cloud',
    timer: null, sessionStart: 0, sessionMs: 0, lastTick: 0, stopAfter: null, endedBy: null, error: null,
  };
  const CH_MIN = 450, CH_MAX = 950;
  function makeChunk(book, from) {
    const parts = [], lens = [];
    let chars = 0, i = from;
    while (i < book.sentences.length) {
      const s = book.sentences[i];
      const len = T(s).length;
      if (i > from && chars + len > CH_MAX) break;
      for (const p of s.p) parts.push([p[0], p[1]]);
      parts.push([' ', null]);
      lens.push(len + 1);
      chars += len + 1;
      i++;
      if (s.pe) parts.push(['', '#p']);
      if (chars >= CH_MIN && s.pe) break;
      if (chars >= CH_MAX * 0.85) break;
    }
    return { from, to: i, parts, lens, chars, key: `${from}|${S.voice}|${S.rate}` };
  }
  async function fetchChunk(ch) {
    if (P.cache.has(ch.key)) return P.cache.get(ch.key);
    const pr = (async () => {
      const res = await fetch(workerUrl() + '/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ parts: ch.parts, voice: S.voice, rate: S.rate }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw Object.assign(new Error(d.error || 'Vorlesen fehlgeschlagen (' + res.status + ')'), { code: d.code });
      }
      return URL.createObjectURL(await res.blob());
    })();
    P.cache.set(ch.key, pr);
    pr.catch(() => P.cache.delete(ch.key));
    // Cache klein halten
    if (P.cache.size > 8) {
      const first = P.cache.keys().next().value;
      const old = P.cache.get(first);
      P.cache.delete(first);
      old.then((u) => URL.revokeObjectURL(u)).catch(() => {});
    }
    return pr;
  }
  function prefetch(book, ch) {
    let next = ch;
    for (let k = 0; k < 1 && next.to < book.sentences.length; k++) {
      next = makeChunk(book, next.to);
      fetchChunk(next).catch(() => {});
    }
  }

  async function playFrom(idx) {
    const book = state.book;
    stopAudio();
    P.idx = Math.max(0, Math.min(idx, book.sentences.length - 1));
    P.playing = true;
    P.error = null;
    P.lastTick = Date.now();
    P.engine = hasCloudVoice() ? 'cloud' : 'device';
    setLoading(true);
    updatePlayerUi();
    if (P.engine === 'device') return speakDevice(P.idx);
    const ch = makeChunk(book, P.idx);
    P.chunk = ch;
    try {
      const url = await fetchChunk(ch);
      if (P.chunk !== ch || !P.playing) return;
      audio.src = url;
      audio.playbackRate = isHD(S.voice) ? S.rate : 1; // HD-Stimmen kennen kein Tempo in SSML
      audio.volume = volumeFor();
      await audio.play();
      setLoading(false);
      setupMediaSession();
    } catch (e) {
      if (P.chunk !== ch) return;
      setLoading(false);
      P.playing = false;
      P.error = e.message;
      updatePlayerUi();
      toast(e.message);
    }
  }
  // Satz vor/zurück: liegt der Satz im schon geladenen Abschnitt, nur spulen statt neu anfragen
  function jumpTo(idx) {
    const ch = P.chunk;
    if (P.engine === 'cloud' && ch && idx >= ch.from && idx < ch.to && audio.duration && isFinite(audio.duration)) {
      let acc = 0;
      for (let k = 0; k < idx - ch.from; k++) acc += ch.lens[k];
      audio.currentTime = (acc / ch.chars) * audio.duration + 0.05;
      P.idx = idx;
      state.progress.pos = idx;
      if (!P.playing) { P.playing = true; P.lastTick = Date.now(); audio.play().catch(() => {}); }
      updatePlayerUi();
      return;
    }
    return playFrom(idx);
  }
  function stopAudio() {
    audio.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    P.chunk = null;
  }
  function setLoading(v) { P.loading = v; const b = $('#mainbtn'); if (b) b.classList.toggle('loading', v); }

  audio.addEventListener('timeupdate', () => {
    tick(); // läuft auch, wenn das Handy im Hintergrund Timer drosselt
    const ch = P.chunk;
    if (!ch || !audio.duration || !isFinite(audio.duration)) return;
    const frac = audio.currentTime / audio.duration;
    const target = frac * ch.chars;
    let acc = 0, k = 0;
    while (k < ch.lens.length - 1 && acc + ch.lens[k] < target) { acc += ch.lens[k]; k++; }
    const idx = ch.from + k;
    // Nächsten Abschnitt erst vorladen, wenn der aktuelle zur Hälfte gehört ist (spart Kontingent beim Reinhören)
    if (frac > 0.5 && !ch.prefetched && P.playing) { ch.prefetched = true; prefetch(state.book, ch); }
    if (idx !== P.idx) onSentence(idx);
  });
  audio.addEventListener('ended', () => {
    const ch = P.chunk;
    if (!ch || !P.playing) return;
    if (P.stopAfter != null && P.stopAfter < ch.to) return finishSession(ch.to - 1);
    if (ch.to >= state.book.sentences.length) return finishSession(ch.to - 1, 'end');
    playFrom(ch.to);
  });
  audio.addEventListener('pause', () => { if (P.playing && P.chunk && !audio.ended && !P.loading) { /* von außen pausiert (Kopfhörer) */ pause(); } });
  audio.addEventListener('error', () => {
    if (!P.playing || !P.chunk) return;
    toast('Wiedergabe unterbrochen – versuche es erneut.');
    pause();
  });

  function onSentence(idx) {
    const prev = P.idx;
    P.idx = idx;
    if (P.stopAfter != null && idx > P.stopAfter) return finishSession(P.stopAfter);
    if (P.timer && P.timer.mode === 'sec' && idx > P.timer.endIdx) return finishSession(P.timer.endIdx);
    state.progress.pos = idx;
    if (idx !== prev) updateText();
  }

  // Handy-Stimme als Rückfall
  function speakDevice(idx) {
    if (!('speechSynthesis' in window)) { P.playing = false; setLoading(false); toast('Dieses Gerät kann nicht vorlesen.'); return updatePlayerUi(); }
    const book = state.book;
    P.idx = idx;
    const u = new SpeechSynthesisUtterance(T(book.sentences[idx]));
    u.lang = 'de-DE';
    u.rate = S.rate;
    u.volume = volumeFor();
    const de = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('de'));
    if (de) u.voice = de;
    u.onstart = () => setLoading(false);
    u.onend = () => {
      if (!P.playing || P.engine !== 'device' || P.idx !== idx) return;
      if (P.stopAfter != null && idx >= P.stopAfter) return finishSession(idx);
      if (P.timer && P.timer.mode === 'sec' && idx >= P.timer.endIdx) return finishSession(idx);
      if (idx + 1 >= book.sentences.length) return finishSession(idx, 'end');
      onSentence(idx + 1);
      if (P.playing) speakDevice(idx + 1);
    };
    speechSynthesis.speak(u);
    updateText();
  }

  function pause() {
    if (!P.playing) return;
    tick();
    P.playing = false;
    if (P.engine === 'device') speechSynthesis.cancel(); else audio.pause();
    setLoading(false);
    P.pausedAt = Date.now();
    state.progress.pos = P.idx;
    state.progress.last = P.idx;
    state.progress.lastAt = new Date().toISOString();
    saveProgress();
    updatePlayerUi();
  }
  function resume() {
    if (P.playing) return;
    if (P.engine === 'cloud' && P.chunk && audio.src && !audio.ended && hasCloudVoice()) {
      P.playing = true;
      P.lastTick = Date.now();
      audio.volume = volumeFor();
      audio.play().catch(() => playFrom(P.idx));
      updatePlayerUi();
    } else {
      playFrom(P.idx);
    }
  }
  function finishSession(lastIdx, reason) {
    P.playing = false;
    stopAudio();
    setLoading(false);
    const book = state.book;
    state.progress.last = lastIdx;
    state.progress.pos = Math.min(lastIdx + 1, book.sentences.length - 1);
    state.progress.lastAt = new Date().toISOString();
    P.endedBy = reason || 'timer';
    P.stopAfter = null;
    P.started = false;
    saveProgress();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    go('#/stopped', true);
  }

  // Timer
  function startTimer(book, start, timerVal) {
    const t = timerVal != null ? timerVal : S.timer;
    P.sessionMs = 0;
    P.stopAfter = null;
    P.sessionQuotes = 0;
    if (t === 'sec') {
      P.timer = { mode: 'sec', startIdx: start, endIdx: timerEndIdx(book, start, 'sec') };
    } else if (parseInt(t, 10) > 0) {
      const ms = parseInt(t, 10) * 60000;
      P.timer = { mode: 'min', totalMs: ms, remainingMs: ms };
    } else {
      P.timer = null;
    }
  }
  function tick() {
    const now = Date.now();
    const dt = now - (P.lastTick || now);
    P.lastTick = now;
    if (!P.playing || P.loading) return;
    P.sessionMs += dt;
    if (P.timer && P.timer.mode === 'min') {
      P.timer.remainingMs -= dt;
      if (P.timer.remainingMs <= 0 && P.stopAfter == null) {
        P.timer.remainingMs = 0;
        P.stopAfter = P.idx; // aktuellen Satz noch zu Ende lesen
      }
    }
    if (P.engine === 'cloud') audio.volume = volumeFor();
  }
  function volumeFor() {
    const left = timerLeftMs();
    if (left == null || left > 60000) return 1;
    return 0.45 + 0.55 * Math.max(0, left / 60000); // letzte Minute leiser
  }
  function timerLeftMs() {
    if (!P.timer) return null;
    if (P.timer.mode === 'min') return Math.max(0, P.timer.remainingMs);
    const book = state.book;
    const end = book.sentences[P.timer.endIdx];
    const chars = end.o + T(end).length - book.sentences[P.idx].o;
    return Math.max(0, (chars / (CHARS_PER_SEC * S.rate)) * 1000);
  }
  function timerFraction() {
    if (!P.timer) return null;
    if (P.timer.mode === 'min') return 1 - Math.max(0, P.timer.remainingMs) / P.timer.totalMs;
    const book = state.book;
    const a = book.sentences[P.timer.startIdx].o, b = book.sentences[P.timer.endIdx].o + 1;
    return Math.min(1, Math.max(0, (book.sentences[P.idx].o - a) / Math.max(1, b - a)));
  }
  setInterval(() => {
    if (!P.playing) return;
    tick();
    updateSun();
    const ms = $('#minisub');
    if (ms) ms.textContent = miniSub();
    const tl = $('#timerlbl');
    if (tl) tl.textContent = timerChipLabel();
    if (state.progress && Date.now() - (state.progress._saved || 0) > 15000) {
      state.progress._saved = Date.now();
      state.progress.lastAt = new Date().toISOString();
      state.progress.last = P.idx;
      saveProgress();
    }
  }, 500);

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const book = state.book;
    const art = book.cover ? [{ src: coverUrls.get(book.id) || '', sizes: '512x768', type: book.cover.type }] : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: book.title, artist: book.author, album: 'Wort. Laut.', artwork: art });
      navigator.mediaSession.setActionHandler('play', () => resume());
      navigator.mediaSession.setActionHandler('pause', () => pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => jumpTo(P.idx - 1));
      navigator.mediaSession.setActionHandler('nexttrack', () => jumpTo(P.idx + 1));
      navigator.mediaSession.setActionHandler('seekbackward', () => jumpTo(P.idx - 1));
      navigator.mediaSession.setActionHandler('seekforward', () => jumpTo(P.idx + 1));
      navigator.mediaSession.playbackState = 'playing';
    } catch (e) { /* nicht überall verfügbar */ }
  }

  // Hören starten: Timer setzen, zum Player (ohne Zwischenschritte im Verlauf)
  function beginSession(start, stay, timerVal) {
    const book = state.book;
    startTimer(book, start, timerVal);
    P.pausedAt = null;
    P.started = true;
    state.startIdx = null;
    if (!stay) go('#/player', true);
    return playFrom(start);
  }
  async function chooseTimer() {
    const opts = [['0', 'Aus'], ['15', '15 Minuten'], ['30', '30 Minuten'], ['60', '60 Minuten'], ['sec', 'Bis Kapitelende']];
    if (P.started && P.timer && P.timer.mode === 'min') opts.unshift(['plus', '+15 Minuten dazu']);
    const res = await sheet(`<h2 class="label">Sleep-Timer</h2><div>${opts.map(([v, l]) => `<button class="list-btn" data-v="${v}"><span>${l}</span>${String(S.timer) === v ? '✓' : ''}</button>`).join('')}</div>`);
    if (res == null) return;
    if (res === 'plus') {
      P.timer.remainingMs += 900000; P.timer.totalMs += 900000; P.stopAfter = null;
      updatePlayerUi(); toast('15 Minuten mehr');
      return;
    }
    S.timer = res === 'sec' ? 'sec' : parseInt(res, 10);
    saveSettings();
    if (P.started) {
      const q = P.sessionQuotes;
      startTimer(state.book, P.idx);
      P.sessionQuotes = q;
    }
    updatePlayerUi();
  }
  function timerChipLabel() {
    if (!P.started || !P.timer) return S.timer === 'sec' ? 'Kapitel' : parseInt(S.timer, 10) > 0 && !P.started ? S.timer + ' min' : 'Aus';
    if (P.timer.mode === 'sec') return 'Kapitel';
    return Math.max(1, Math.ceil(timerLeftMs() / 60000)) + ' min';
  }

  // ---------------- Zitate ----------------
  async function bookQuotes(bookId) {
    const all = await dbAll('quotes');
    state.quoteList = all;
    return all.filter((q) => q.bookId === bookId).sort((a, b) => a.from - b.from);
  }
  const quoteText = (book, q) => {
    const parts = [];
    for (let k = q.from; k <= q.to; k++) parts.push(T(book.sentences[k]));
    return parts.join(' ');
  };
  const markActive = () => !!(P.lastQuote && Date.now() - P.lastQuoteAt < 20000);
  let markTimer;
  function showMarkbar() {
    const bar = $('#markbar');
    if (!bar) return;
    clearTimeout(markTimer);
    if (!markActive()) { bar.innerHTML = ''; return; }
    const q = P.lastQuote;
    const n = q.to - q.from + 1;
    bar.innerHTML = `<div class="markbar" role="status"><span class="row" style="gap:8px">${I.heart}<span class="col" style="gap:0"><b>Gemerkt · ${n === 1 ? '1 Satz' : n + ' Sätze'}</b><span class="small">Tipp im Text auf weitere Sätze, um sie dazuzunehmen</span></span></span>
      <span class="row" style="gap:6px;flex-shrink:0"><button class="btn" data-act="mark-undo">Rückgängig</button><a class="btn" href="#/quotes/${esc(state.book.id)}" style="text-decoration:none">Ansehen</a></span></div>`;
    markTimer = setTimeout(() => { bar.innerHTML = ''; updatePlayerUi(); anchorText(); }, 20000 - (Date.now() - P.lastQuoteAt));
    anchorText();
  }
  async function saveQuote(q) {
    await dbPut('quotes', q);
    await bookQuotes(q.bookId);
  }
  async function markQuote(idx) {
    const book = state.book;
    if (!book) return;
    if (idx == null && markActive()) return showMarkbar(); // schon gemerkt – nichts doppelt
    const at = idx != null ? idx : P.idx;
    const q = { id: 'q' + Date.now().toString(36), bookId: book.id, from: idx != null ? at : Math.max(0, at - 1), to: at, createdAt: new Date().toISOString() };
    P.lastQuote = q;
    P.lastQuoteAt = Date.now();
    P.sessionQuotes = (P.sessionQuotes || 0) + 1;
    await saveQuote(q);
    updatePlayerUi();
    showMarkbar();
  }
  async function extendQuote(idx) {
    const q = P.lastQuote;
    if (idx < q.from) q.from = Math.max(idx, q.to - 12);
    else if (idx > q.to) q.to = Math.min(idx, q.from + 12);
    else if (idx === q.from && q.from < q.to) q.from++; // Antippen am Rand nimmt den Satz wieder raus
    else if (idx === q.to && q.to > q.from) q.to--;
    P.lastQuoteAt = Date.now();
    await saveQuote(q);
    updatePlayerUi();
    markSpans();
    showMarkbar();
  }
  async function undoMark() {
    if (!P.lastQuote) return;
    await dbDel('quotes', P.lastQuote.id);
    P.sessionQuotes = Math.max(0, (P.sessionQuotes || 1) - 1);
    P.lastQuote = null;
    await bookQuotes(state.book.id);
    updatePlayerUi();
    showMarkbar();
    toast('Entfernt');
  }
  // Antippen im mitlaufenden Text: frisches Zitat erweitern, sonst Satz neu merken
  document.addEventListener('click', (e) => {
    const sp = e.target.closest('#reading span[data-i]');
    if (!sp || !state.book) return;
    const idx = +sp.dataset.i;
    if (markActive()) extendQuote(idx); else markQuote(idx);
  });

  route(/^\/quotes\/([^/]+)$/, async (id) => {
    const book = await loadBook(id);
    if (!book) return go('#/');
    const quotes = (await bookQuotes(id)).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const when = (iso) => {
      const d = new Date(iso);
      return d.toDateString() === new Date().toDateString() ? 'heute, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
    };
    app.innerHTML = `<div class="screen">
      <div class="row" style="gap:8px"><a href="#/book/${esc(id)}" class="icon-btn bare" aria-label="Zurück zum Buch">${I.back}</a><span class="muted" style="font-size:14px">${esc(book.title)}</span></div>
      <div class="between" style="align-items:flex-end"><h1>Deine Zitate</h1><span class="muted">${quotes.length} gemerkt</span></div>
      ${quotes.length ? quotes.map((q) => `<div class="card" style="gap:10px">
        <div class="between" style="align-items:baseline"><span class="serif" style="font-size:20px;font-weight:600">${pageLabel(book, q.from)}</span><span class="small">${esc(when(q.createdAt))}</span></div>
        <p class="quote" style="font-size:17px">„${esc(quoteText(book, q))}“</p>
        <div class="row" style="gap:8px">
          <button class="btn solid" data-act="q-share" data-id="${esc(q.id)}">${I.share} Teilen</button>
          <button class="btn" data-act="q-copy" data-id="${esc(q.id)}" style="background:var(--bg)">${I.copy} Kopieren</button>
          <button class="icon-btn" style="margin-left:auto;background:var(--bg)" data-act="q-more" data-id="${esc(q.id)}" aria-label="Zitat bearbeiten oder löschen">${I.dots}</button>
        </div></div>`).join('') : `<div class="empty">Noch keine Zitate.<br>Tippe beim Hören auf ❤ „Das war gut“ – oder direkt auf einen Satz im Text.</div>`}
    </div>`;
  });
  async function findQuote(qid) { return (await dbAll('quotes')).find((q) => q.id === qid); }
  async function copyQuote(qid) {
    const q = await findQuote(qid);
    const book = state.book;
    if (!q || !book) return;
    try { await navigator.clipboard.writeText(`„${quoteText(book, q)}“ – ${book.title}${book.author ? ', ' + book.author : ''}, ${pageLabel(book, q.from)}`); toast('Zitat kopiert'); } catch { toast('Kopieren nicht möglich'); }
  }
  async function quoteMenu(qid) {
    const q = await findQuote(qid);
    const book = state.book;
    if (!q || !book) return;
    const res = await sheet(`<h2 class="label">Zitat anpassen</h2>
      <p class="quote" style="font-size:16px;margin:0">„${esc(quoteText(book, q))}“</p>
      <div>
        <button class="list-btn" data-v="addBefore"><span>Satz davor dazunehmen</span></button>
        <button class="list-btn" data-v="addAfter"><span>Satz danach dazunehmen</span></button>
        ${q.to > q.from ? '<button class="list-btn" data-v="cutStart"><span>Ersten Satz entfernen</span></button><button class="list-btn" data-v="cutEnd"><span>Letzten Satz entfernen</span></button>' : ''}
        <button class="list-btn" data-v="delete"><span class="danger" style="color:#B3261E">Zitat löschen</span></button>
      </div>`);
    if (!res) return;
    if (res === 'delete') { await dbDel('quotes', q.id); toast('Gelöscht'); return render(); }
    if (res === 'addBefore') q.from = Math.max(0, q.from - 1);
    if (res === 'addAfter') q.to = Math.min(book.sentences.length - 1, q.to + 1);
    if (res === 'cutStart' && q.to > q.from) q.from++;
    if (res === 'cutEnd' && q.to > q.from) q.to--;
    await saveQuote(q);
    render();
  }
  // ---------- Zitat-Studio: Story-Karte (1080 × 1920) mit Farbe und Stil ----------
  const CARD_BGS = {
    young: [
      { k: 'flieder', n: 'Flieder', bg: '#C8B6FF', ink: '#141414', mark: '#DDF35B', markInk: '#141414', alt: '#4B2BD6', tile: '#141414' },
      { k: 'limette', n: 'Limette', bg: '#DDF35B', ink: '#141414', mark: '#C8B6FF', markInk: '#141414', alt: '#4B2BD6', tile: '#141414' },
      { k: 'rot', n: 'Orange-Rot', bg: '#FF5B3A', ink: '#141414', mark: '#FAF7F2', markInk: '#141414', alt: '#FAF7F2', tile: '#141414', dot: '#141414' },
      { k: 'creme', n: 'Creme', bg: '#FAF7F2', ink: '#141414', mark: '#DDF35B', markInk: '#141414', alt: '#FF5B3A', tile: '#141414' },
      { k: 'schwarz', n: 'Schwarz', bg: '#141414', ink: '#FAF7F2', mark: '#DDF35B', markInk: '#141414', alt: '#DDF35B', tile: '#2A2A2A' },
    ],
    sand: [
      { k: 'nacht', n: 'Nacht', bg: '#1C2433', ink: '#F1ECE4', mark: '#E8A35C', markInk: '#1C2433', alt: '#E8A35C', logo: '#E8A35C' },
      { k: 'sand', n: 'Sand', bg: '#F1ECE4', ink: '#1C2433', mark: '#F3CF9E', markInk: '#1C2433', alt: '#B8642A', logo: '#C8692E' },
      { k: 'abendrot', n: 'Abendrot', bg: '#E8A35C', ink: '#1C2433', mark: '#F1ECE4', markInk: '#1C2433', alt: '#7A2E12', logo: '#1C2433' },
    ],
  };
  const CARD_STYLES = [['mark', 'Markiert'], ['akzent', 'Akzent'], ['zwei', 'Zweifarbig']];
  const rrect = (g, x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
  // Wörter des Zitats mit Kennzeichnung, welcher Teil hervorgehoben wird
  function quoteTokens(book, q, style) {
    const sents = [];
    for (let k = q.from; k <= q.to; k++) sents.push(T(book.sentences[k]).split(/\s+/).filter(Boolean));
    let lead = [], tail = [];
    if (style === 'mark') tail = sents.flat();
    else if (sents.length > 1) { lead = sents.slice(0, -1).flat(); tail = sents[sents.length - 1]; }
    else {
      // ein Satz: ab dem letzten Komma/Gedankenstrich hervorheben, sonst die zweite Hälfte
      const w = sents[0] || [];
      let cut = -1;
      for (let i = w.length - 4; i > 0; i--) if (/[,;:–—]$/.test(w[i - 1]) || /^[–—]$/.test(w[i])) { cut = i; break; }
      if (cut < 0) cut = Math.floor(w.length / 2);
      lead = w.slice(0, cut); tail = w.slice(cut);
    }
    return [...lead.map((w) => ({ w, hi: false })), ...tail.map((w) => ({ w, hi: true }))];
  }
  async function drawCard(c, book, q, look, bgKey, style) {
    const W = 1080, g = c.getContext('2d');
    const pal = CARD_BGS[look].find((b) => b.k === bgKey) || CARD_BGS[look][0];
    const yl = look === 'young';
    const font = yl ? '"Bricolage Grotesque", sans-serif' : '"Source Serif 4", Georgia, serif';
    const weight = yl ? 800 : 600;
    const pad = yl ? 100 : 110;
    try {
      if (yl) { await document.fonts.load('800 60px "Bricolage Grotesque"'); await document.fonts.load('500 40px "Bricolage Grotesque"'); }
      else { await document.fonts.load('600 60px "Source Serif 4"'); await document.fonts.load('600 40px Figtree'); }
    } catch (e) {}
    g.setTransform(1, 0, 0, 1, 0, 0); g.textAlign = 'left'; g.globalAlpha = 1;
    g.fillStyle = pal.bg; g.fillRect(0, 0, W, 1920);
    // Logo oben
    if (yl) {
      g.save(); g.translate(pad, 120); g.scale(0.9, 0.9);
      g.fillStyle = pal.tile; rrect(g, 0, 0, 200, 200, 46); g.fill();
      g.translate(7, 3); g.fillStyle = '#DDF35B'; g.fill(new Path2D('M37.1 123.0 22.0 60.7H41.8L49.5 108.1H51.9L61.4 60.7H84.0L93.9 108.1H96.4L103.7 60.7H123.1L108.0 123.0H81.8L73.2 76.0H71.0L63.0 123.0Z'));
      g.lineCap = 'round'; g.lineWidth = 7; g.strokeStyle = '#FF5B3A';
      g.stroke(new Path2D('M151.1 99.2 A18 18 0 0 1 151.1 126.8')); g.globalAlpha = 0.5; g.stroke(new Path2D('M158.1 90.8 A29 29 0 0 1 158.1 135.2')); g.globalAlpha = 1;
      g.fillStyle = '#FF5B3A'; g.beginPath(); g.arc(139.5, 113, 10, 0, Math.PI * 2); g.fill();
      g.restore();
    } else {
      g.lineCap = 'round';
      [[44, 1], [84, 0.6], [124, 0.3]].forEach(([r, o]) => { g.globalAlpha = o; g.strokeStyle = pal.logo; g.lineWidth = 16; g.beginPath(); g.arc(W / 2, 330, r, Math.PI, 0); g.stroke(); });
      g.globalAlpha = 1; g.strokeStyle = pal.ink; g.lineWidth = 18;
      g.beginPath(); g.moveTo(W / 2 - 136, 366); g.quadraticCurveTo(W / 2 - 68, 338, W / 2, 370); g.quadraticCurveTo(W / 2 + 68, 338, W / 2 + 136, 366); g.stroke();
    }
    // Text: im jungen Look großes Anführungszeichen, im Sand-Look „…“ im Text
    const tokens = quoteTokens(book, q, style);
    if (!yl && tokens.length) { tokens[0] = { ...tokens[0], w: '„' + tokens[0].w }; const l = tokens.length - 1; tokens[l] = { ...tokens[l], w: tokens[l].w + '“' }; }
    if (yl) { g.fillStyle = style === 'zwei' ? pal.alt : pal.ink; g.font = `800 260px ${font}`; g.fillText('“', pad - 10, 560); }
    const top = yl ? 620 : 520, boxH = yl ? 980 : 1000, maxW = W - pad * 2 - 20;
    const wrap = (size) => {
      g.font = `${weight} ${size}px ${font}`;
      const sp = g.measureText(' ').width, lines = [];
      let line = [], lw = 0;
      for (const t of tokens) {
        const w = g.measureText(t.w).width;
        if (line.length && lw + sp + w > maxW) { lines.push(line); line = []; lw = 0; }
        lw += (line.length ? sp : 0) + w; line.push({ ...t, width: w });
      }
      if (line.length) lines.push(line);
      return { lines, sp };
    };
    const lhF = yl ? 1.3 : 1.34;
    let size = yl ? 108 : 92, L = wrap(size);
    while (L.lines.length * size * lhF > boxH && size > 34) { size -= 4; L = wrap(size); }
    const lh = size * lhF;
    let y = top + (boxH - L.lines.length * lh) / 2 + size;
    const useMark = style !== 'zwei';
    for (const line of L.lines) {
      // Marker-Flächen für zusammenhängende hervorgehobene Wörter
      let x = pad;
      const pos = line.map((t) => { const p = x; x += t.width + L.sp; return p; });
      if (useMark) {
        g.fillStyle = pal.mark;
        let i = 0;
        while (i < line.length) {
          if (!line[i].hi) { i++; continue; }
          let j = i; while (j + 1 < line.length && line[j + 1].hi) j++;
          const x0 = pos[i] - size * 0.12, x1 = pos[j] + line[j].width + size * 0.12;
          rrect(g, x0, y - size * 0.9, x1 - x0, size * 1.16, size * 0.14); g.fill();
          i = j + 1;
        }
      }
      line.forEach((t, k) => {
        g.fillStyle = t.hi ? (useMark ? pal.markInk : pal.alt) : pal.ink;
        g.fillText(t.w, pos[k], y);
      });
      y += lh;
    }
    // Quelle und Marke
    const src = `${book.author ? book.author.slice(0, 36) + ' · ' : ''}${pageLabel(book, q.from)}`;
    if (yl) {
      g.fillStyle = pal.ink; g.font = `800 46px ${font}`; g.fillText(book.title.slice(0, 36), pad, 1720);
      g.font = `500 36px ${font}`; g.fillText(src, pad, 1776);
      g.textAlign = 'right'; g.font = `800 40px ${font}`;
      const dot = pal.dot || '#FF5B3A', right = W - pad;
      const wDot = g.measureText('.').width, wLaut = g.measureText('laut').width;
      g.fillStyle = dot; g.fillText('.', right, 1776);
      g.fillStyle = pal.ink; g.fillText('laut', right - wDot, 1776);
      g.fillStyle = dot; g.fillText('.', right - wDot - wLaut, 1776);
      g.fillStyle = pal.ink; g.fillText('wort', right - 2 * wDot - wLaut, 1776);
    } else {
      g.fillStyle = pal.logo; g.fillRect(pad, 1600, 80, 6);
      g.fillStyle = pal.ink; g.font = '600 44px Figtree, sans-serif'; g.fillText(book.title.slice(0, 40), pad, 1680);
      g.globalAlpha = 0.7; g.font = '400 36px Figtree, sans-serif'; g.fillText(src, pad, 1736);
      g.font = `600 34px ${font}`; g.textAlign = 'right'; g.fillText('Wort. Laut.', W - pad, 1736); g.globalAlpha = 1;
    }
    g.textAlign = 'left';
  }
  // Studio öffnen: Vorschau, Hintergrund, Stil, Speichern/Teilen
  async function shareQuote(qid) {
    const q = await findQuote(qid);
    const book = state.book;
    if (!q || !book) return;
    const look = young() ? 'young' : 'sand';
    const bgs = CARD_BGS[look];
    const bgKey = () => (bgs.some((b) => b.k === S['shareBg_' + look]) ? S['shareBg_' + look] : bgs[0].k);
    const styleKey = () => (CARD_STYLES.some(([k]) => k === S.shareStyle) ? S.shareStyle : 'akzent');
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 1920; c.className = 'studio-card';
    c.setAttribute('role', 'img'); c.setAttribute('aria-label', 'Vorschau der Zitat-Karte');
    const ov = document.createElement('div');
    ov.className = 'studio';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Zitat als Story teilen');
    const controls = () => `
      <div class="studio-group"><span class="studio-label">Hintergrund</span>
        <div class="swatches" role="radiogroup" aria-label="Hintergrundfarbe">${bgs.map((b) => `<button role="radio" aria-checked="${b.k === bgKey()}" aria-label="${b.n}" data-sbg="${b.k}" style="background:${b.bg}"></button>`).join('')}</div></div>
      <div class="studio-group"><span class="studio-label">Stil</span>
        <div class="seg studio-seg" role="radiogroup" aria-label="Stil des Zitats">${CARD_STYLES.map(([k, l]) => `<button role="radio" aria-checked="${k === styleKey()}" class="${k === styleKey() ? 'on' : ''}" data-sst="${k}">${l}</button>`).join('')}</div></div>`;
    ov.innerHTML = `<div class="studio-top"><button class="studio-x" data-sx aria-label="Schließen"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><b>Als Story teilen</b><span style="width:44px"></span></div>
      <div class="studio-stage"></div>
      <div class="studio-ctrl">${controls()}</div>
      <div class="studio-actions"><button class="studio-btn" data-ssave>Bild speichern</button><button class="studio-btn main" data-sshare>${I.share} Teilen</button></div>`;
    ov.querySelector('.studio-stage').appendChild(c);
    document.body.appendChild(ov);
    document.body.classList.add('studio-open');
    const redraw = async () => { await drawCard(c, book, q, look, bgKey(), styleKey()); ov.querySelector('.studio-ctrl').innerHTML = controls(); };
    const close = () => { ov.remove(); document.body.classList.remove('studio-open'); window.removeEventListener('hashchange', close); };
    window.addEventListener('hashchange', close);
    ov.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-sx')) return close();
      if (b.dataset.sbg) { S['shareBg_' + look] = b.dataset.sbg; saveSettings(); return redraw(); }
      if (b.dataset.sst) { S.shareStyle = b.dataset.sst; saveSettings(); return redraw(); }
      if (b.hasAttribute('data-ssave')) return saveCanvas(c);
      if (b.hasAttribute('data-sshare')) return shareCanvas(c, `„${quoteText(book, q)}“ – ${book.title}`);
    });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    await redraw();
    ov.querySelector('[data-sx]').focus();
  }
  async function saveCanvas(c) {
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'zitat.png';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Bild gespeichert');
  }
  async function shareCanvas(c, caption) {
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const file = new File([blob], 'zitat.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: caption }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    return saveCanvas(c);
  }

  // ---------------- Player-Ansicht ----------------
  function sunSvg(frac) {
    const cx = 171, cy = 126, r = 120;
    let sun = '';
    if (frac != null) {
      const a = Math.PI * Math.min(1, Math.max(0, frac));
      const x = (cx - r * Math.cos(a)).toFixed(1), y = (cy - r * Math.sin(a)).toFixed(1);
      sun = `${frac > 0.005 ? `<path d="M51 126 A120 120 0 0 1 ${x} ${y}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" opacity="${document.body.classList.contains('night') ? 0.5 : 1}"/>` : ''}
        <circle cx="${x}" cy="${y}" r="20" fill="var(--accent)" opacity="0.08"/><circle cx="${x}" cy="${y}" r="13" fill="var(--accent)" opacity="0.16"/><circle cx="${x}" cy="${y}" r="8" fill="var(--accent)"/>`;
    }
    const stars = `<g fill="var(--star)"><circle cx="30" cy="20" r="1.2"/><circle cx="120" cy="8" r="1"/><circle cx="214" cy="18" r="1.2"/><circle cx="318" cy="30" r="0.9"/><circle cx="12" cy="74" r="0.9"/></g>`;
    return `<svg viewBox="0 0 342 128" role="img" aria-label="Sleep-Timer">${stars}
      <path d="M51 126 A120 120 0 0 1 291 126" fill="none" stroke="var(--line2)" stroke-width="1.5" stroke-dasharray="3 5"/>${sun}
      <line x1="0" y1="126" x2="342" y2="126" stroke="var(--text)" stroke-opacity=".75" stroke-width="1.5"/></svg>`;
  }
  function sunTexts() {
    const book = state.book;
    const left = timerLeftMs();
    if (P.timer) {
      const sub = P.timer.mode === 'sec' ? 'bis Abschnittsende' : 'bis Sonnenuntergang';
      const extra = !P.playing ? 'pausiert' : left < 60000 ? 'Stimme wird leiser' : `endet ${pageLabel(book, P.timer.mode === 'sec' ? P.timer.endIdx : E.indexForOffset(book, book.sentences[P.idx].o + (left / 1000) * CHARS_PER_SEC * S.rate))}`;
      return { big: (P.timer.mode === 'sec' ? '≈ ' : '') + fmtTime(left), word: false, sub: `${sub} · ${extra}` };
    }
    if (!P.playing) return { big: 'Pausiert', word: true, sub: `ohne Timer · ${Math.round(P.sessionMs / 60000)} min gehört` };
    return { big: fmtTime(P.sessionMs), word: false, sub: 'gehört · ohne Timer' };
  }
  function updateSun() {
    const w = $('#sun');
    if (!w) return;
    const t = sunTexts();
    if (young() && state.book) {
      const book = state.book;
      const frac = P.timer ? timerFraction() : null;
      w.innerHTML = `<div class="ytop"><span class="ypage">S.${esc(String(E.pageOf(book, P.idx)))}</span><span class="ypct">${E.percentOf(book, P.idx)}%</span></div>
        ${frac != null ? `<div class="ybar" role="img" aria-label="Sleep-Timer"><div style="width:${Math.round(frac * 100)}%"></div></div>` : ''}`;
      const sub = $('#sunsub');
      if (sub) sub.textContent = P.timer ? `${P.timer.mode === 'sec' ? '≈ ' : 'noch '}${fmtTime(timerLeftMs())} · ${t.sub.split(' · ').slice(1).join(' · ') || (P.playing ? '' : 'pausiert')}` : (P.playing ? `${fmtTime(P.sessionMs)} gehört` : 'Pausiert');
      return;
    }
    w.innerHTML = sunSvg(P.timer ? timerFraction() : null) + `<span class="sun-time ${t.word ? 'word' : ''}">${esc(t.big)}</span>`;
    const sub = $('#sunsub');
    if (sub) sub.textContent = t.sub;
  }
  function updateText() {
    const box = $('#reading');
    if (!box || !state.book) return;
    const book = state.book;
    const i = P.idx;
    // Stopp-Kasten zuerst setzen, damit die Texthöhe stimmt, bevor der Satz ausgerichtet wird
    const sb = $('#stopbox');
    if (sb) sb.innerHTML = !P.playing ? stopBoxHtml() : '';
    // Scrollbares Textfenster: einmal einen größeren Ausschnitt aufbauen und nur bei Bedarf nachladen
    const win = state.textWin;
    const fresh = !win || win.bookId !== book.id || !box.querySelector('p') || i < win.lo + 4 || i > win.hi - 6;
    if (fresh) {
      // Nicht neu aufbauen, während jemand gerade selbst scrollt (sonst springt der Text weg)
      if (win && win.bookId === book.id && isManualScroll() && box.querySelector('p')) { markSpans(); return; }
      const lo = Math.max(0, i - 40), hi = Math.min(book.sentences.length - 1, i + 80);
      let html = '';
      for (let k = lo; k <= hi; k++) html += `<span data-i="${k}">${esc(T(book.sentences[k]))}</span> `;
      box.innerHTML = `<p>${html}</p>`;
      state.textWin = { bookId: book.id, lo, hi };
    }
    markSpans();
    followCur(fresh ? 'auto' : 'smooth');
    const pg = $('#pagelbl');
    if (pg) pg.textContent = `${book.title} · ${pageLabel(book, i)}`;
  }
  // Aktuellen Satz und gemerkte Zitate im Textfenster kennzeichnen
  function markSpans() {
    const box = $('#reading');
    if (!box || !state.book) return;
    const book = state.book;
    const qs = (state.quoteList || []).filter((q) => q.bookId === book.id);
    box.querySelectorAll('span[data-i]').forEach((sp) => {
      const k = +sp.dataset.i;
      sp.classList.toggle('cur', k === P.idx);
      sp.classList.toggle('q', qs.some((q) => k >= q.from && k <= q.to));
    });
  }
  // Selbst scrollen pausiert das Mitlaufen für ein paar Sekunden
  const FOLLOW_PAUSE_MS = 8000;
  let manualAt = 0;
  const isManualScroll = () => Date.now() - manualAt < FOLLOW_PAUSE_MS;
  function followCur(behavior) {
    const box = $('#reading');
    if (!box) return;
    const cur = box.querySelector('.cur');
    const jb = $('#jumpcur');
    if (isManualScroll()) {
      if (jb) jb.hidden = !cur || Math.abs(box.scrollTop - (cur.offsetTop - box.clientHeight * 0.34)) < 40;
      return;
    }
    if (jb) jb.hidden = true;
    if (!cur) return;
    const top = Math.max(0, cur.offsetTop - box.clientHeight * 0.34);
    if (typeof box.scrollTo === 'function') box.scrollTo({ top, behavior: behavior || 'smooth' });
    else box.scrollTop = top;
  }
  function anchorText() { followCur('auto'); }
  ['touchstart', 'wheel', 'pointerdown'].forEach((ev) => document.addEventListener(ev, (e) => {
    if (e.target.closest && e.target.closest('#reading') && !e.target.closest('#jumpcur')) {
      manualAt = Date.now();
      const jb = $('#jumpcur');
      if (jb) jb.hidden = false;
      clearTimeout(followCur.t);
      followCur.t = setTimeout(() => { if (!isManualScroll()) followCur('smooth'); }, FOLLOW_PAUSE_MS + 100);
    }
  }, { passive: true }));
  window.addEventListener('resize', anchorText);
  function stopBoxHtml() {
    return `<div class="stop-box"><span class="col" style="gap:2px"><span class="small">Gestoppt bei</span><span class="serif" style="font-size:20px;font-weight:600">${pageLabel(state.book, P.idx)}</span></span>
      <button class="btn" data-act="copy-cur" style="background:var(--bg)">${I.copy} Satz kopieren</button></div>`;
  }
  function updatePlayerUi() {
    const b = $('#mainbtn');
    if (b) { b.innerHTML = P.playing ? I.pause : I.play; b.setAttribute('aria-label', P.playing ? 'Pause' : 'Abspielen'); }
    const tl = $('#timerlbl');
    if (tl) tl.textContent = timerChipLabel();
    const mb = $('#markbtn');
    if (mb) { const on = markActive(); mb.classList.toggle('on', on); mb.querySelector('span').textContent = on ? 'Gemerkt' : 'Das war gut'; }
    updateMini();
    const err = $('#perr');
    if (err) err.innerHTML = P.error ? `<div class="banner">${esc(P.error)}${P.error.includes('Kontingent') ? '' : ' <a href="#/settings">Einstellungen</a>'}</div>` : '';
    updateSun();
    updateText();
    if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = P.playing ? 'playing' : 'paused'; } catch (e) {}
  }

  async function recentBookId() {
    const prog = (await dbAll('progress')).filter((p) => p.lastAt).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    if (prog.length) return prog[0].id;
    const books = await dbAll('books');
    return books.length ? books[0].id : null;
  }
  route(/^\/player$/, async () => {
    if (!P.started) {
      // Kein laufendes Hören: letztes Buch bereitlegen (pausiert, ein Tipp auf Play startet)
      const id = state.book ? state.book.id : await recentBookId();
      if (!id) {
        app.innerHTML = `<div class="screen"><h1>Hören</h1><div class="empty">Noch kein Buch in der Bibliothek.</div><button class="btn solid big" data-act="add">${I.plus} EPUB laden</button></div>`;
        return;
      }
      await loadBook(id);
      if (!P.playing) P.idx = state.progress.pos;
    }
    const book = state.book;
    await bookQuotes(book.id);
    app.innerHTML = `<div class="screen player">
      <div class="between"><button class="icon-btn bare" data-act="minimize" aria-label="Player minimieren">${I.down}</button>
        <button class="btn link" id="pagelbl" data-act="open" data-id="${esc(book.id)}" style="flex:1;justify-content:center;color:var(--muted);font-weight:500;min-width:0"></button><span style="width:32px"></span></div>
      ${P.engine === 'device' ? `<div class="banner">Vorschau mit Handy-Stimme. Für die natürliche Stimme <a href="#/settings">Zugang eintragen</a>.</div>` : ''}
      <div class="col" style="align-items:center;gap:6px"><div class="sun-wrap" id="sun"></div><span class="muted" id="sunsub" style="text-align:center"></span></div>
      <div id="perr"></div>
      <div class="reading-wrap"><div class="reading" id="reading" aria-live="off"></div>
        <button class="jumpcur" id="jumpcur" data-act="jumpcur" hidden>${I.down} Zur aktuellen Stelle</button></div>
      <div id="markbar"></div>
      <div id="stopbox"></div>
      <div class="controls">
        <button class="ctl" data-act="prev" aria-label="Einen Satz zurück">${I.prev}</button>
        <button class="ctl main" id="mainbtn" data-act="toggle" aria-label="Pause">${I.pause}</button>
        <button class="ctl" data-act="next" aria-label="Einen Satz vor">${I.next}</button>
      </div>
      <div class="chips" style="justify-content:center;flex-wrap:nowrap">
        <button class="chip ichip" id="plus10" data-act="plus10" aria-label="Sleep-Timer">${I.moon}<span id="timerlbl">Aus</span></button>
        <button class="chip ichip" data-act="rate" aria-label="Tempo">${I.gauge}<span id="ratelbl">${String(S.rate).replace('.', ',')}×</span></button>
        <button class="chip ichip mark" id="markbtn" data-act="mark">${I.heart}<span>Das war gut</span></button>
      </div>
    </div>`;
    updatePlayerUi();
    showMarkbar();
  });

  // ---------------- Gestoppt ----------------
  route(/^\/stopped$/, async () => {
    if (!state.book) return go('#/');
    const book = state.book;
    const p = state.progress;
    const mins = Math.max(1, Math.round(P.sessionMs / 60000));
    const night = document.body.classList.contains('night');
    const sentence = T(book.sentences[p.last]);
    app.innerHTML = `<div class="screen stopped">
      <svg class="sunset-art" viewBox="0 0 342 120" role="img" aria-label="Die Sonne ist untergegangen" style="width:100%;height:auto">
        <g fill="var(--star)"><circle cx="40" cy="20" r="1.3"/><circle cx="98" cy="48" r="1"/><circle cx="150" cy="14" r="1.5"/><circle cx="214" cy="40" r="1"/><circle cx="262" cy="10" r="1.2"/><circle cx="300" cy="56" r="0.9"/></g>
        <path d="M291 104 A20 20 0 0 1 331 104 Z" fill="var(--accent)" opacity="0.18"/><path d="M299 104 A12 12 0 0 1 323 104 Z" fill="var(--accent)" opacity="0.6"/>
        <line x1="0" y1="104" x2="342" y2="104" stroke="var(--line)" stroke-width="1.5"/></svg>
      <p class="muted" style="text-align:center;margin:0;font-size:14px">${P.endedBy === 'end' ? 'Ende des Buches erreicht.' : (night ? 'Gute Nacht. ' : '') + `Du hast ${mins === 1 ? 'eine Minute' : mins + ' Minuten'} gehört.`}</p>
      <div class="card" style="align-items:center;text-align:center;gap:16px;padding:26px 22px">
        <span class="label accent">Weiterlesen auf</span>
        <span class="big-page">${pageLabel(book, p.last).replace('ca. ', '')}</span>
        <span class="muted" style="font-size:14px">${esc(book.title)} · ${E.percentOf(book, p.last)} %${book.printPages || book.pageMarks ? '' : ' · Seite geschätzt'}</span>
        <div style="width:100%;height:1px;background:var(--line)"></div>
        <span class="small">Letzter Satz – zum Suchen im Reader</span>
        <p class="quote">„${esc(sentence)}“</p>
        <button class="btn" data-act="copy-last" style="background:var(--bg)">${I.copy} Satz kopieren</button>
      </div>
      <div class="col" style="margin-top:auto;gap:8px">
        ${P.sessionQuotes ? `<a class="list-btn" href="#/quotes/${esc(book.id)}" style="text-decoration:none;color:inherit;margin-bottom:6px"><span class="row" style="gap:10px">${I.heart}<span class="col" style="gap:2px"><span style="font-weight:600">${P.sessionQuotes === 1 ? '1 Zitat' : P.sessionQuotes + ' Zitate'} gemerkt</span><span class="small">Ansehen, kürzen, teilen</span></span></span>${I.chev}</a>` : ''}
        ${P.endedBy === 'end' ? '' : `<button class="btn solid big" data-act="more15">Noch 15 Minuten</button>`}
        <a href="#/" class="btn link" style="justify-content:center;text-decoration:none">Zur Bibliothek</a>
      </div>
    </div>`;
  });

  // ---------------- Einstellungen ----------------
  route(/^\/settings$/, async () => {
    const hasWorker = !!workerUrl();
    app.innerHTML = `<div class="screen">
      <div class="row" style="gap:8px"><a href="#/" class="icon-btn bare" aria-label="Zurück">${I.back}</a><h1 style="font-size:26px">Einstellungen</h1></div>
      <div class="card"><span class="label">Kontingent diesen Monat</span><div id="me" class="col"><span class="muted">${hasWorker ? (S.code ? 'Prüfe Zugang …' : 'Noch kein Zugangscode – trag ihn unten unter „Zugang & Server“ ein.') : 'Noch keine Server-Adresse – unten unter „Zugang & Server“ eintragen.'}</span></div></div>
      <div id="adminlink"></div>
      <div class="card"><span class="label">Stimme</span>
        <div class="field" style="background:var(--bg)"><label for="voice">Stimme</label><select id="voice">${voiceOptions(state.voices || DEFAULT_VOICES)}</select></div>
        <span class="small">Mehrsprachige Stimmen lesen fremdsprachige Stellen im Buch mit passender Aussprache.</span>
        <div class="chips tight">${RATES.map((r) => `<button class="chip ${r === S.rate ? 'on' : ''}" data-act="setrate" data-v="${r}" aria-label="Tempo ${String(r).replace('.', ',')}">${String(r).replace('.', ',')}×</button>`).join('')}</div>
        <button class="btn" data-act="testvoice">${I.playS} Probehören</button>
      </div>
      <div class="card"><span class="label">Darstellung</span>
        <div class="chips">${[['young', 'Jung & mutig'], ['sand', 'Sand']].map(([v, l]) => `<button class="chip ${(S.look || 'young') === v ? 'on' : ''}" data-act="look" data-v="${v}">${l}</button>`).join('')}</div>
        ${young() ? '<span class="small">Kräftige Farben, Player in Schwarz.</span>' : `<span class="small">Ruhig, mit Sonnen-Timer. Hell oder dunkel:</span>
        <div class="chips">${[['auto', 'Nach Sonnenstand'], ['day', 'Hell'], ['night', 'Dunkel']].map(([v, l]) => `<button class="chip ${S.theme === v ? 'on' : ''}" data-act="theme" data-v="${v}">${l}</button>`).join('')}</div>`}
      </div>
      <details class="card" ${!S.code || !hasWorker ? 'open' : ''}><summary class="label" style="cursor:pointer">Zugang &amp; Server</summary>
        <form id="codeform" class="col" style="gap:10px">
          <div class="field" style="background:var(--bg)"><label for="code">Zugangscode</label>
            <div class="row" style="gap:6px"><input id="code" type="password" autocomplete="off" autocapitalize="off" value="${esc(S.code)}" placeholder="z. B. abcde-fghij"><button type="button" class="btn link" data-act="showcode" style="height:34px">Zeigen</button></div></div>
          <button class="btn" type="submit">Code speichern</button>
        </form>
        <form id="wform" class="col" style="gap:10px"><div class="field" style="background:var(--bg)"><label for="wurl">Server-Adresse (Worker)</label><input id="wurl" autocomplete="off" value="${esc(S.workerUrl)}" placeholder="${esc((window.HB_CONFIG && window.HB_CONFIG.workerUrl) || 'https://….workers.dev')}"></div>
          <button class="btn" type="submit">Adresse speichern</button></form>
        <span class="label" style="margin-top:6px">Eigener Azure-Schlüssel (optional)</span>
        <p class="small" style="line-height:1.5;margin:0">Mit eigenem Schlüssel hörst du über dein eigenes Azure-Konto statt über ein geteiltes Kontingent. Der Schlüssel bleibt auf diesem Gerät und wird nur zum Vorlesen durchgereicht.</p>
        <form id="keyform" class="col" style="gap:10px">
          <div class="field" style="background:var(--bg)"><label for="okey">Schlüssel</label><input id="okey" type="password" autocomplete="off" value="${esc(S.ownKey)}"></div>
          <div class="field" style="background:var(--bg)"><label for="oreg">Region</label><input id="oreg" autocomplete="off" value="${esc(S.ownRegion)}" placeholder="westeurope"></div>
          <div class="row"><button class="btn" type="submit">Schlüssel speichern</button>${S.ownKey ? '<button class="btn link danger" type="button" data-act="clearkey">Entfernen</button>' : ''}</div>
        </form>
      </details>
    </div>`;
    $('#voice').addEventListener('change', (e) => { S.voice = e.target.value; saveSettings(); P.cache.clear(); });
    $('#codeform').addEventListener('submit', (e) => { e.preventDefault(); saveCode(); });
    $('#keyform').addEventListener('submit', (e) => {
      e.preventDefault();
      S.ownKey = $('#okey').value.trim();
      S.ownRegion = $('#oreg').value.trim().toLowerCase() || 'westeurope';
      saveSettings();
      toast('Gespeichert');
      render();
    });
    $('#wform').addEventListener('submit', (e) => { e.preventDefault(); S.workerUrl = $('#wurl').value.trim(); saveSettings(); toast('Gespeichert'); render(); });
    loadMe();
    loadVoices();
  });
  function saveCode() {
    S.code = $('#code').value.trim();
    saveSettings();
    state.me = null;
    toast('Gespeichert');
    render();
  }
  // Kontingent-Anzeige
  const fmtHM = (chars) => {
    const m = Math.max(0, Math.round(chars / 1000)); // 1.000 Zeichen ≈ 1 Minute
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
  };
  function resetDate() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString('de-DE', { day: 'numeric', month: 'long' });
  }
  function quotaGauge(limit, parts) {
    // parts: [{ chars, color, label }] – dezenter, gestapelter Balken
    const used = parts.reduce((n, p) => n + p.chars, 0);
    const left = Math.max(0, limit - used);
    const segs = parts.map((p) => `<div style="width:${Math.min(100, (p.chars / limit) * 100).toFixed(2)}%;height:6px;background:${p.color}"></div>`).join('');
    return `<div class="between" style="align-items:baseline"><span style="font-weight:600">${fmtHM(left)} übrig</span><span class="small">von ${fmtHM(limit)} · neu am ${resetDate()}</span></div>
      <div role="img" aria-label="${fmtHM(used)} verbraucht, ${fmtHM(left)} übrig" style="display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--line)">${segs}</div>
      ${parts.length > 1 ? `<div class="row" style="gap:14px;flex-wrap:wrap">${parts.map((p) => `<span class="row small" style="gap:6px"><span style="width:8px;height:8px;border-radius:4px;background:${p.color}"></span>${esc(p.label)}: ${fmtHM(p.chars)}</span>`).join('')}</div>` : `<span class="small">${fmtHM(used)} verbraucht</span>`}`;
  }
  const FREE_CHARS = 500000; // Azure-Gratis-Kontingent pro Monat

  async function loadMe() {
    const box = $('#me');
    if (!box || !workerUrl() || !S.code) return;
    try {
      const me = await api('/me');
      state.me = me;
      const limit = me.limitChars;
      const pct = limit ? Math.min(100, Math.round((me.usedChars / limit) * 100)) : null;
      let gauge = '';
      if (me.admin) {
        // Admin sieht das gemeinsame Azure-Kontingent: eigener Verbrauch + alle Eingeladenen
        let others = 0;
        try { const d = await api('/admin/codes'); others = d.codes.reduce((n, c) => n + c.usedChars, 0); } catch (e) {}
        gauge = quotaGauge(FREE_CHARS, [
          { chars: me.usedChars, color: 'var(--accent)', label: 'Du' },
          ...(others ? [{ chars: others, color: '#8DA2B5', label: 'Eingeladene' }] : []),
        ]);
      } else if (limit) {
        gauge = quotaGauge(limit, [{ chars: me.usedChars, color: 'var(--accent)', label: 'Verbraucht' }]);
      }
      box.innerHTML = `<span class="small">Angemeldet als ${esc(me.name)}${me.paused ? ' · pausiert' : ''}</span>
        ${gauge || `<span class="muted">Diesen Monat ${fmtHM(me.usedChars)} verbraucht</span>`}
        <span class="small">Gezählt wird alles, was bei Azure angefragt wurde – auch vorgeladene Abschnitte und Probehören.</span>
        ${S.ownKey ? '<span class="small">Gerade aktiv: dein eigener Azure-Schlüssel.</span>' : ''}`;
      if (me.admin) $('#adminlink').innerHTML = `<a class="list-btn" href="#/admin" style="text-decoration:none;color:inherit"><span class="col" style="gap:2px"><span style="font-weight:600">Zugänge verwalten</span><span class="small">Personen einladen, Kontingente festlegen</span></span>${I.chev}</a>`;
    } catch (e) {
      box.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
    }
  }
  // Stimmenliste: deutsche Stimmen oben, Sprecher anderer Sprachen (mit Akzent) darunter
  function voiceOptions(list) {
    const opt = (x) => `<option value="${esc(x.id)}" ${x.id === S.voice ? 'selected' : ''}>${esc(x.name)}${x.hd ? ' (ausdrucksstark)' : x.multilingual && x.id.startsWith('de-DE-') ? ' (mehrsprachig)' : ''}</option>`;
    const de = list.filter((x) => x.id.startsWith('de-DE-'));
    const other = list.filter((x) => !x.id.startsWith('de-DE-'));
    return `<optgroup label="Deutsche Stimmen">${de.map(opt).join('')}</optgroup>` +
      (other.length ? `<optgroup label="Andere Sprecher (sprechen Deutsch mit Akzent)">${other.map(opt).join('')}</optgroup>` : '');
  }
  async function loadVoices() {
    if (state.voices || !hasCloudVoice()) return;
    try {
      const v = await api('/voices');
      if (Array.isArray(v) && v.length) {
        // HD-Stimmen immer zum Ausprobieren anbieten, auch wenn die Region sie nicht auflistet
        for (const d of DEFAULT_VOICES.filter((x) => x.hd).reverse()) if (!v.some((x) => x.id === d.id)) v.unshift({ ...d, name: d.name + ' – testen' });
        state.voices = v;
        const sel = $('#voice');
        if (sel) sel.innerHTML = voiceOptions(v);
      }
    } catch (e) { /* Standardliste reicht */ }
  }
  let testAudio;
  async function testVoice() {
    if (!hasCloudVoice()) {
      const u = new SpeechSynthesisUtterance('So klingt die einfache Handy-Stimme.');
      u.lang = 'de-DE';
      return speechSynthesis.speak(u);
    }
    try {
      const res = await fetch(workerUrl() + '/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ voice: S.voice, rate: S.rate, parts: [['Hallo! So klinge ich, wenn ich dir dein Buch vorlese. Gute Unterhaltung beim Zuhören.', null]] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Fehler ' + res.status);
      if (testAudio) testAudio.pause();
      testAudio = new Audio(URL.createObjectURL(await res.blob()));
      testAudio.playbackRate = isHD(S.voice) ? S.rate : 1;
      testAudio.play();
    } catch (e) { toast(e.message); }
  }

  // ---------------- Zugänge verwalten ----------------
  route(/^\/admin$/, async () => {
    app.innerHTML = `<div class="screen">
      <div class="row" style="gap:8px"><a href="#/settings" class="icon-btn bare" aria-label="Zurück">${I.back}</a><h1 style="font-size:26px">Zugänge</h1></div>
      <div id="alist" class="col" style="gap:10px"><span class="muted">Lade …</span></div>
      <form id="newform" class="card"><span class="label">Neue Person einladen</span>
        <div class="split" style="grid-template-columns:2fr 1fr">
          <div class="field" style="background:var(--bg)"><label for="nname">Name</label><input id="nname" required maxlength="60" placeholder="z. B. Lena"></div>
          <div class="field" style="background:var(--bg)"><label for="nhours">Stunden/Monat</label><input id="nhours" type="number" inputmode="decimal" step="0.5" min="0.5" value="2"></div>
        </div>
        <button class="btn solid" type="submit">Einladung erstellen</button>
        <span class="small">Gratis bei Azure: ca. 8 Stunden pro Monat – für alle zusammen, dich eingeschlossen.</span>
      </form>
    </div>`;
    $('#newform').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const rec = await api('/admin/codes', { method: 'POST', body: JSON.stringify({ name: $('#nname').value, hours: parseFloat(String($('#nhours').value).replace(',', '.')) }) });
        await shareInvite(rec);
        render();
      } catch (err) { toast(err.message); }
    });
    loadAdmin();
  });
  function inviteLink(code) { return location.origin + location.pathname + '#code=' + code; }
  async function shareInvite(rec) {
    const link = inviteLink(rec.code);
    const text = `Hier ist dein Zugang zu Wort. Laut., der Vorlese-App: ${link}`;
    if (navigator.share) { try { await navigator.share({ title: 'Wort. Laut.', text }); return; } catch (e) { /* abgebrochen */ } }
    try { await navigator.clipboard.writeText(text); toast('Einladungslink kopiert'); } catch { prompt('Einladungslink:', link); }
  }
  async function loadAdmin() {
    const box = $('#alist');
    try {
      const d = await api('/admin/codes');
      const totalLimit = d.codes.reduce((n, c) => n + c.limitChars, 0);
      const totalUsed = d.codes.reduce((n, c) => n + c.usedChars, 0) + d.adminUsedChars;
      box.innerHTML = `<div class="card" style="gap:10px"><span class="label">Gratis-Kontingent diesen Monat</span>
          ${quotaGauge(FREE_CHARS, [
            { chars: d.adminUsedChars, color: 'var(--accent)', label: 'Du' },
            { chars: totalUsed - d.adminUsedChars, color: '#8DA2B5', label: 'Eingeladene' },
          ])}
          <span class="small">Zugesagt an andere: bis zu ${fmtHM(totalLimit)} pro Monat</span></div>` +
        (d.codes.length ? d.codes.map((c) => `<div class="card" style="gap:10px">
          <div class="between"><span style="font-weight:600">${esc(c.name)}${c.paused ? ' · <span class="muted">pausiert</span>' : ''}</span><span class="muted">${fmtHours(c.usedChars)} / ${fmtHours(c.limitChars)}</span></div>
          <div class="meter"><div style="width:${Math.min(100, Math.round((c.usedChars / c.limitChars) * 100))}%"></div></div>
          <div class="chips">
            <button class="chip" data-act="ainvite" data-code="${esc(c.code)}">Link teilen</button>
            <button class="chip" data-act="ahours" data-code="${esc(c.code)}" data-h="${c.limitChars / 60000}">Stunden</button>
            <button class="chip" data-act="apause" data-code="${esc(c.code)}" data-p="${c.paused ? '0' : '1'}">${c.paused ? 'Fortsetzen' : 'Pausieren'}</button>
            <button class="chip" data-act="adel" data-code="${esc(c.code)}" data-name="${esc(c.name)}" aria-label="${esc(c.name)} löschen">Löschen</button>
          </div></div>`).join('') : `<p class="muted" style="margin:0">Noch niemand eingeladen.</p>`);
    } catch (e) {
      box.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
    }
  }

  // ---------------- Klicks ----------------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.closest('.overlay')) return;
    const act = el.dataset.act;
    const book = state.book;
    switch (act) {
      case 'add': return pickFile();
      case 'settings': return go('#/settings');
      case 'open': state.book = null; return go('#/book/' + el.dataset.id);
      case 'timer': S.timer = el.dataset.v === 'sec' ? 'sec' : parseInt(el.dataset.v, 10); saveSettings(); return render();
      case 'sections': return chooseSection();
      case 'copy-last': return copy(T(book.sentences[state.progress.last]));
      case 'copy-cur': return copy(T(book.sentences[P.idx]));
      case 'pages': {
        const pp = await askPages(book, book);
        book.printPages = pp;
        await dbPut('books', book);
        return render();
      }
      case 'delete': {
        const ok = await sheet(`<p class="serif" style="font-size:20px;margin:0">„${esc(book.title)}“ aus der Bibliothek entfernen?</p><p class="muted" style="margin:0">Die EPUB-Datei auf deinem Handy bleibt erhalten, nur die App vergisst das Buch und deinen Fortschritt.</p>
          <button class="btn solid big" data-v="yes">Entfernen</button><button class="btn link" data-v="no">Abbrechen</button>`);
        if (ok !== 'yes') return;
        await dbDel('books', book.id);
        await dbDel('progress', book.id);
        state.book = null;
        return go('#/');
      }
      case 'start': {
        const start = state.startIdx != null ? state.startIdx : state.progress.pos;
        return beginSession(start);
      }
      case 'play-book': {
        state.book = null;
        await loadBook(el.dataset.id);
        return beginSession(state.progress.pos);
      }
      case 'tab': return go(el.dataset.v, true);
      case 'openplayer': return go('#/player', true);
      case 'minimize': return go('#/', true);
      case 'selhit': state.selHit = +el.dataset.v; return render();
      case 'usehit': {
        state.startIdx = state.hits[state.selHit].idx;
        return go('#/book/' + book.id, true);
      }
      case 'toggle':
        if (P.playing) return pause();
        if (!P.started || (P.pausedAt && Date.now() - P.pausedAt > PAUSE_NEW_SESSION_MS)) return beginSession(P.idx, true);
        return resume();
      case 'prev': return jumpTo(P.idx - 1);
      case 'next': return jumpTo(P.idx + 1);
      case 'plus10':
        return chooseTimer();
      case 'rate': {
        const res = await sheet(`<h2 class="label">Tempo</h2><div>${RATES.map((r) => `<button class="list-btn" data-v="${r}"><span>${String(r).replace('.', ',')}×${r === 1 ? ' · normal' : r < 1 ? ' · ruhiger' : ''}</span>${r === S.rate ? '✓' : ''}</button>`).join('')}</div>`);
        if (res == null || parseFloat(res) === S.rate) return;
        S.rate = parseFloat(res);
        saveSettings();
        const rl = $('#ratelbl');
        if (rl) rl.textContent = String(S.rate).replace('.', ',') + '×';
        if (P.engine === 'cloud' && P.playing) playFrom(P.idx);
        return;
      }
      case 'more15': return beginSession(state.progress.pos, false, 15);
      case 'findmode': { S.findMode = el.dataset.v; saveSettings(); const y = window.scrollY; await render(); window.scrollTo(0, y); return; }
      case 'mark': return markQuote();
      case 'jumpcur': manualAt = 0; return followCur('smooth');
      case 'mark-undo': return undoMark();
      case 'q-share': return shareQuote(el.dataset.id);
      case 'q-copy': return copyQuote(el.dataset.id);
      case 'q-more': return quoteMenu(el.dataset.id);
      case 'savecode': return saveCode();
      case 'showcode': { const c = $('#code'); const show = c.type === 'password'; c.type = show ? 'text' : 'password'; el.textContent = show ? 'Verbergen' : 'Zeigen'; return; }
      case 'clearkey': S.ownKey = ''; saveSettings(); return render();
      case 'setrate': S.rate = parseFloat(el.dataset.v); saveSettings(); P.cache.clear(); return render();
      case 'theme': S.theme = el.dataset.v; saveSettings(); return render();
      case 'look': S.look = el.dataset.v; saveSettings(); return render();
      case 'testvoice': return testVoice();
      case 'ainvite': return shareInvite({ code: el.dataset.code });
      case 'ahours': {
        const res = await sheet(`<form class="col" style="gap:14px"><div class="field"><label for="hh">Stunden pro Monat</label><input id="hh" name="hh" class="big" type="number" inputmode="decimal" step="0.5" min="0.5" value="${el.dataset.h}"></div><button class="btn solid big" type="submit">Speichern</button></form>`);
        if (!res || !res.hh) return;
        try { await api('/admin/codes/' + el.dataset.code, { method: 'PATCH', body: JSON.stringify({ hours: parseFloat(String(res.hh.value).replace(',', '.')) }) }); } catch (err) { toast(err.message); }
        return loadAdmin();
      }
      case 'apause':
        try { await api('/admin/codes/' + el.dataset.code, { method: 'PATCH', body: JSON.stringify({ paused: el.dataset.p === '1' }) }); } catch (err) { toast(err.message); }
        return loadAdmin();
      case 'adel': {
        const ok = await sheet(`<p class="serif" style="font-size:20px;margin:0">Zugang von ${esc(el.dataset.name)} löschen?</p><p class="muted" style="margin:0">Der Einladungslink funktioniert dann nicht mehr.</p><button class="btn solid big" data-v="yes">Löschen</button><button class="btn link" data-v="no">Abbrechen</button>`);
        if (ok !== 'yes') return;
        try { await api('/admin/codes/' + el.dataset.code, { method: 'DELETE' }); } catch (err) { toast(err.message); }
        return loadAdmin();
      }
    }
  });

  // Sicherheitsnetz: Fortschritt sichern, wenn die App in den Hintergrund geht
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.progress && P.playing) {
      state.progress.last = P.idx;
      state.progress.pos = P.idx;
      state.progress.lastAt = new Date().toISOString();
      saveProgress();
    }
    if (!document.hidden) applyTheme();
  });
  setInterval(applyTheme, 60000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
})();
