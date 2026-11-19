// Monitor de boletos Tickettap (solo lectura). Uso: node monitor.js ["<token>"]
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  try { ({ chromium } = require(path.join(process.env.PW_PATH || '', 'playwright'))); }
  catch { console.error('No encuentro playwright. Ejecuta: npm i playwright && npx playwright install chromium'); process.exit(1); }
}

const { Jar, SessionExpired, scanEventHttp } = require('./http-scanner');
const db = require('./db');

// ---------- Configuración ----------
const BASE = 'https://tickettap.com.mx/';
const HOME_PATH = 'ttDefault';
const EVENT_PATH = 'htViewEvent0002';
const SEL = { zone: '#ddlSec', qty: '#ddlQuantity', avail: '#txtAvailable', price: '#txtPriceShow', name: '#lblEventName', date: '#lblDateEvent', row: '#lblRow' };

// Flags: node monitor.js --agents=6 --interval=5 --mode=http|browser --port=3000 [token]
const FLAGS = {}; const POSITIONAL = [];
process.argv.slice(2).forEach((a, i, all) => {
  const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
  if (!m) { if (!/^--/.test(all[i - 1] || '') || /=/.test(all[i - 1])) POSITIONAL.push(a); return; }
  FLAGS[m[1]] = m[2] !== undefined ? m[2] : (all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true');
});
// MODE=http (default): llamadas directas desde Node. MODE=browser: lee con pestañas de Playwright.
const MODE = (FLAGS.mode || process.env.MODE || 'http').toLowerCase();
const INTERVAL_MIN = Number(FLAGS.interval || process.env.INTERVAL_MIN || 5);
const PORT = Number(FLAGS.port || process.env.PORT || 3000);
const CONCURRENCY = Math.min(Math.max(Number(FLAGS.agents || process.env.CONCURRENCY || 6) || 6, 1), 12);
// Headless por defecto en Linux sin pantalla (Raspberry/SSH). Forzar: --headless=true|false
const HEADLESS = String(FLAGS.headless ?? process.env.HEADLESS ?? (process.platform === 'linux' && !process.env.DISPLAY)) === 'true';
const TOKEN_RETRY_SEC = Number(FLAGS['token-retry'] || process.env.TOKEN_RETRY_SEC || 60);
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT;

const DIR = __dirname;
const PROFILE = path.join(DIR, 'profile');
const TOKEN_FILE = path.join(DIR, '.token');
const HISTORY = path.join(DIR, 'history.jsonl');
const EVENTS_FILE = path.join(DIR, 'events.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const beep = () => process.stdout.write('\x07');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

let token = POSITIONAL[0] || process.env.TT_VALUE || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '');
let artists = {};   // nombre -> URL completa del evento
let state = {};     // "artista|zona" -> { artist, zone, available, price, status, ts }
let lastCycle = null;
let jar = null;
let cycleId = null;
let cycleErrors = 0;
const ARTISTS_FILE = path.join(DIR, 'artists.json');
const EXPECTED_ARTISTS = Number(process.env.EXPECTED_ARTISTS || 22); // verificado en la grabación del 2026-11-17
const meta = { total: 0, done: 0, running: false, workers: 0, perWorker: 0, intervalMin: INTERVAL_MIN,
  lastCycleAt: null, lastDurationMs: null, nextAt: null };


// ---------- Token ----------
async function extractToken(page) {
  return page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href*="value="]')) {
      const m = a.href.match(/[?&]value=([^&#]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return '';
  }).catch(() => '');
}

// Sin teclado (Raspberry por SSH): intenta ~45 s por pasada y, si no hay token, devuelve ''.
// El bucle principal reintenta cada TOKEN_RETRY_SEC. Con TTY se sigue permitiendo ENTER manual.
async function acquireToken(page) {
  console.log('Buscando token de sesión...');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const interactive = !HEADLESS && process.stdin.isTTY;
  let manual = false;
  const rl = interactive ? readline.createInterface({ input: process.stdin }) : null;
  if (rl) rl.once('line', () => { manual = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && !manual) {
    const t = await extractToken(page);
    if (t) { if (rl) rl.close(); return t; }
    await sleep(2000);
  }
  if (rl) rl.close();
  return extractToken(page);
}

async function ensureToken(page, force = false) {
  if (token && !force) return true;
  const t = await acquireToken(page);
  if (!t) { console.log(`Sin token; reintento en ${TOKEN_RETRY_SEC}s`); return false; }
  token = t;
  fs.writeFileSync(TOKEN_FILE, token);
  console.log('Token guardado en .token');
  return true;
}

// ---------- Artistas ----------
// La página principal trae un enlace por artista (con value= e idEvent= ya incluidos).
async function discoverArtists(page) {
  const home = token ? `${BASE}${HOME_PATH}?value=${encodeURIComponent(token)}` : BASE;
  await page.goto(home, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const found = await page.evaluate(() => {
    const out = {};
    for (const a of document.querySelectorAll('a[href*="idEvent="]')) {
      const name = (a.innerText || a.title || '').trim().replace(/\s+/g, ' ');
      if (name) out[name] = a.href;
    }
    return out;
  }).catch(() => ({}));
  if (Object.keys(found).length) {
    artists = found;
    const names = Object.keys(artists);
    for (const k of Object.keys(state)) if (!artists[state[k].artist]) delete state[k];
    fs.writeFileSync(ARTISTS_FILE, JSON.stringify({ count: names.length, names, savedAt: new Date().toISOString() }, null, 2));
    console.log(`Artistas: ${names.length}` + (names.length !== EXPECTED_ARTISTS ? ` (¡esperaba ${EXPECTED_ARTISTS}!)` : ' (coincide con lo esperado)'));
    return true;
  }
  // respaldo: events.json { "NOMBRE": "idEvent" }
  const fallback = readJson(EVENTS_FILE, {});
  artists = Object.fromEntries(Object.entries(fallback).filter(([, id]) => !id.startsWith('idEvent-del-sitio'))
    .map(([n, id]) => [n, `${BASE}${EVENT_PATH}?value=${encodeURIComponent(token)}&idEvent=${encodeURIComponent(id)}`]));
  console.log(`Artistas: ${Object.keys(artists).length} (respaldo events.json)`);
  return false;
}

// ---------- Lectura de un evento ----------
// Mensaje corto para el dashboard: sin URLs (traen el token) ni stack de Playwright.
function shortErr(e) {
  const m = String((e && e.message) || e || 'ERROR').split('\n')[0];
  if (/timeout/i.test(m)) return 'Tiempo de espera agotado: el sitio no respondió';
  if (/net::|ERR_/i.test(m)) return 'Error de red al abrir la página';
  return m.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Error';
}

// El sitio es ASP.NET WebForms: cada cambio de select hace un POST y recarga la página.
async function setSelect(page, selector, value) {
  const current = await page.$eval(selector, el => el.value);
  if (current === value) return;
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }),
    page.selectOption(selector, value),
  ]);
}

const readVal = (page, sel) => page.$eval(sel, el => (el.value ?? el.textContent ?? '').trim()).catch(() => '');
const readText = (page, sel) => page.$eval(sel, el => el.textContent.trim()).catch(() => '');

async function scanEvent(page, artist, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp ? resp.status() : 'sin respuesta'}`);
  if (!(await page.$(SEL.zone))) {
    const body = await page.innerText('body').catch(() => '');
    if (/procesando informaci[oó]n|sesi[oó]n|expir/i.test(body)) throw new SessionExpired();
    throw new Error('sin formulario');
  }

  // Con cantidad 0 el sitio muestra 0 boletos y $0.00: hay que elegir 1 para ver la disponibilidad.
  await setSelect(page, SEL.qty, '1');

  const date = await readText(page, SEL.date);
  const zones = await page.$$eval(`${SEL.zone} option`, os => os.map(o => ({ value: o.value, label: o.textContent.trim() })));
  const rows = [];
  for (const z of zones) {
    await setSelect(page, SEL.zone, z.value);
    const n = parseInt((await readVal(page, SEL.avail)).replace(/\D/g, ''), 10);
    const price = await readVal(page, SEL.price);
    const fila = (await readText(page, SEL.row)).replace(/^Fila actual de venta:\s*/i, '');
    rows.push({ artist, date, zone: z.label, available: Number.isNaN(n) ? null : n, price, fila, status: Number.isNaN(n) ? 'sin dato' : 'ok' });
  }
  return rows;
}

// ---------- Cambios, historial, Telegram ----------
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

// ---------- Sesión HTTP ----------
// El navegador sigue siendo quien obtiene el token y las cookies; Node las reutiliza para las llamadas directas.
async function buildJar(context, page) {
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
  jar = new Jar(await context.cookies(BASE), ua);
}

// ---------- Ciclo ----------
async function runCycle(context, retry = false) {
  const queue = Object.entries(artists);
  let expired = false;
  if (!retry) {
    meta.total = queue.length; meta.done = 0; meta.running = true; meta.nextAt = null;
    meta.workers = Math.min(CONCURRENCY, queue.length) || 1;
    meta.perWorker = Math.ceil(queue.length / meta.workers);
    meta.cycleStart = Date.now();
    cycleErrors = 0;
    cycleId = db.startCycle(meta.workers, MODE, queue.length);
    console.log(`Ciclo [${MODE}]: ${queue.length} artistas -> ${meta.workers} agentes (~${meta.perWorker} c/u)`);
  } else meta.done = 0;
  const homeUrl = `${BASE}${HOME_PATH}?value=${encodeURIComponent(token)}`;

  async function worker() {
    const page = MODE === 'browser' ? await context.newPage() : null;
    const scan = MODE === 'browser'
      ? (artist, url) => scanEvent(page, artist, url)
      : (artist, url) => scanEventHttp(jar, artist, url, { homeUrl });
    try {
      while (queue.length && !expired) {
        const [artist, url] = queue.shift();
        try {
          let rows;
          try { rows = await scan(artist, url); }
          catch (e) { if (e instanceof SessionExpired) throw e; rows = await scan(artist, url); } // 1 reintento
          rows.forEach(record);
        }
        catch (e) {
          if (e instanceof SessionExpired) { expired = true; queue.unshift([artist, url]); break; }
          record({ artist, zone: '-', available: null, price: '', status: 'error', detail: shortErr(e) });
        }
        meta.done++;
      }
    } finally { if (page) await page.close().catch(() => {}); }
  }
  await Promise.all(Array.from({ length: meta.workers }, worker));

  if (expired) {
    console.log('Sesión expirada: renovando token...');
    const p = await context.newPage();
    if (!(await ensureToken(p, true))) { await p.close(); meta.running = false; throw new Error('Sesión expirada y sin token nuevo'); }
    await discoverArtists(p);
    await buildJar(context, p);
    await p.close();
    return runCycle(context, true);
  }
  lastCycle = new Date();
  meta.running = false; meta.lastCycleAt = lastCycle.toISOString();
  meta.lastDurationMs = Date.now() - meta.cycleStart;
  db.endCycle(cycleId, meta.lastDurationMs, cycleErrors);
  printTable();
}

function printTable() {
  console.log(`\n=== ${lastCycle.toLocaleTimeString()} ===`);
  console.table(Object.values(state).map(r => ({ Artista: r.artist, Zona: r.zone, Boletos: r.available ?? r.status, Precio: r.price })));
}

// ---------- Dashboard ----------
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

http.createServer((req, res) => {
  if (req.url.startsWith('/api')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(apiData()));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(DIR, 'dashboard.html')));
}).listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));

// ---------- Main ----------
(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, { headless: HEADLESS, args: HEADLESS ? ['--no-sandbox'] : [] });
  const page = context.pages()[0] || await context.newPage();
  console.log(`Modo ${MODE}, ${HEADLESS ? 'headless' : 'con ventana'}`);

  for (;;) {
    let wait = Math.max(INTERVAL_MIN * 60000, 30000);
    try {
      if (!(await ensureToken(page))) { wait = TOKEN_RETRY_SEC * 1000; }
      else {
        if (!(await discoverArtists(page)) && !Object.keys(artists).length) {
          console.log('Sin artistas: renovando token...');
          if (await ensureToken(page, true)) await discoverArtists(page);
        }
        if (Object.keys(artists).length) { await buildJar(context, page); await runCycle(context); }
        else wait = TOKEN_RETRY_SEC * 1000;
      }
    } catch (e) { console.log('Error en ciclo:', e.message); wait = Math.min(wait, TOKEN_RETRY_SEC * 1000); }
    meta.nextAt = new Date(Date.now() + wait).toISOString();
    await sleep(wait);
  }
})();
