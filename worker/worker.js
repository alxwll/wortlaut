// Wort. Laut. – Cloudflare Worker
// Aufgaben: Azure-Vorlesestimme ansprechen, Zugangscodes + Monatskontingente verwalten.
//
// Bindings (Cloudflare-Dashboard → Worker → Settings):
//   KV-Namespace:  CODES
//   Secrets:       AZURE_KEY, AZURE_REGION (z. B. "westeurope"), ADMIN_CODE
//
// Kontingente werden in Zeichen gezählt. 1 Stunde Hören ≈ 60.000 Zeichen.

const CHARS_PER_HOUR = 60000;
const DEFAULT_VOICE = 'de-DE-SeraphinaMultilingualNeural';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Code, X-Azure-Key, X-Azure-Region',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function month() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function randomCode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}

// Wer fragt an? → { code, name, admin, limitChars, paused } oder null
async function resolveUser(request, env) {
  const code = (request.headers.get('X-Code') || '').trim();
  if (!code) return null;
  if (env.ADMIN_CODE && code === env.ADMIN_CODE) {
    return { code, name: 'Admin', admin: true, limitChars: null, paused: false };
  }
  const raw = await env.CODES.get('code:' + code);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  return { code, name: rec.name, admin: false, limitChars: rec.limitChars, paused: !!rec.paused };
}

async function usedChars(env, code, m = month()) {
  const v = await env.CODES.get(`usage:${code}:${m}`);
  return v ? parseInt(v, 10) || 0 : 0;
}

async function addUsage(env, code, n) {
  const key = `usage:${code}:${month()}`;
  const cur = await usedChars(env, code);
  // nach ~400 Tagen automatisch löschen
  await env.CODES.put(key, String(cur + n), { expirationTtl: 60 * 60 * 24 * 400 });
}

// parts: [[text, lang|null], ...]
function buildSsml(parts, voice, rate) {
  const hd = /DragonHD/i.test(voice); // HD-Stimmen: kein <prosody>, Tempo regelt die App beim Abspielen
  const multilingual = hd || /Multilingual/i.test(voice);
  const pct = Math.round((Number(rate) || 1) * 100 - 100);
  const rateAttr = (pct >= 0 ? '+' : '') + pct + '%';
  // Aufbau: <voice> → je Abschnitt [<lang>] → <prosody>. So akzeptiert Azure auch Sprachwechsel.
  let body = '';
  let buf = '';
  let bufLang = null;
  const flush = () => {
    if (!buf) return;
    const inner = hd ? buf : `<prosody rate="${rateAttr}">${buf}</prosody>`;
    body += bufLang ? `<lang xml:lang="${bufLang}">${inner}</lang>` : inner;
    buf = '';
  };
  for (const [text, lang] of parts) {
    if (lang === '#p') { flush(); body += '<break time="450ms"/>'; continue; } // Absatzpause
    const l = lang && multilingual && /^[a-z]{2}-[A-Z]{2}$/.test(lang) ? lang : null;
    if (l !== bufLang) { flush(); bufLang = l; }
    buf += escapeXml(text);
  }
  flush();
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="de-DE">` +
    `<voice name="${escapeXml(voice)}">${body}</voice></speak>`
  );
}

async function handleTts(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Ungültige Anfrage.' }, 400);
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const clean = parts
    .filter((p) => Array.isArray(p) && typeof p[0] === 'string')
    .map((p) => [p[0].slice(0, 3000), typeof p[1] === 'string' ? p[1] : null]);
  const chars = clean.reduce((n, p) => n + (p[1] === '#p' ? 0 : p[0].length), 0);
  if (!chars) return json({ error: 'Kein Text.' }, 400);
  if (chars > 5000) return json({ error: 'Abschnitt zu lang.' }, 400);

  const voice = /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+(:DragonHD[A-Za-z0-9]*)?Neural$/.test(payload.voice || '') ? payload.voice : DEFAULT_VOICE;
  const rate = Math.min(2, Math.max(0.5, Number(payload.rate) || 1));

  // Eigener Schlüssel der Person? Dann direkt damit, ohne Kontingent.
  const ownKey = request.headers.get('X-Azure-Key');
  const ownRegion = request.headers.get('X-Azure-Region');
  let key, region, user = null;
  if (ownKey && ownRegion) {
    key = ownKey;
    region = ownRegion;
  } else {
    user = await resolveUser(request, env);
    if (!user) return json({ error: 'Zugangscode fehlt oder ist ungültig.' }, 401);
    if (user.paused) return json({ error: 'Dieser Zugang ist pausiert.' }, 403);
    if (user.limitChars != null) {
      const used = await usedChars(env, user.code);
      if (used + chars > user.limitChars) {
        return json({ error: 'Dein Kontingent für diesen Monat ist aufgebraucht.', code: 'quota' }, 429);
      }
    }
    key = env.AZURE_KEY;
    region = env.AZURE_REGION;
  }
  if (!/^[a-z0-9]+$/.test(region || '')) return json({ error: 'Region fehlt.' }, 500);

  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'wortlaut-app',
    },
    body: buildSsml(clean, voice, rate),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    let msg = `Azure-Fehler ${res.status}${detail ? ': ' + detail : ''}`;
    if (res.status === 401) msg = 'Azure-Schlüssel ungültig.';
    if (res.status === 429) msg = 'Das Azure-Kontingent für diesen Monat ist aufgebraucht – ab dem Monatsersten geht es weiter.';
    if (res.status === 400 && /DragonHD/.test(voice)) msg = 'Diese HD-Stimme ist in deinem Azure-Tarif oder deiner Region nicht verfügbar. ' + msg;
    return json({ error: msg, code: res.status === 429 ? 'quota' : undefined }, 502);
  }
  if (user) await addUsage(env, user.code, chars);
  return new Response(res.body, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function handleVoices(request, env) {
  const ownKey = request.headers.get('X-Azure-Key');
  const ownRegion = request.headers.get('X-Azure-Region');
  const region = ownKey ? ownRegion : env.AZURE_REGION;
  const key = ownKey || env.AZURE_KEY;
  if (!ownKey) {
    const user = await resolveUser(request, env);
    if (!user) return json({ error: 'Zugangscode fehlt oder ist ungültig.' }, 401);
    const cached = await env.CODES.get('cache:voices');
    if (cached) return json(JSON.parse(cached));
  }
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  if (!res.ok) return json({ error: `Azure-Fehler ${res.status}` }, 502);
  const all = await res.json();
  const voices = all
    .filter((v) => v.Locale === 'de-DE' || (v.SecondaryLocaleList || []).includes('de-DE'))
    .map((v) => {
      const hd = /DragonHD/.test(v.ShortName);
      return { id: v.ShortName, name: (v.DisplayName || v.LocalName) + (hd && !/HD/.test(v.DisplayName || '') ? ' HD' : ''), gender: v.Gender, multilingual: /Multilingual/.test(v.ShortName), hd };
    })
    .sort((a, b) => Number(b.hd) - Number(a.hd) || Number(b.multilingual) - Number(a.multilingual) || a.name.localeCompare(b.name));
  if (!ownKey) await env.CODES.put('cache:voices', JSON.stringify(voices), { expirationTtl: 86400 });
  return json(voices);
}

async function handleMe(request, env) {
  const user = await resolveUser(request, env);
  if (!user) return json({ error: 'Zugangscode ungültig.' }, 401);
  const used = await usedChars(env, user.code);
  return json({
    name: user.name,
    admin: user.admin,
    paused: user.paused,
    limitChars: user.limitChars,
    usedChars: used,
    charsPerHour: CHARS_PER_HOUR,
    month: month(),
  });
}

async function listCodes(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.CODES.list({ prefix: 'code:', cursor });
    for (const k of page.keys) {
      const raw = await env.CODES.get(k.name);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      const code = k.name.slice(5);
      out.push({ code, ...rec, usedChars: await usedChars(env, code) });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return out;
}

async function handleAdmin(request, env, path) {
  const user = await resolveUser(request, env);
  if (!user || !user.admin) return json({ error: 'Nur für Admin.' }, 403);

  if (path === '/admin/codes' && request.method === 'GET') {
    const codes = await listCodes(env);
    return json({ codes, adminUsedChars: await usedChars(env, user.code), charsPerHour: CHARS_PER_HOUR });
  }
  if (path === '/admin/codes' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 60);
    const hours = Number(body.hours);
    if (!name) return json({ error: 'Name fehlt.' }, 400);
    if (!(hours > 0 && hours <= 200)) return json({ error: 'Stunden zwischen 0,5 und 200.' }, 400);
    const code = randomCode();
    const rec = { name, limitChars: Math.round(hours * CHARS_PER_HOUR), paused: false, createdAt: new Date().toISOString() };
    await env.CODES.put('code:' + code, JSON.stringify(rec));
    return json({ code, ...rec, usedChars: 0 });
  }
  const m = path.match(/^\/admin\/codes\/([a-z0-9-]+)$/);
  if (m) {
    const key = 'code:' + m[1];
    const raw = await env.CODES.get(key);
    if (!raw) return json({ error: 'Zugang nicht gefunden.' }, 404);
    if (request.method === 'DELETE') {
      await env.CODES.delete(key);
      return json({ ok: true });
    }
    if (request.method === 'PATCH') {
      const rec = JSON.parse(raw);
      const body = await request.json().catch(() => ({}));
      if (body.hours != null) {
        const h = Number(body.hours);
        if (!(h > 0 && h <= 200)) return json({ error: 'Stunden zwischen 0,5 und 200.' }, 400);
        rec.limitChars = Math.round(h * CHARS_PER_HOUR);
      }
      if (body.paused != null) rec.paused = !!body.paused;
      if (body.name) rec.name = String(body.name).trim().slice(0, 60);
      await env.CODES.put(key, JSON.stringify(rec));
      return json({ code: m[1], ...rec, usedChars: await usedChars(env, m[1]) });
    }
  }
  return json({ error: 'Nicht gefunden.' }, 404);
}

// Artikel holen: Browser dürfen fremde Seiten nicht direkt laden, der Worker schon.
// Nur mit gültigem Zugang (oder eigenem Schlüssel), damit niemand den Worker als offenen Proxy nutzt.
async function handleFetch(request, env) {
  const user = await resolveUser(request, env);
  if (!user && !request.headers.get('X-Azure-Key')) return json({ error: 'Kein gültiger Zugang – trag in den Einstellungen deinen Code ein.' }, 401);
  if (user && user.paused) return json({ error: 'Dein Zugang ist gerade pausiert.' }, 403);
  const target = new URL(request.url).searchParams.get('url') || '';
  let u;
  try { u = new URL(target); } catch (e) { return json({ error: 'Das ist kein gültiger Link.' }, 400); }
  if (!/^https?:$/.test(u.protocol)) return json({ error: 'Nur http- und https-Links gehen.' }, 400);
  let res;
  try {
    res = await fetch(u.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return json({ error: 'Die Seite war nicht erreichbar.' }, 502);
  }
  if (!res.ok) return json({ error: `Die Seite hat nicht geantwortet (Fehler ${res.status}).` }, 502);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('pdf')) return json({ error: 'Das ist ein PDF – lade es bitte als Datei hoch.', code: 'pdf' }, 415);
  if (!/html|xml|text\/plain/.test(type)) return json({ error: 'Unter diesem Link liegt kein lesbarer Text.' }, 415);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 5e6) return json({ error: 'Die Seite ist zu groß.' }, 413);
  let html = new TextDecoder('utf-8').decode(buf);
  const cs = ((type.match(/charset=([\w-]+)/) || [])[1] || (html.slice(0, 3000).match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8').toLowerCase();
  if (cs !== 'utf-8' && cs !== 'utf8') { try { html = new TextDecoder(cs).decode(buf); } catch (e) {} }
  return json({ url: res.url || u.toString(), type: type.includes('text/plain') ? 'text' : 'html', html });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/tts' && request.method === 'POST') return await handleTts(request, env);
      if (path === '/voices' && request.method === 'GET') return await handleVoices(request, env);
      if (path === '/me' && request.method === 'GET') return await handleMe(request, env);
      if (path === '/fetch' && request.method === 'GET') return await handleFetch(request, env);
      if (path.startsWith('/admin/')) return await handleAdmin(request, env, path);
      if (path === '/') return json({ ok: true, app: 'wortlaut' });
      return json({ error: 'Nicht gefunden.' }, 404);
    } catch (e) {
      return json({ error: 'Serverfehler: ' + (e && e.message ? e.message : e) }, 500);
    }
  },
};
