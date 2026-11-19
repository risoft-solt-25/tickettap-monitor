// Proxy mínimo hacia Tickettap, montado en /url. Pensado para un solo usuario (tú, por túnel SSH).
// Navegas por http://localhost:3000/url y, cuando pasa una URL/enlace con value=<token>, se avisa a onToken().
// Las cookies de Tickettap quedan en el servidor (jar propio) y también se entregan a onToken.
const { Jar } = require('./http-scanner');

const TOKEN_RE = /[?&;]value=([^&#"'\s<>\\]+)/i;
const PREFIX = '/url';

function createProxy({ base, onToken }) {
  const origin = new URL(base).origin;
  const host = new URL(base).host;
  const jar = new Jar();
  const toProxy = u => {
    try {
      const x = new URL(u, origin);
      return x.host === host ? PREFIX + x.pathname + x.search + x.hash : u;
    } catch { return u; }
  };

  function rewriteText(s) {
    return s
      .replace(new RegExp(`(?:https?:)?//${host.replace(/\./g, '\\.')}`, 'gi'), PREFIX)
      .replace(/\b(href|src|action)=(["'])\/(?!\/)/gi, `$1=$2${PREFIX}/`)
      .replace(/<meta[^>]+http-equiv=["']?refresh[^>]*>/gi, m => m.replace(/url=\/(?!\/)/i, `url=${PREFIX}/`));
  }

  return async function handle(req, res) {
    if (req.url === PREFIX) { res.writeHead(302, { Location: PREFIX + '/' }); return res.end(); }
    let upPath = req.url.slice(PREFIX.length) || '/';
    const target = upPath === '/' ? base : origin + upPath;

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const found = (target.match(TOKEN_RE) || [])[1];
    let token = found ? decodeURIComponent(found) : '';

    try {
      const headers = {
        'User-Agent': jar.ua, Cookie: jar.header(), Accept: req.headers.accept || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'es-MX,es;q=0.9', Referer: base, Origin: origin,
      };
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      const up = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      jar.update(up);

      const out = {};
      const loc = up.headers.get('location');
      if (loc) {
        out.Location = toProxy(new URL(loc, target).href);
        if (!token) { const m = loc.match(TOKEN_RE); if (m) token = decodeURIComponent(m[1]); }
      }
      const ct = up.headers.get('content-type') || 'application/octet-stream';
      out['Content-Type'] = ct;
      let payload = Buffer.from(await up.arrayBuffer());
      if (/text\/html|javascript|text\/css|json|xml/i.test(ct)) {
        const text = payload.toString('utf8');
        if (!token && /html/i.test(ct)) { const m = text.match(TOKEN_RE); if (m) token = decodeURIComponent(m[1]); }
        payload = Buffer.from(rewriteText(text), 'utf8');
      }
      res.writeHead(up.status, out);
      res.end(payload);

      if (token) onToken(token, [...jar.map].map(([name, value]) => ({ name, value })), target);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Proxy: ' + e.message);
    }
  };
}

module.exports = { createProxy, TOKEN_RE };
