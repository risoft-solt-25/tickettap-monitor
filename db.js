// Persistencia en SQLite (módulo nativo node:sqlite, sin dependencias). Archivo: tickettap.db
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'tickettap.db'));
db.exec(`
  PRAGMA journal_mode = WAL;      -- permite consultar mientras el monitor escribe
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS cycles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    duration_ms INTEGER,
    agents      INTEGER,
    mode        TEXT,
    artists     INTEGER,
    errors      INTEGER
  );

  -- Una fila por artista y zona en cada ciclo (serie de tiempo completa).
  CREATE TABLE IF NOT EXISTS readings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id   INTEGER REFERENCES cycles(id),
    ts         TEXT NOT NULL,            -- ISO UTC
    artist     TEXT NOT NULL,
    event_date TEXT,                     -- fecha del show tal como la muestra el sitio
    zone       TEXT NOT NULL,            -- GENERAL, PLATA, DORADA, VIP ('-' si el evento falló)
    available  INTEGER,                  -- NULL si no hubo dato
    price      REAL,
    price_text TEXT,
    fila       TEXT,                     -- fila actual de venta
    status     TEXT NOT NULL,            -- ok | sin dato | error
    detail     TEXT                      -- motivo corto si hubo error
  );
  CREATE INDEX IF NOT EXISTS idx_readings_artist_ts ON readings(artist, zone, ts);
  CREATE INDEX IF NOT EXISTS idx_readings_cycle ON readings(cycle_id);

  -- Última lectura buena de cada artista/zona.
  CREATE VIEW IF NOT EXISTS latest AS
    SELECT r.* FROM readings r
    JOIN (SELECT artist, zone, MAX(id) AS id FROM readings WHERE status = 'ok' GROUP BY artist, zone) m ON m.id = r.id;
`);

const q = {
  startCycle: db.prepare('INSERT INTO cycles (started_at, agents, mode, artists) VALUES (?, ?, ?, ?)'),
  endCycle: db.prepare('UPDATE cycles SET ended_at = ?, duration_ms = ?, errors = ? WHERE id = ?'),
  addReading: db.prepare(`INSERT INTO readings
    (cycle_id, ts, artist, event_date, zone, available, price, price_text, fila, status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
};

const parsePrice = t => { const n = parseFloat(String(t || '').replace(/[^\d.]/g, '')); return Number.isNaN(n) ? null : n; };

// Nunca debe tumbar el monitor: si falla la BD se avisa y se sigue.
const safe = fn => (...a) => { try { return fn(...a); } catch (e) { console.log('SQLite:', e.message); return null; } };

// ---------- Consultas de solo lectura (para la API REST) ----------
const readingOut = r => ({ id: r.id, cycleId: r.cycle_id, ts: r.ts, artist: r.artist, eventDate: r.event_date, zone: r.zone,
  available: r.available, price: r.price, priceText: r.price_text, fila: r.fila, status: r.status, detail: r.detail });
const cycleOut = c => ({ id: c.id, startedAt: c.started_at, endedAt: c.ended_at, durationMs: c.duration_ms,
  agents: c.agents, mode: c.mode, artists: c.artists, errors: c.errors });

function readings({ artist, zone, status, from, to, cycleId, limit = 100, offset = 0 } = {}) {
  const w = [], p = [];
  if (artist) { w.push('artist = ? COLLATE NOCASE'); p.push(artist); }
  if (zone) { w.push('zone = ? COLLATE NOCASE'); p.push(zone); }
  if (status) { w.push('status = ?'); p.push(status); }
  if (from) { w.push('ts >= ?'); p.push(from); }
  if (to) { w.push('ts <= ?'); p.push(to); }
  if (cycleId) { w.push('cycle_id = ?'); p.push(cycleId); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM readings ${where}`).get(...p).n;
  const rows = db.prepare(`SELECT * FROM readings ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
  return { total, rows: rows.map(readingOut) };
}
const latest = artist => (artist
  ? db.prepare('SELECT * FROM latest WHERE artist = ? COLLATE NOCASE ORDER BY zone').all(artist)
  : db.prepare('SELECT * FROM latest ORDER BY artist, zone').all()).map(readingOut);
const cycles = ({ limit = 50, offset = 0 } = {}) => ({
  total: db.prepare('SELECT COUNT(*) AS n FROM cycles').get().n,
  rows: db.prepare('SELECT * FROM cycles ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset).map(cycleOut),
});
const cycle = id => { const c = db.prepare('SELECT * FROM cycles WHERE id = ?').get(id); return c ? cycleOut(c) : null; };

module.exports = {
  readings, latest, cycles, cycle,
  startCycle: safe((agents, mode, artists) => Number(q.startCycle.run(new Date().toISOString(), agents, mode, artists).lastInsertRowid)),
  endCycle: safe((id, durationMs, errors) => q.endCycle.run(new Date().toISOString(), durationMs, errors, id)),
  addReading: safe((cycleId, ts, r) => q.addReading.run(
    cycleId ?? null, ts, r.artist, r.date || null, r.zone, r.available ?? null, parsePrice(r.price), r.price || null,
    r.fila || null, r.status, r.detail || null)),
};
