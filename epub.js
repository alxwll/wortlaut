// EPUB lesen, in Sätze zerlegen, Seiten schätzen, Wortsuche.
// Läuft im Browser (window.HBEpub) und zum Testen in Node (module.exports).
(function (root) {
  'use strict';

  const LANG_BY_CLASS = {
    polnisch: 'pl-PL', ukrainisch: 'uk-UA', russisch: 'ru-RU', franzoesisch: 'fr-FR',
    franzosisch: 'fr-FR', englisch: 'en-US', italienisch: 'it-IT', spanisch: 'es-ES',
    niederlaendisch: 'nl-NL', tschechisch: 'cs-CZ', portugiesisch: 'pt-PT', schwedisch: 'sv-SE',
  };
  const LANG_BY_CODE = {
    pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', fr: 'fr-FR', en: 'en-US', it: 'it-IT', es: 'es-ES',
    nl: 'nl-NL', cs: 'cs-CZ', pt: 'pt-PT', sv: 'sv-SE',
  };
  const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'figcaption', 'dt', 'dd', 'pre', 'div', 'section', 'article', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'aside', 'header', 'footer']);
  const SKIP = new Set(['script', 'style', 'head', 'title', 'nav', 'rt', 'rp']);
  const ABBR = new Set(['z', 'b', 'd', 'h', 'u', 'a', 'bzw', 'ca', 'dr', 'nr', 'st', 'usw', 'etc', 'hr', 'fr', 'vgl', 's', 'evtl', 'ggf', 'inkl', 'prof', 'str', 'sog', 'm', 'o', 'v', 'chr', 'jh', 'jhd', 'mio', 'mrd', 'bspw', 'zb', 'dh']);
  const CHARS_PER_PAGE_FALLBACK = 1800;

  function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
  function resolvePath(base, rel) {
    rel = decodeURIComponent(rel.split('#')[0]);
    const parts = (base + rel).split('/');
    const out = [];
    for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
    return out.join('/');
  }
  function localName(el) { return (el.localName || el.nodeName || '').toLowerCase().replace(/^.*:/, ''); }
  function clean(s) { return s.replace(/­/g, '').replace(/[​﻿]/g, ''); }

  function langOf(el, docLang) {
    for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
      const cls = (e.getAttribute && e.getAttribute('class')) || '';
      const m = cls.match(/Sprache_([A-Za-zäöü]+)/);
      if (m) return LANG_BY_CLASS[m[1].toLowerCase().replace('ä', 'ae').replace('ö', 'oe').replace('ü', 'ue')] || null;
      const l = (e.getAttribute && (e.getAttribute('xml:lang') || e.getAttribute('lang'))) || '';
      if (l) {
        const code = l.slice(0, 2).toLowerCase();
        if (code === 'de' || code === docLang) return null;
        return LANG_BY_CODE[code] || null;
      }
    }
    return null;
  }

  // Ein Block → { text, runs:[{s,e,lang}] }
  // Seitenmarke? (page-list-Ziel oder pagebreak-Element) → Seitenbezeichnung oder null
  function pageMark(el, targets) {
    const type = (el.getAttribute('epub:type') || el.getAttributeNS && el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '') + ' ' + (el.getAttribute('role') || '');
    const isBreak = /pagebreak/.test(type);
    const id = el.getAttribute('id');
    if (id && targets && targets.has(id)) return { label: targets.get(id), isBreak };
    if (isBreak) {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/^\D*?(?=[0-9ivxlcdm]+\s*$)/i, '').trim();
      return label ? { label, isBreak } : { label: null, isBreak };
    }
    return null;
  }

  function blockText(el, docLang, targets) {
    let text = '';
    const runs = [];
    const marks = [];
    (function walk(n) {
      if (n.nodeType === 3) {
        const t = clean(n.nodeValue);
        if (!t) return;
        const lang = langOf(n.parentNode, docLang);
        const s = text.length;
        text += t;
        const last = runs[runs.length - 1];
        if (last && last.lang === lang && last.e === s) last.e = text.length;
        else runs.push({ s, e: text.length, lang });
        return;
      }
      if (n.nodeType !== 1) return;
      const name = localName(n);
      if (SKIP.has(name)) return;
      const pm = pageMark(n, targets);
      if (pm) {
        if (pm.label) marks.push({ pos: text.length, label: pm.label });
        if (pm.isBreak) return; // Seitenzahl nicht vorlesen
      }
      if (name === 'br') { text += ' '; return; }
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    })(el);
    // Leerraum zusammenfassen, Läufe mitverschieben
    let out = '';
    const map = [];
    let prevSpace = true;
    for (let i = 0; i < text.length; i++) {
      const ch = /\s/.test(text[i]) ? ' ' : text[i];
      if (ch === ' ' && prevSpace) { map.push(out.length); continue; }
      map.push(out.length);
      out += ch;
      prevSpace = ch === ' ';
    }
    map.push(out.length);
    let trimmed = out.replace(/\s+$/, '');
    const newRuns = runs
      .map((r) => ({ s: map[r.s], e: Math.min(map[r.e], trimmed.length), lang: r.lang }))
      .filter((r) => r.e > r.s);
    const newMarks = marks.map((m) => ({ pos: Math.min(map[m.pos], trimmed.length), label: m.label }));
    return { text: trimmed, runs: newRuns, marks: newMarks };
  }

  // Alle Text-Blöcke eines Dokuments in Reihenfolge, mit Abschnittsmarken
  function collectBlocks(doc, docLang, targets) {
    const blocks = [];
    const body = doc.getElementsByTagName('body')[0] || doc.documentElement;
    (function walk(el) {
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const name = localName(c);
        if (SKIP.has(name)) continue;
        if (name === 'hr') { blocks.push({ brk: true }); continue; }
        const hasBlockChild = Array.prototype.some.call(c.childNodes, (k) => k.nodeType === 1 && BLOCK.has(localName(k)));
        if (BLOCK.has(name) && !hasBlockChild) {
          const cls = c.getAttribute('class') || '';
          const isHeading = /^h[1-6]$/.test(name);
          const b = blockText(c, docLang, targets);
          if (b.marks.length && !b.text) { b.marks.forEach((m) => blocks.push({ mark: m.label })); continue; }
          const onlySymbols = b.text && !/[\p{L}\p{N}]/u.test(b.text);
          if (/Zaesur|zaesur|scene-?break|section-?break/.test(cls) || onlySymbols) blocks.push({ brk: true });
          if (b.text && !onlySymbols) blocks.push({ ...b, heading: isHeading });
        } else if (name === 'img' || name === 'svg' || name === 'image') {
          continue;
        } else {
          const pm = pageMark(c, targets);
          if (pm && pm.label) blocks.push({ mark: pm.label });
          if (pm && pm.isBreak) continue;
          walk(c);
        }
      }
    })(body);
    return blocks;
  }

  function isAbbrev(text, dotIndex) {
    let j = dotIndex - 1;
    while (j >= 0 && /[A-Za-zÄÖÜäöüß]/.test(text[j])) j--;
    const word = text.slice(j + 1, dotIndex).toLowerCase();
    if (!word) {
      // Ordnungszahl wie „am 3. Mai“ (1–2 Ziffern) – keine Satzgrenze; Jahreszahl schon
      const d = text.slice(0, dotIndex).match(/(\d+)$/);
      return !!(d && d[1].length <= 2);
    }
    if (ABBR.has(word)) return true;
    if (word.length === 1) return true; // Initialen
    return false;
  }

  // Satzgrenzen in einem Text → Liste von [start, end]
  function splitSentences(text) {
    const out = [];
    const re = /[.!?…]+["“”»«'’)\]]*\s+(?=["„“”»«'’(\[–—-]*\s?[A-ZÄÖÜ0-9„“»«])/g;
    let start = 0;
    let m;
    while ((m = re.exec(text))) {
      const punctEnd = m.index + m[0].replace(/\s+$/, '').length;
      if (text[m.index] === '.' && isAbbrev(text, m.index)) continue;
      out.push([start, punctEnd]);
      start = m.index + m[0].length;
    }
    if (start < text.length) out.push([start, text.length]);
    // Sehr lange Sätze an Semikolon/Doppelpunkt teilen (fürs Vorlesen angenehmer)
    const res = [];
    for (const [s, e] of out) {
      if (e - s <= 700) { res.push([s, e]); continue; }
      let cur = s;
      const seg = text.slice(s, e);
      const r2 = /[;:]\s+/g;
      let mm;
      while ((mm = r2.exec(seg))) {
        const cut = s + mm.index + 1;
        if (cut - cur >= 200) { res.push([cur, cut]); cur = s + mm.index + mm[0].length; }
      }
      res.push([cur, e]);
    }
    return res.filter(([s, e]) => text.slice(s, e).trim());
  }

  function partsFor(text, runs, s, e) {
    const parts = [];
    for (const r of runs) {
      const a = Math.max(r.s, s), b = Math.min(r.e, e);
      if (b > a) parts.push([text.slice(a, b), r.lang]);
    }
    if (!parts.length) parts.push([text.slice(s, e), null]);
    // Rand-Leerzeichen am Satzanfang/-ende entfernen
    parts[0][0] = parts[0][0].replace(/^\s+/, '');
    parts[parts.length - 1][0] = parts[parts.length - 1][0].replace(/\s+$/, '');
    return parts.filter((p) => p[0]);
  }

  async function parseEpub(data, deps) {
    const JSZip = deps.JSZip;
    const DP = deps.DOMParser;
    const zip = await JSZip.loadAsync(data);
    const read = async (p) => {
      const f = zip.file(p);
      return f ? f.async('string') : null;
    };
    const xml = (s, type) => new DP().parseFromString(s, type || 'application/xml');

    const container = await read('META-INF/container.xml');
    if (!container) throw new Error('Keine gültige EPUB-Datei.');
    const rootEl = xml(container).getElementsByTagName('rootfile')[0];
    const opfPath = rootEl.getAttribute('full-path');
    const base = dirname(opfPath);
    const opf = xml(await read(opfPath));

    const meta = (tag) => {
      const els = opf.getElementsByTagNameNS ? opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', tag) : [];
      const el = els[0] || opf.getElementsByTagName('dc:' + tag)[0];
      return el ? el.textContent.trim() : '';
    };
    const title = meta('title') || 'Ohne Titel';
    const author = meta('creator');
    const docLang = (meta('language') || 'de').slice(0, 2).toLowerCase();

    const manifest = {};
    const items = opf.getElementsByTagName('item');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      manifest[it.getAttribute('id')] = {
        href: resolvePath(base, it.getAttribute('href')),
        type: it.getAttribute('media-type') || '',
        props: it.getAttribute('properties') || '',
      };
    }

    // Cover
    let coverHref = null;
    for (const id in manifest) if (/cover-image/.test(manifest[id].props)) coverHref = manifest[id].href;
    if (!coverHref) {
      const metas = opf.getElementsByTagName('meta');
      for (let i = 0; i < metas.length; i++) {
        if (metas[i].getAttribute('name') === 'cover') {
          const it = manifest[metas[i].getAttribute('content')];
          if (it && /^image\//.test(it.type)) coverHref = it.href;
        }
      }
    }
    if (!coverHref) {
      for (const id in manifest) {
        if (/^image\//.test(manifest[id].type) && /cover/i.test(id + manifest[id].href)) { coverHref = manifest[id].href; break; }
      }
    }
    let cover = null;
    if (coverHref && zip.file(coverHref)) {
      const bytes = await zip.file(coverHref).async('uint8array');
      const ext = coverHref.split('.').pop().toLowerCase();
      cover = { bytes, type: ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
    }

    // Navigation (nav oder ncx): Kapiteltitel, Druckseiten (page-list), Buchanfang (landmarks)
    const tocTitles = {};
    const pageTargets = {}; // Datei → Map(id → Seitenbezeichnung)
    const filePages = {}; // Datei ohne Sprungmarke → Seitenbezeichnung (Seite beginnt mit der Datei)
    let bodyMatter = null;
    const addTarget = (path, label) => {
      label = (label || '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      const [file, frag] = path.split('#');
      if (frag) {
        if (!pageTargets[file]) pageTargets[file] = new Map();
        if (!pageTargets[file].has(frag)) pageTargets[file].set(frag, label);
      } else if (!filePages[file]) filePages[file] = label;
    };
    const resolveKeepHash = (baseFile, href) => {
      const [f, frag] = href.split('#');
      return resolvePath(dirname(baseFile), f || baseFile.split('/').pop()) + (frag ? '#' + decodeURIComponent(frag) : '');
    };
    for (const id in manifest) {
      const it = manifest[id];
      try {
        if (/\bnav\b/.test(it.props)) {
          const nav = xml(await read(it.href), 'application/xhtml+xml');
          const navs = nav.getElementsByTagName('nav');
          for (let n = 0; n < navs.length; n++) {
            const type = navs[n].getAttribute('epub:type') || navs[n].getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '';
            const links = navs[n].getElementsByTagName('a');
            for (let i = 0; i < links.length; i++) {
              const h = links[i].getAttribute('href');
              if (!h) continue;
              const full = resolveKeepHash(it.href, h);
              if (/page-list/.test(type)) addTarget(full, links[i].textContent);
              else if (/landmarks/.test(type)) {
                const lt = links[i].getAttribute('epub:type') || links[i].getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '';
                if (/bodymatter/.test(lt) && !bodyMatter) bodyMatter = full.split('#')[0];
              } else {
                const p = full.split('#')[0];
                if (!tocTitles[p]) tocTitles[p] = links[i].textContent.replace(/\s+/g, ' ').trim();
              }
            }
          }
        } else if (it.type === 'application/x-dtbncx+xml') {
          const ncx = xml(await read(it.href));
          const pts = ncx.getElementsByTagName('navPoint');
          for (let i = 0; i < pts.length; i++) {
            const c = pts[i].getElementsByTagName('content')[0];
            const l = pts[i].getElementsByTagName('text')[0];
            if (!c || !l) continue;
            const p = resolvePath(dirname(it.href), c.getAttribute('src'));
            if (!tocTitles[p]) tocTitles[p] = l.textContent.replace(/\s+/g, ' ').trim();
          }
          const tgs = ncx.getElementsByTagName('pageTarget');
          for (let i = 0; i < tgs.length; i++) {
            const c = tgs[i].getElementsByTagName('content')[0];
            const l = tgs[i].getElementsByTagName('text')[0];
            if (c && l) addTarget(resolveKeepHash(it.href, c.getAttribute('src')), l.textContent);
          }
        }
      } catch (e) { /* Navigation ist optional */ }
    }
    // Auch pagebreak-Elemente ohne page-list zählen; Ziele werden beim Durchlaufen erkannt

    const sentences = [];
    const sections = [];
    const pageMarks = []; // [{ i: Satzindex, l: Seitenbezeichnung }]
    let offset = 0;
    const spine = opf.getElementsByTagName('itemref');
    for (let i = 0; i < spine.length; i++) {
      const it = manifest[spine[i].getAttribute('idref')];
      if (!it || !/x?html/.test(it.type)) continue;
      if (/\bnav\b/.test(it.props)) continue;
      const src = await read(it.href);
      if (!src) continue;
      let doc = xml(src, 'application/xhtml+xml');
      if (doc.getElementsByTagName('parsererror').length) doc = xml(src, 'text/html');
      const blocks = collectBlocks(doc, docLang, pageTargets[it.href] || new Map());
      const docTitle = tocTitles[it.href] || '';
      let pendingMark = filePages[it.href] || null;
      let part = 0;
      let needSection = true;
      for (const b of blocks) {
        if (b.mark) { pendingMark = b.mark; continue; }
        if (b.brk) { needSection = true; continue; }
        if (b.heading) needSection = true;
        if (needSection) {
          part++;
          const t = b.heading ? b.text.slice(0, 80) : '';
          sections.push({ title: t, doc: docTitle, part, start: sentences.length, file: it.href });
          needSection = false;
        }
        const sec = sections.length - 1;
        const first = sentences.length;
        const bounds = splitSentences(b.text);
        for (const [s, e] of bounds) {
          const parts = partsFor(b.text, b.runs, s, e);
          const len = parts.reduce((n, p) => n + p[0].length, 0);
          if (!len) continue;
          sentences.push({ p: parts, s: sec, o: offset, h: b.heading ? 1 : 0, _b: [s, e] });
          offset += len + 1;
        }
        if (pendingMark && sentences.length > first) { pageMarks.push({ i: first, l: pendingMark }); pendingMark = null; }
        // Seitenwechsel mitten im Absatz: dem Satz zuordnen, in dem er liegt (ab dem nächsten Satz zählt die neue Seite,
        // außer der Wechsel liegt ganz am Satzanfang)
        for (const m of b.marks || []) {
          let k = first;
          while (k < sentences.length - 1 && sentences[k]._b[1] <= m.pos) k++;
          const atStart = m.pos <= sentences[k]._b[0] + 1;
          const target = atStart || k === sentences.length - 1 ? k : k + 1;
          if (target < sentences.length) pageMarks.push({ i: target, l: m.label });
        }
        for (let k = first; k < sentences.length; k++) delete sentences[k]._b;
        if (sentences.length && sentences[sentences.length - 1].s === sec) sentences[sentences.length - 1].pe = 1; // Absatzende
      }
    }
    // leere Abschnitte entfernen, Titel vergeben
    const used = sections.filter((sec, i) => {
      const next = sections[i + 1];
      return (next ? next.start : sentences.length) > sec.start;
    });
    const remap = new Map(sections.map((s, i) => [i, used.indexOf(s)]));
    sentences.forEach((s) => { s.s = remap.get(s.s); });
    used.forEach((sec, i) => {
      const end = i + 1 < used.length ? used[i + 1].start : sentences.length;
      const last = sentences[end - 1];
      sec.chars = end > sec.start ? last.o + sentenceText(last).length - sentences[sec.start].o : 0;
      if (!sec.title) sec.title = sentenceText(sentences[sec.start]).slice(0, 60);
    });

    // Startpunkt: Buchanfang laut Verlag (landmarks), sonst erster Abschnitt nach der Titelei
    const FRONT = /cover|titel|title|impressum|copyright|inhalt|contents|\btoc\b|\bnav\b|das buch|zum buch|über (das buch|den autor|die autorin)|about|widmung|dedication|motto|epigraph|danksagung|informationen/i;
    const isFront = (s) => FRONT.test(s.doc || '') || FRONT.test(s.file.split('/').pop());
    // (Landmarks sind nicht immer zuverlässig – manche Verlage zeigen damit auf die Titelseite.)
    let startAt = 0;
    const fromLandmark = bodyMatter ? used.findIndex((s) => s.file === bodyMatter) : -1;
    const fileChars = {};
    used.forEach((s) => { fileChars[s.file] = (fileChars[s.file] || 0) + s.chars; });
    const first = used.find((s, i) => i >= Math.max(0, fromLandmark) && !isFront(s) && fileChars[s.file] >= 300)
      || used.find((s) => !isFront(s) && fileChars[s.file] >= 300);
    if (first) startAt = first.start;

    // Seitenmarken aufräumen (aufsteigend, je Satz nur eine)
    pageMarks.sort((a, b) => a.i - b.i);
    const marks = [];
    for (const m of pageMarks) {
      if (marks.length && marks[marks.length - 1].i === m.i) marks[marks.length - 1] = m;
      else marks.push(m);
    }

    return {
      title, author, cover, sections: used.map(({ file, ...r }) => r), sentences,
      totalChars: offset, startAt, pageMarks: marks.length >= 3 ? marks : null,
    };
  }

  function sentenceText(s) { return s ? s.p.map((p) => p[0]).join('') : ''; }

  // ---------- Seiten ----------
  function pageOf(book, idx) {
    const s = book.sentences[Math.max(0, Math.min(idx, book.sentences.length - 1))];
    if (!s) return 1;
    if (book.pageMarks) {
      const m = book.pageMarks;
      let lo = 0, hi = m.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (m[mid].i <= idx) lo = mid; else hi = mid - 1;
      }
      return m[lo].l;
    }
    if (book.printPages) {
      const startO = book.sentences[book.startAt || 0].o;
      const rel = Math.max(0, (s.o - startO) / Math.max(1, book.totalChars - startO));
      return Math.min(book.printPages, Math.floor(rel * (book.printPages - (book.firstPage || 1) + 1)) + (book.firstPage || 1));
    }
    return Math.floor(s.o / CHARS_PER_PAGE_FALLBACK) + 1;
  }
  function indexForPage(book, page) {
    if (book.pageMarks) {
      const want = String(page).trim().toLowerCase();
      const exact = book.pageMarks.find((m) => m.l.toLowerCase() === want);
      if (exact) return exact.i;
      const n = parseInt(want, 10);
      let best = book.pageMarks[0];
      for (const m of book.pageMarks) { const v = parseInt(m.l, 10); if (v <= n) best = m; }
      return best.i;
    }
    let target;
    if (book.printPages) {
      const startO = book.sentences[book.startAt || 0].o;
      const span = book.printPages - (book.firstPage || 1) + 1;
      const rel = (page - (book.firstPage || 1)) / Math.max(1, span);
      target = startO + Math.max(0, rel) * (book.totalChars - startO);
    } else {
      target = (page - 1) * CHARS_PER_PAGE_FALLBACK;
    }
    return indexForOffset(book, target);
  }
  function indexForOffset(book, o) {
    const a = book.sentences;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid].o <= o) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function percentOf(book, idx) {
    const s = book.sentences[idx];
    return s ? Math.round((s.o / Math.max(1, book.totalChars)) * 100) : 0;
  }

  // ---------- Suche ----------
  function norm(s) {
    return s
      .toLowerCase()
      .replace(/­/g, '')
      .replace(/ß/g, 'ss')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }
  function buildIndex(book) {
    let text = '';
    const starts = [];
    for (const s of book.sentences) {
      starts.push(text.length);
      text += norm(sentenceText(s)) + ' ';
    }
    return { text, starts };
  }
  function sentenceAt(index, pos) {
    const a = index.starts;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  // Sucht ab Satz fromIdx nach vorn, danach den Rest von vorn.
  function search(book, index, query, fromIdx, max) {
    const q = norm(query);
    if (q.length < 3) return [];
    const hits = [];
    const from = index.starts[Math.max(0, Math.min(fromIdx || 0, index.starts.length - 1))] || 0;
    const scan = (a, b, wrapped) => {
      let i = index.text.indexOf(q, a);
      while (i >= 0 && i < b && hits.length < (max || 8)) {
        const idx = sentenceAt(index, i);
        if (!hits.length || hits[hits.length - 1].idx !== idx) hits.push({ idx, wrapped });
        i = index.text.indexOf(q, i + 1);
      }
    };
    scan(from, index.text.length, false);
    scan(0, from, true);
    return hits;
  }

  const api = { parseEpub, splitSentences, sentenceText, pageOf, indexForPage, indexForOffset, percentOf, norm, buildIndex, search };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HBEpub = api;
})(typeof self !== 'undefined' ? self : this);
