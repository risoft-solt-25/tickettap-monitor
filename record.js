// Grabador para investigar el sitio. Uso: node record.js
// Navegas tú; guarda requests/responses/snapshots en recordings/session-<fecha>/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  try { ({ chromium } = require(path.join(process.env.PW_PATH || '', 'playwright'))); }
  catch { console.error('No encuentro playwright. Ejecuta: npm i playwright && npx playwright install chromium'); process.exit(1); }
}

const BASE = 'https://tickettap.com.mx/';
const SKIP_URL = /login|signin|pago|payment|checkout|card/i;
const SENSITIVE = /pass|pwd|token|card|tarjeta|cvv|cvc|expir|email|correo|value/i;

const dir = path.join(__dirname, 'recordings', 'session-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const log = path.join(dir, 'traffic.jsonl');
let n = 0;

// El token de sesión viaja en el parámetro "value". Se guarda una huella (hash corto) en vez de [REDACTED]
// para poder seguir el mismo token entre requests sin almacenarlo en claro.
const TOKEN_PARAM = /^(value|token)$/i;
const fp = v => 'tok:' + crypto.createHash('sha1').update(decodeURIComponent(v)).digest('hex').slice(0, 8);
const redactStr = s => (s || '').replace(/([?&;])([^=&;]*)=([^&;]*)/g, (m, sep, k, v) =>
  `${sep}${k}=${TOKEN_PARAM.test(k) ? (v ? `[${safeFp(v)}]` : v) : SENSITIVE.test(k) ? '[REDACTED]' : v}`);
function safeFp(v) { try { return fp(v); } catch { return 'tok:?'; } }
const append = o => fs.appendFileSync(log, JSON.stringify(o) + '\n');

// ---- Rastro de cómo se obtiene el token ----
const traceLog = path.join(dir, 'token-trace.jsonl');
const seen = new Set();
const trace = o => { fs.appendFileSync(traceLog, JSON.stringify({ t: Date.now(), ...o }) + '\n'); console.log('[token]', o.event, o.fp, o.where || ''); };
// Busca tokens (value=...) en un texto; la primera vez que ve uno lo registra con su origen.
function scanForToken(text, source) {
  for (const m of (text || '').matchAll(/[?&;](?:value|token)=([^&;"'\s<>#]+)/gi)) {
    const f = safeFp(m[1]);
    if (!seen.has(f)) { seen.add(f); trace({ event: 'first-seen', fp: f, where: source.where, url: redactStr(source.url), status: source.status, via: source.via }); }
  }
}

(async () => {
  // Por SSH: HEADLESS=true node record.js [segundos]  -> carga la home, graba ese tiempo (60 por defecto) y termina.
  const HEADLESS = process.env.HEADLESS === 'true';
  const context = await chromium.launchPersistentContext(path.join(__dirname, 'profile'), { headless: HEADLESS, args: HEADLESS ? ['--no-sandbox'] : [] });
  const page = context.pages()[0] || await context.newPage();

  page.on('request', r => {
    // El token se rastrea aunque la URL sea de login/pago (solo se guarda la huella, no el contenido).
    const prev = r.redirectedFrom();
    scanForToken(r.url(), { where: 'request-url', url: r.url(), via: prev ? `redirect desde ${redactStr(prev.url())}` : `${r.method()} ${r.resourceType()}` });
    if (SKIP_URL.test(r.url())) return;
    append({ t: Date.now(), type: 'request', method: r.method(), url: redactStr(r.url()), body: redactStr(r.postData()),
      redirectedFrom: prev ? redactStr(prev.url()) : undefined });
  });
  page.on('response', async r => {
    const h = r.headers();
    // Redirecciones (Location) y cookies: nombre/huella solamente, sin valores.
    if (h.location) scanForToken(h.location, { where: 'header-location', url: r.url(), status: r.status() });
    if (h['set-cookie']) {
      const names = h['set-cookie'].split('\n').map(c => c.split('=')[0].trim());
      trace({ event: 'set-cookie', fp: '-', where: names.join(','), url: redactStr(r.url()), status: r.status() });
    }
    const ct = h['content-type'] || '';
    let raw = '';
    if (/json|text|html|xml|javascript/.test(ct)) raw = await r.text().catch(() => '');
    if (raw) scanForToken(raw, { where: 'response-body', url: r.url(), status: r.status() });
    if (SKIP_URL.test(r.url())) return;
    append({ t: Date.now(), type: 'response', status: r.status(), url: redactStr(r.url()),
      location: h.location ? redactStr(h.location) : undefined, body: redactStr(raw).slice(0, 20000) });
  });
  page.on('framenavigated', async f => {
    if (f !== page.mainFrame() || SKIP_URL.test(f.url())) return;
    await page.waitForTimeout(1500);
    const html = redactStr(await page.content().catch(() => ''));
    fs.writeFileSync(path.join(dir, `snapshot-${String(++n).padStart(3, '0')}.html`), html);
    console.log('Snapshot', n, redactStr(f.url()));
  });

  await page.goto(BASE).catch(() => {});
  console.log(`Grabando en ${dir}\nNavega; cierra la ventana para terminar. No captures datos de tarjeta.`);
  if (HEADLESS) { await page.waitForTimeout((Number(process.argv[2]) || 60) * 1000); await context.close(); return; }
  await new Promise(r => context.on('close', r));
})();
