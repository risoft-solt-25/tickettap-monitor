// Monitor de boletos Tickettap (solo lectura). Sin navegador: el token y la sesión se obtienen
// navegando una vez por http://localhost:PORT/url (proxy a Tickettap). Uso:
//   node monitor.js --agents=4 --interval=5 --port=3000 --token-retry=60 ["<token>"]
// Variables: API_KEY, CORS_ORIGIN (API), TELEGRAM_TOKEN, TELEGRAM_CHAT, EXPECTED_ARTISTS, DB_FILE.
const fs = require('fs');
const path = require('path');
const http = require('http');

const { Jar, SessionExpired, scanEventHttp, discoverArtistsHttp } = require('./http-scanner');
const db = require('./db');
const { createProxy, TOKEN_RE } = require('./proxy');
const { createApi } = require('./api');

// ---------- Configuración ----------
const BASE = 'https://tickettap.com.mx/';
const HOME_PATH = 'ttDefault';

const FLAGS = {}; const POSITIONAL = [];
process.argv.slice(2).forEach((a, i, all) => {
  const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
  if (!m) { if (!/^--/.test(all[i - 1] || '') || /=/.test(all[i - 1])) POSITIONAL.push(a); return; }
  FLAGS[m[1]] = m[2] !== undefined ? m[2] : (all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true');
});
const INTERVAL_MIN = Number(FLAGS.interval || process.env.INTERVAL_MIN || 5);
const PORT = Number(FLAGS.port || process.env.PORT || 3000);
const CONCURRENCY = Math.min(Math.max(Number(FLAGS.agents || process.env.CONCURRENCY || 6) || 6, 1), 12);
const TOKEN_RETRY_SEC = Number(FLAGS['token-retry'] || process.env.TOKEN_RETRY_SEC || 60);
const EXPECTED_ARTISTS = Number(process.env.EXPECTED_ARTISTS || 22); // verificado en la grabación del 2026-11-17
const EMPTY_HOME_LIMIT = 3;   // lecturas seguidas de la home sin artistas antes de dar el token por vencido
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT;

const DIR = __dirname;
const SESSION_FILE = path.join(DIR, '.session.json');   // token + cookies + user-agent (secreto, fuera de git)
const HISTORY = path.join(DIR, 'history.jsonl');
const ARTISTS_FILE = path.join(DIR, 'artists.json');

const beep = () => process.stdout.write('\x07');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

let token = '';
let artists = {};   // nombre -> URL completa del evento
let state = {};     // "artista|zona" -> { artist, zone, available, price, status, ts }
let lastCycle = null;
let cycleId = null;
let cycleErrors = 0;
let emptyHome = 0;
let expiredNotified = false;
const meta = { total: 0, done: 0, running: false, workers: 0, perWorker: 0, intervalMin: INTERVAL_MIN,
  lastCycleAt: null, lastDurationMs: null, nextAt: null };

// ---------- Sesión (token + cookies) ----------
// El proxy /url guarda aquí la sesión con la que Tickettap emitió el token; el monitor la reutiliza tal cual.
let wake = () => {};
const proxy = createProxy({
  base: BASE,
  onToken: (t, target) => setToken(t, 'proxy ' + target.replace(/([?&]value=)[^&]+/i, '$1…')),
});
const jar = proxy.jar;

function saveSession() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ token, ua: jar.ua, cookies: [...jar.map], savedAt: new Date().toISOString() }));
  } catch (e) { console.log('No pude guardar la sesión:', e.message); }
}

function loadSession() {
  const s = readJson(SESSION_FILE, null);
  if (s) { token = s.token || ''; if (s.ua) jar.ua = s.ua; (s.cookies || []).forEach(([k, v]) => jar.map.set(k, v)); }
  const seed = POSITIONAL[0] || process.env.TT_VALUE;   // token pasado a mano (sin cookies)
  if (seed) token = seed;
}

function setToken(t, via) {
  if (!t || t === token) return;
  token = t; emptyHome = 0; expiredNotified = false;
  saveSession();
  console.log(`Token recibido (${via}); sesión guardada`);
  wake();
}

function expireToken(reason) {
  console.log(`Token inválido: ${reason}`);
  token = '';
  if (!expiredNotified) {
    expiredNotified = true;
    notify(`⚠️ Token expirado. Abre http://localhost:${PORT}/url (túnel SSH) y entra a la lista de artistas.`);
  }
}

// ---------- Artistas ----------
// La página principal trae un enlace por artista (con value= e idEvent= ya incluidos).
async function discoverArtists() {
  const home = `${BASE}${HOME_PATH}?value=${encodeURIComponent(token)}`;
  let found = {};
  try {
    const r = await discoverArtistsHttp(jar, home);
    found = r.found;
    if (!Object.keys(found).length) console.log(`Home sin artistas: ${r.finalUrl.replace(/([?&]value=)[^&]+/i, '$1…')} · ${r.htmlLength} bytes · "${r.snippet}"`);
  } catch (e) { console.log('No pude leer la home:', e.message); }

  const names = Object.keys(found);
  if (!names.length) {
    if (++emptyHome >= EMPTY_HOME_LIMIT) expireToken(`la home no trae artistas (${emptyHome} intentos seguidos)`);
    return false;
  }
  emptyHome = 0;
  artists = found;
  for (const k of Object.keys(state)) if (!artists[state[k].artist]) delete state[k];
  fs.writeFileSync(ARTISTS_FILE, JSON.stringify({ count: names.length, names, savedAt: new Date().toISOString() }, null, 2));
  console.log(`Artistas: ${names.length}` + (names.length !== EXPECTED_ARTISTS ? ` (¡esperaba ${EXPECTED_ARTISTS}!)` : ' (coincide con lo esperado)'));
  return true;
}

// ---------- Errores, historial, Telegram ----------
// Mensaje corto para el dashboard: sin URLs (traen el token).
function shortErr(e) {
  const m = String((e && e.message) || e || 'ERROR').split('\n')[0];
  if (/timeout|aborted/i.test(m)) return 'Tiempo de espera agotado: el sitio no respondió';
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(m)) return 'Error de red al abrir la página';
  return m.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Error';
}

async function notify(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
  } catch (e) { console.log('Telegram falló:', e.message); }
}

function record(row) {
  const key = `${row.artist}|${row.zone}`;
  const prev = state[key];
  if (row.zone !== '-') delete state[`${row.artist}|-`];
  const ts = new Date().toISOString();
  state[key] = { ...row, ts };
  db.addReading(cycleId, ts, row);
  if (row.status === 'error') cycleErrors++;
  if (!prev || prev.available !== row.available || prev.status !== row.status) {
    fs.appendFileSync(HISTORY, JSON.stringify({ ts, ...row }) + '\n');
    if ((prev?.available || 0) === 0 && row.available > 0) {
      beep();
      notify(`🎟️ ${row.artist} — ${row.zone}: ${row.available} boletos (${row.price})`);
    }
  }
}

// ---------- Ciclo ----------
async function runCycle() {
  const queue = Object.entries(artists);
  let expired = false;
  meta.total = queue.length; meta.done = 0; meta.running = true; meta.nextAt = null;
  meta.workers = Math.min(CONCURRENCY, queue.length) || 1;
  meta.perWorker = Math.ceil(queue.length / meta.workers);
  meta.cycleStart = Date.now();
  cycleErrors = 0;
  cycleId = db.startCycle(meta.workers, 'http', queue.length);
  console.log(`Ciclo: ${queue.length} artistas -> ${meta.workers} agentes (~${meta.perWorker} c/u)`);
  const homeUrl = `${BASE}${HOME_PATH}?value=${encodeURIComponent(token)}`;

  async function worker() {
    while (queue.length && !expired) {
      const [artist, url] = queue.shift();
      try {
        let rows;
        try { rows = await scanEventHttp(jar, artist, url, { homeUrl }); }
        catch (e) { if (e instanceof SessionExpired) throw e; rows = await scanEventHttp(jar, artist, url, { homeUrl }); } // 1 reintento
        rows.forEach(record);
      } catch (e) {
        if (e instanceof SessionExpired) { expired = true; break; }
        record({ artist, zone: '-', available: null, price: '', status: 'error', detail: shortErr(e) });
      }
      meta.done++;
    }
  }
  await Promise.all(Array.from({ length: meta.workers }, worker));

  meta.running = false;
  meta.lastDurationMs = Date.now() - meta.cycleStart;
  db.endCycle(cycleId, meta.lastDurationMs, cycleErrors);
  if (expired) return expireToken('el sitio indica sesión expirada');
  lastCycle = new Date();
  meta.lastCycleAt = lastCycle.toISOString();
  saveSession();   // las cookies pueden rotar durante el ciclo
  printTable();
}

function printTable() {
  console.log(`\n=== ${lastCycle.toLocaleTimeString()} ===`);
  console.table(Object.values(state).map(r => ({ Artista: r.artist, Zona: r.zone, Boletos: r.available ?? r.status, Precio: r.price })));
}

// ---------- Dashboard y API ----------
function apiData() {
  const list = Object.keys(artists).map(name => {
    const zones = Object.values(state).filter(r => r.artist === name && r.zone !== '-');
    const errs = Object.values(state).filter(r => r.artist === name && r.zone === '-');
    const all = zones.length ? zones : errs;
    const ts = all.map(r => r.ts).sort().pop() || null;
    return {
      name, date: all[0]?.date || '', updatedAt: ts,
      total: zones.reduce((s, z) => s + (z.available || 0), 0),
      zones: all.map(({ zone, available, price, fila, status, detail }) => ({ zone, available, price, fila, status, detail })),
    };
  });
  return { meta, artists: list };
}

const api = createApi({ db, getMeta: () => meta, hasToken: () => !!token });
const is = (u, p) => u === p || u.startsWith(p + '/') || u.startsWith(p + '?');

http.createServer((req, res) => {
  if (is(req.url, '/api/v1')) return api(req, res);
  if (is(req.url, '/url')) return proxy(req, res);
  if (is(req.url, '/token')) {   // plan B si el proxy falla: pegar a mano la URL con value=...
    const q = new URL(req.url, 'http://x').searchParams.get('url') || '';
    const m = q.match(TOKEN_RE);
    const t = m ? decodeURIComponent(m[1]) : q.trim();
    if (t) setToken(t, 'manual');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<form><input name="url" size="80" placeholder="Pega la URL con value=..."><button>Enviar</button></form>${t ? '<p>Token recibido.</p>' : ''}<p><a href="/url">Abrir Tickettap por el proxy</a></p>`);
  }
  if (is(req.url, '/api')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiData()));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(DIR, 'dashboard.html')));
}).listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}  ·  Token: http://localhost:${PORT}/url`));

// ---------- Main ----------
(async () => {
  loadSession();
  console.log(token ? 'Sesión anterior cargada.' : `Sin token: entra por http://localhost:${PORT}/url`);

  for (;;) {
    let wait = Math.max(INTERVAL_MIN * 60000, 30000);
    try {
      if (!token) wait = TOKEN_RETRY_SEC * 1000;
      else if (await discoverArtists() || Object.keys(artists).length) await runCycle();
      else wait = TOKEN_RETRY_SEC * 1000;
      if (!token) wait = TOKEN_RETRY_SEC * 1000;   // se invalidó durante el ciclo
    } catch (e) { console.log('Error en ciclo:', e.message); wait = Math.min(wait, TOKEN_RETRY_SEC * 1000); }
    meta.nextAt = new Date(Date.now() + wait).toISOString();
    await new Promise(r => { const t = setTimeout(r, wait); wake = () => { clearTimeout(t); r(); }; });
  }
})();
