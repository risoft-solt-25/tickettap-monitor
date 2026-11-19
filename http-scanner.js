// Lector HTTP directo (sin navegador) para las páginas de evento de Tickettap (ASP.NET WebForms).
// Flujo por artista: GET página -> POST ddlQuantity=1 -> POST ddlSec=<zona> por cada zona restante.
// Cada POST reenvía los campos ocultos (__VIEWSTATE, __EVENTVALIDATION...) de la respuesta anterior.

class SessionExpired extends Error {}

const decode = s => String(s ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseAttrs(tag) {
  const out = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  tag = tag.replace(/^<\w+/, '');
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function parseForm(html) {
  const fields = new Map();   // name -> value (lo que enviaría el navegador)
  const selects = {};         // name -> { value, options: [{value,label}] }
  const formTag = html.match(/<form\b[^>]*>/i);
  const action = formTag ? parseAttrs(formTag[0]).action || '' : '';

  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (!a.name || 'disabled' in a) continue;
    const t = (a.type || 'text').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(t)) continue;
    if ((t === 'checkbox' || t === 'radio') && !('checked' in a)) continue;
    fields.set(a.name, a.value ?? '');
  }
  for (const m of html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)) {
    const a = parseAttrs(m[0].match(/^<select\b[^>]*>/i)[0]);
    if (!a.name) continue;
    const options = [...m[0].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
      .map(o => ({ value: parseAttrs('<o ' + o[1])['value'] ?? decode(o[2]).trim(), label: decode(o[2]).replace(/<[^>]*>/g, '').trim(), selected: /\bselected\b/i.test(o[1]) }));
    const value = (options.find(o => o.selected) || options[0] || {}).value ?? '';
    selects[a.name] = { value, options, disabled: 'disabled' in a };
    if (!('disabled' in a)) fields.set(a.name, value);
  }
  const span = id => {
    const m = html.match(new RegExp(`<(?:span|label|div)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</(?:span|label|div)>`, 'i'));
    return m ? decode(m[1].replace(/<[^>]*>/g, '')).trim() : '';
  };
  return { action, fields, selects, span };
}

class Jar {
  constructor(cookies = [], ua = '') {
    this.map = new Map(cookies.map(c => [c.name, c.value]));
    this.ua = ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  update(res) {
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
}

async function request(jar, url, { method = 'GET', body, referer } = {}) {
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      method, body, redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: {
        'User-Agent': jar.ua, Cookie: jar.header(), Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-MX,es;q=0.9', ...(referer ? { Referer: referer } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(url).origin } : {}),
      },
    });
    jar.update(res);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).href;
      method = 'GET'; body = undefined;
      continue;
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return { html: await res.text(), url };
  }
  throw new Error('Demasiadas redirecciones');
}

async function postback(jar, page, target, overrides) {
  const params = new URLSearchParams();
  for (const [k, v] of page.form.fields) params.set(k, v);
  Object.entries(overrides).forEach(([k, v]) => params.set(k, v));
  params.set('__EVENTTARGET', target);
  params.set('__EVENTARGUMENT', '');
  const actionUrl = new URL(page.form.action || page.url, page.url).href;
  const r = await request(jar, actionUrl, { method: 'POST', body: params.toString(), referer: page.url });
  return { url: r.url, form: parseForm(r.html) };
}

const jitter = () => sleep(120 + Math.random() * 280);

async function scanEventHttp(jar, artist, url, { homeUrl } = {}) {
  const r = await request(jar, url, { referer: homeUrl });
  let page = { url: r.url, form: parseForm(r.html) };
  if (!page.form.selects.ddlSec) {
    if (/procesando informaci[oó]n|sesi[oó]n|expir/i.test(r.html)) throw new SessionExpired();
    throw new Error('sin formulario');
  }
  // Con cantidad 0 el sitio muestra 0 boletos y $0.00: hay que elegir 1.
  await jitter();
  page = await postback(jar, page, 'ddlQuantity', { ddlQuantity: '1' });

  const date = page.form.span('lblDateEvent');
  const zones = page.form.selects.ddlSec.options;
  const rows = [];
  for (const z of zones) {
    if (page.form.selects.ddlSec.value !== z.value) {
      await jitter();
      page = await postback(jar, page, 'ddlSec', { ddlSec: z.value });
    }
    const n = parseInt((page.form.fields.get('txtAvailable') || '').replace(/\D/g, ''), 10);
    rows.push({
      artist, date, zone: z.label, available: Number.isNaN(n) ? null : n,
      price: page.form.fields.get('txtPriceShow') || '',
      fila: page.form.span('lblRow').replace(/^Fila actual de venta:\s*/i, ''),
      status: Number.isNaN(n) ? 'sin dato' : 'ok',
    });
  }
  return rows;
}

// Lee la home con la sesión (jar) dada y extrae un enlace por artista (los que traen idEvent=).
async function discoverArtistsHttp(jar, homeUrl) {
  const r = await request(jar, homeUrl);
  const found = {};
  for (const m of r.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = parseAttrs('<a ' + m[1]);
    if (!a.href || !/idEvent=/i.test(a.href)) continue;
    const name = decode(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() || a.title || '';
    if (name) { try { found[name] = new URL(a.href, r.url).href; } catch {} }
  }
  const snippet = decode(r.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]*>/gi, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200);
  return { found, finalUrl: r.url, htmlLength: r.html.length, snippet };
}

module.exports = { Jar, SessionExpired, scanEventHttp, parseForm, discoverArtistsHttp };
