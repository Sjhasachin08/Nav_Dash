const Database = require('better-sqlite3');
const { getDataPath } = require('../utils/dataDir');

const dbPath = getDataPath('fund-static-data.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS fund_static_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheme_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category TEXT,
    risk_measures TEXT NOT NULL DEFAULT '{}',
    market_capitalisation TEXT NOT NULL DEFAULT '{}',
    amfi_sectors TEXT NOT NULL DEFAULT '[]',
    exit_load TEXT NOT NULL DEFAULT '',
    launch_date TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_fund_static_data_scheme ON fund_static_data(scheme_name);
`);

// Migration for a database created before launch_date existed — CREATE
// TABLE IF NOT EXISTS above only applies to a brand-new file, so an
// existing fund-static-data.sqlite needs the column added explicitly.
// better-sqlite3 (SQLite) has no "ADD COLUMN IF NOT EXISTS", so check first.
const hasLaunchDateColumn = db.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('fund_static_data') WHERE name = 'launch_date'").get().c > 0;
if (!hasLaunchDateColumn) {
  db.exec(`ALTER TABLE fund_static_data ADD COLUMN launch_date TEXT NOT NULL DEFAULT ''`);
}

const parse = row => ({
  ...row,
  riskMeasures: JSON.parse(row.risk_measures || '{}'),
  marketCapitalisation: JSON.parse(row.market_capitalisation || '{}'),
  amfiSectors: JSON.parse(row.amfi_sectors || '[]'),
  exitLoad: row.exit_load || '',
  launchDate: row.launch_date || ''
});

function normalizeSchemeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const schemeSuffixes = new Set([
  'direct', 'regular', 'reg', 'plan', 'growth', 'idcw', 'dividend', 'payout',
  'reinvestment', 'reinvest', 'daily', 'weekly', 'monthly', 'quarterly',
  'annual', 'annually', 'yearly', 'option'
]);
let staticFamilyIndex = null;

function normalizeSchemeFamilyName(value) {
  const words = normalizeSchemeName(value).split(' ').filter(Boolean);
  while (words.length && schemeSuffixes.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function matchBestStaticRecord(schemeName) {
  const target = normalizeSchemeFamilyName(schemeName);
  if (!target) return null;

  if (!staticFamilyIndex) {
    staticFamilyIndex = new Map();
    for (const row of db.prepare('SELECT * FROM fund_static_data ORDER BY scheme_name').all()) {
      const family = normalizeSchemeFamilyName(row.scheme_name);
      if (!family) continue;
      if (staticFamilyIndex.has(family)) staticFamilyIndex.set(family, null);
      else staticFamilyIndex.set(family, parse(row));
    }
  }
  return staticFamilyIndex.get(target) || null;
}

// Every record, uncapped — used by the Excel export (list() below is
// capped at 1000 rows for the Admin table UI; export must return ALL
// schemes regardless of count).
function listAll() {
  return db.prepare('SELECT * FROM fund_static_data ORDER BY scheme_name').all().map(parse);
}

function list({ search = '', limit = 500 } = {}) {
  const query = search.trim();
  const max = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const rows = query
    ? db.prepare('SELECT * FROM fund_static_data WHERE scheme_name LIKE ? OR category LIKE ? ORDER BY scheme_name LIMIT ?').all(`%${query}%`, `%${query}%`, max)
    : db.prepare('SELECT * FROM fund_static_data ORDER BY scheme_name LIMIT ?').all(max);
  return rows.map(parse);
}

function findExactBySchemeName(schemeName) {
  // Strict, case-insensitive exact match only — no fuzzy/partial fallback.
  // Used anywhere an insert-vs-update DECISION is being made (bulk Excel
  // import, the CLI import script) so that two genuinely different
  // schemes with similar names (e.g. the same fund's Growth vs IDCW
  // option) never get merged into one record. The fuzzy matcher in
  // getBySchemeName() below is only safe for read-only runtime lookups.
  if (!schemeName) return null;
  const row = db.prepare('SELECT * FROM fund_static_data WHERE scheme_name = ? COLLATE NOCASE').get(String(schemeName).trim());
  return row ? parse(row) : null;
}

function getBySchemeName(schemeName) {
  if (!schemeName) return null;
  const trimmed = String(schemeName).trim();
  let row = db.prepare('SELECT * FROM fund_static_data WHERE scheme_name = ? COLLATE NOCASE').get(trimmed);
  if (!row) row = matchBestStaticRecord(trimmed);
  return row ? parse(row) : null;
}

function sanitizeSectors(list) {
  // Backward compatible with the old shape (plain array of sector-name
  // strings, e.g. from importFundStaticData.js) AND the new shape sent by
  // the Admin CRUD form: array of { sector, percentage } objects.
  if (!Array.isArray(list)) return [];
  const toDisplayString = (item) => {
    if (typeof item === 'string') return item.trim();
    const sector = String(item?.sector || item?.name || '').trim();
    if (!sector) return '';
    let pct = String(item?.percentage ?? item?.value ?? '').trim();
    if (pct && !/%\s*$/.test(pct)) pct += '%';
    return pct ? `${sector} (${pct})` : sector;
  };
  return list.map(toDisplayString).filter(Boolean).slice(0, 10);
}

function sanitizeExitLoad(value) {
  // Backward compatible with the old shape (a single free-text string)
  // AND the new shape sent by the Admin CRUD form: array of
  // { condition, value } row objects, which get joined into one string
  // so the exit_load column and every downstream consumer stay unchanged.
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const rows = value.map(item => {
      const condition = String(item?.condition || item?.name || '').trim();
      const val = String(item?.value ?? '').trim();
      if (!condition && !val) return '';
      if (!condition) return val;
      return val ? `${condition} — ${val}` : condition;
    }).filter(Boolean);
    return rows.join('; ');
  }
  return '';
}

// Accepts whatever shape a launch date might arrive in — a JS Date object
// (from an Excel cell read with cellDates:true, or from the Admin form's
// <input type="date">, which already sends plain ISO text but this stays
// defensive), an Excel serial-date number, or free text in a common
// day-month-year layout — and normalizes all of them to ISO "YYYY-MM-DD"
// so every consumer (sorting, display, re-export) sees one consistent
// format regardless of where the value came from.
function sanitizeLaunchDate(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  const str = String(value ?? '').trim();
  if (!str) return '';

  const iso = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const monthNames = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const dMonY = str.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s,-]+(\d{4})$/);
  if (dMonY) {
    const [, d, monStr, y] = dMonY;
    const m = monthNames[monStr.slice(0, 3).toLowerCase()];
    if (m) return `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // A bare Excel date serial that arrived as text (e.g. cellDates wasn't
  // set on read) — 1899-12-30 is Excel's day-zero epoch on all modern
  // (post-1900-bug-compatible) readers.
  if (/^\d{4,6}$/.test(str)) {
    const serial = Number(str);
    if (serial > 20000 && serial < 60000) {
      const epoch = Date.UTC(1899, 11, 30);
      return new Date(epoch + serial * 86400000).toISOString().slice(0, 10);
    }
  }

  return str; // Unrecognized format — keep the original text rather than discarding it.
}

function validate(payload) {
  const schemeName = String(payload.schemeName || '').trim();
  if (!schemeName) throw new Error('Scheme name is required.');
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schemeName,
    category: String(payload.category || '').trim(),
    riskMeasures: object(payload.riskMeasures),
    marketCapitalisation: object(payload.marketCapitalisation),
    amfiSectors: sanitizeSectors(payload.amfiSectors),
    exitLoad: sanitizeExitLoad(payload.exitLoad),
    launchDate: sanitizeLaunchDate(payload.launchDate),
    source: String(payload.source || 'admin').slice(0, 50)
  };
}

function save(payload, id = null) {
  const value = validate(payload);
  try {
    if (id) {
      const result = db.prepare(`UPDATE fund_static_data SET scheme_name=?, category=?, risk_measures=?, market_capitalisation=?, amfi_sectors=?, exit_load=?, launch_date=?, source=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(value.schemeName, value.category, JSON.stringify(value.riskMeasures), JSON.stringify(value.marketCapitalisation), JSON.stringify(value.amfiSectors), value.exitLoad, value.launchDate, value.source, id);
      if (!result.changes) throw new Error('Static fund record not found.');
      const saved = parse(db.prepare('SELECT * FROM fund_static_data WHERE id=?').get(id));
      staticFamilyIndex = null;
      return saved;
    }
    const result = db.prepare(`INSERT INTO fund_static_data (scheme_name, category, risk_measures, market_capitalisation, amfi_sectors, exit_load, launch_date, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.schemeName, value.category, JSON.stringify(value.riskMeasures), JSON.stringify(value.marketCapitalisation), JSON.stringify(value.amfiSectors), value.exitLoad, value.launchDate, value.source);
    const saved = parse(db.prepare('SELECT * FROM fund_static_data WHERE id=?').get(result.lastInsertRowid));
    staticFamilyIndex = null;
    return saved;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err.message)) {
      throw new Error(`A record for "${value.schemeName}" already exists.`);
    }
    throw err;
  }
}

function remove(id) {
  const removed = db.prepare('DELETE FROM fund_static_data WHERE id=?').run(id).changes > 0;
  if (removed) staticFamilyIndex = null;
  return removed;
}

module.exports = { db, list, listAll, getBySchemeName, findExactBySchemeName, normalizeSchemeName, save, remove };