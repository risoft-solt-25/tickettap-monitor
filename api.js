// API REST v1 (solo lectura) bajo /api/v1. JSON, paginada, con API key opcional.
//   API_KEY=secreto  -> exige  X-API-Key: secreto  o  Authorization: Bearer secreto  (excepto /health)
//   CORS_ORIGIN=*    -> valor de Access-Control-Allow-Origin
// Nunca expone el token de sesión ni URLs del sitio.
const crypto = require('crypto');

const BASE = '/api/v1';
const MAX_LIMIT = 1000;

function createApi({ db, getMeta, hasToken }) {
  const API_KEY = process.env.API_KEY || '';
  const CORS = process.env.CORS_ORIGIN || '*';

  const send = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': CORS, 'Access-Control-Allow-Headers': 'X-API-Key, Authorization',
    });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

  const authorized = req => {
    if (!API_KEY) return true;
    const given = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(String(given)), b = Buffer.from(API_KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const int = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isNaN(n) ? def : Math.min(Math.max(n, min), max); };
  const isoDate = v => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d.toISOString(); };
  const page = (q, defLimit) => ({ limit: int(q.get('limit'), defLimit, 1, MAX_LIMIT), offset: int(q.get('offset'), 0, 0, 1e9) });

  // Agrupa lecturas "latest" por artista.
  const groupArtists = rows => {
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.artist)) by.set(r.artist, { name: r.artist, eventDate: r.eventDate, total: 0, updatedAt: null, zones: [] });
      const a = by.get(r.artist);
      a.total += r.available || 0;
      if (!a.updatedAt || r.ts > a.updatedAt) a.updatedAt = r.ts;
      a.zones.push({ zone: r.zone, available: r.available, price: r.price, priceText: r.priceText, fila: r.fila, updatedAt: r.ts });
    }
    return [...by.values()];
  };

  return function handle(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': CORS, 'Access-Control-Allow-Headers': 'X-API-Key, Authorization', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed', 'Solo lectura: usa GET.');

    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.slice(BASE.length).split('/').filter(Boolean).map(decodeURIComponent);
    const q = u.searchParams;

    if (parts[0] === 'health' && parts.length === 1) return send(res, 200, { status: 'ok', time: new Date().toISOString() });
    if (!authorized(req)) return fail(res, 401, 'unauthorized', 'API key inválida o ausente.');

    try {
      // GET /api/v1
      if (parts.length === 0) return send(res, 200, { version: 'v1', endpoints: [
        'GET /health', 'GET /status', 'GET /artists', 'GET /artists/{name}', 'GET /artists/{name}/history?zone&from&to&limit&offset',
        'GET /readings?artist&zone&status&from&to&cycleId&limit&offset', 'GET /cycles?limit&offset', 'GET /cycles/{id}'] });

      // GET /api/v1/status
      if (parts[0] === 'status' && parts.length === 1) return send(res, 200, { data: { ...getMeta(), tokenLoaded: hasToken() } });

      if (parts[0] === 'artists') {
        // GET /api/v1/artists
        if (parts.length === 1) {
          const data = groupArtists(db.latest());
          return send(res, 200, { data, meta: { count: data.length } });
        }
        const name = parts[1];
        // GET /api/v1/artists/{name}
        if (parts.length === 2) {
          const a = groupArtists(db.latest(name))[0];
          return a ? send(res, 200, { data: a }) : fail(res, 404, 'not_found', `Artista "${name}" sin lecturas.`);
        }
        // GET /api/v1/artists/{name}/history
        if (parts.length === 3 && parts[2] === 'history') {
          const from = isoDate(q.get('from')), to = isoDate(q.get('to'));
          if (from === undefined || to === undefined) return fail(res, 400, 'bad_request', 'from/to deben ser fechas ISO 8601.');
          const { limit, offset } = page(q, 200);
          const r = db.readings({ artist: name, zone: q.get('zone'), status: q.get('status'), from, to, limit, offset });
          return send(res, 200, { data: r.rows, meta: { total: r.total, limit, offset } });
        }
      }

      // GET /api/v1/readings
      if (parts[0] === 'readings' && parts.length === 1) {
        const from = isoDate(q.get('from')), to = isoDate(q.get('to'));
        if (from === undefined || to === undefined) return fail(res, 400, 'bad_request', 'from/to deben ser fechas ISO 8601.');
        const { limit, offset } = page(q, 100);
        const r = db.readings({ artist: q.get('artist'), zone: q.get('zone'), status: q.get('status'), from, to,
          cycleId: q.get('cycleId') ? int(q.get('cycleId'), 0, 0, 1e12) : undefined, limit, offset });
        return send(res, 200, { data: r.rows, meta: { total: r.total, limit, offset } });
      }

      if (parts[0] === 'cycles') {
        // GET /api/v1/cycles
        if (parts.length === 1) {
          const { limit, offset } = page(q, 50);
          const r = db.cycles({ limit, offset });
          return send(res, 200, { data: r.rows, meta: { total: r.total, limit, offset } });
        }
        // GET /api/v1/cycles/{id}
        if (parts.length === 2) {
          const c = db.cycle(int(parts[1], 0, 0, 1e12));
          return c ? send(res, 200, { data: c }) : fail(res, 404, 'not_found', 'Ciclo no encontrado.');
        }
      }

      return fail(res, 404, 'not_found', 'Ruta no encontrada. Ver GET /api/v1.');
    } catch (e) {
      console.log('API:', e.message);
      return fail(res, 500, 'internal_error', 'Error al consultar los datos.');
    }
  };
}

module.exports = { createApi };
