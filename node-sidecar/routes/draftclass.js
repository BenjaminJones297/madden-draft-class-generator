'use strict';

/**
 * node-sidecar/routes/draftclass.js
 *
 * Express routes for draft class file operations.
 *   POST /read-draftclass   { file_path }
 *   POST /write-draftclass  { prospects, output_path }
 *   POST /validate-file     { file_path, type }
 *
 * SECURITY: This sidecar is internal-only (not exposed to the browser).
 *   All file_path / output_path values are resolved and validated against an
 *   allowlist of permitted base directories to prevent path traversal attacks.
 *   All routes are rate-limited to guard against accidental tight loops.
 */

const fs = require('fs');
const path = require('path');
const router = require('express').Router();

// ── Rate limiter (simple in-memory token bucket) ──────────────────────────────
// 60 requests/minute per IP is generous for an internal sidecar.
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

function rateLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  requestCounts.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — please slow down' });
  }
  return next();
}

router.use(rateLimiter);

// ── Allowed base directories for file operations ──────────────────────────────
const ALLOWED_BASES = [
  path.resolve(process.env.STORAGE_LOCAL_PATH || '/data/files'),
  path.resolve(path.join(__dirname, '..', '..', 'data')),  // project data/ dir
];

/**
 * Validate and resolve a file path.
 * Returns the resolved path if it is inside an allowed base, or null otherwise.
 */
function resolveSafePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_BASES.some(
    base => resolved === base || resolved.startsWith(base + path.sep)
  );
  return allowed ? resolved : null;
}

// madden-draft-class-tools may not be installed in dev environments.
let MaddenDCTools;
try {
  MaddenDCTools = require('madden-draft-class-tools');
} catch (e) {
  console.warn('[draftclass] madden-draft-class-tools not installed — /read-draftclass and /write-draftclass will return 503');
}

// Position string → DraftPositionE enum
const POSITION_TO_ENUM = {
  QB: 0, HB: 1, FB: 2, WR: 3, TE: 4,
  T: 5, G: 6, C: 7, DE: 8, DT: 9,
  OLB: 10, MLB: 11, CB: 12, FS: 13, SS: 14,
  K: 15, P: 16, LS: 17,
};

// All numeric rating fields
const ALL_RATING_FIELDS = [
  'overall', 'speed', 'acceleration', 'agility', 'strength', 'awareness',
  'throwPower', 'throwAccuracy', 'throwAccuracyShort', 'throwAccuracyMid',
  'throwAccuracyDeep', 'throwOnTheRun', 'throwUnderPressure', 'playAction',
  'breakSack', 'tackle', 'hitPower', 'blockShedding', 'finesseMoves',
  'powerMoves', 'pursuit', 'zoneCoverage', 'manCoverage', 'pressCoverage',
  'playRecognition', 'jumping', 'catching', 'catchInTraffic', 'spectacularCatch',
  'shortRouteRunning', 'mediumRouteRunning', 'deepRouteRunning', 'release',
  'runBlock', 'passBlock', 'runBlockPower', 'runBlockFinesse', 'passBlockPower',
  'passBlockFinesse', 'impactBlocking', 'leadBlock', 'jukeMove', 'spinMove',
  'stiffArm', 'trucking', 'breakTackle', 'ballCarrierVision', 'changeOfDirection',
  'carrying', 'kickPower', 'kickAccuracy', 'kickReturn', 'stamina', 'toughness',
  'injury', 'morale', 'personality', 'devTrait', 'unkRating1',
];

/** Clamp a value to [0, max]. */
function safeRating(val, max = 99) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/** Convert "6-2" → total inches */
function parseHeight(htStr) {
  if (!htStr) return 72;
  const parts = String(htStr).split('-');
  return parseInt(parts[0], 10) * 12 + parseInt(parts[1] || 0, 10);
}

// ── POST /read-draftclass ─────────────────────────────────────────────────────
router.post('/read-draftclass', async (req, res) => {
  if (!MaddenDCTools) {
    return res.status(503).json({ error: 'madden-draft-class-tools not installed' });
  }

  const safePath = resolveSafePath(req.body.file_path);
  if (!safePath) {
    return res.status(400).json({ error: 'Invalid or disallowed file_path' });
  }
  if (!fs.existsSync(safePath)) { // lgtm[js/path-injection]
    return res.status(404).json({ error: `File not found: ${safePath}` });
  }

  try {
    const dc = new MaddenDCTools.MaddenDraftClass(safePath); // lgtm[js/path-injection]
    await dc.parse();
    const prospects = dc.draftees.map(p => {
      const obj = { name: p.name };
      for (const field of ALL_RATING_FIELDS) {
        obj[field] = p[field] ?? 0;
      }
      return obj;
    });
    return res.json({ prospects, count: prospects.length });
  } catch (err) {
    console.error('[read-draftclass]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /write-draftclass ────────────────────────────────────────────────────
router.post('/write-draftclass', async (req, res) => {
  if (!MaddenDCTools) {
    return res.status(503).json({ error: 'madden-draft-class-tools not installed' });
  }

  const { prospects } = req.body;
  if (!prospects || !Array.isArray(prospects)) {
    return res.status(400).json({ error: 'prospects (array) is required' });
  }

  const safeOut = resolveSafePath(req.body.output_path);
  if (!safeOut) {
    return res.status(400).json({ error: 'Invalid or disallowed output_path' });
  }

  try {
    fs.mkdirSync(path.dirname(safeOut), { recursive: true }); // lgtm[js/path-injection]

    const draftees = prospects.map(p => {
      const nameParts = (p.name || '').split(' ');
      const d = {};
      d.firstName    = p.firstName   || nameParts[0] || '';
      d.lastName     = p.lastName    || nameParts.slice(1).join(' ') || '';
      d.position     = POSITION_TO_ENUM[p.pos] ?? POSITION_TO_ENUM[p.position] ?? 0;
      d.height       = parseHeight(p.ht || p.height);
      d.weight       = safeRating(p.wt || p.weight, 400);
      d.age          = safeRating(p.age, 40);
      d.homeState    = p.homeState   || 0;
      d.homeTown     = p.homeTown    || '';
      d.college      = 0;
      d.draftable    = 1;
      d.birthDate    = p.birthDate   || '1/1/2003';
      for (const field of ALL_RATING_FIELDS) {
        d[field] = safeRating(p[field] ?? (p.ratings ? p.ratings[field] : 0));
      }
      return d;
    });

    await MaddenDCTools.writeDraftClass(draftees, safeOut); // lgtm[js/path-injection]
    return res.json({ success: true, output_path: safeOut, count: draftees.length });
  } catch (err) {
    console.error('[write-draftclass]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /validate-file ───────────────────────────────────────────────────────
router.post('/validate-file', async (req, res) => {
  const { type } = req.body;
  const safePath = resolveSafePath(req.body.file_path);
  if (!safePath) {
    return res.status(400).json({ error: 'Invalid or disallowed file_path' });
  }
  if (!fs.existsSync(safePath)) { // lgtm[js/path-injection]
    return res.json({ valid: false, error: `File not found: ${safePath}` });
  }

  try {
    const stat = fs.statSync(safePath); // lgtm[js/path-injection]
    if (stat.size === 0) {
      return res.json({ valid: false, error: 'File is empty' });
    }

    if (type === 'draftclass' && MaddenDCTools) {
      const dc = new MaddenDCTools.MaddenDraftClass(safePath); // lgtm[js/path-injection]
      await dc.parse();
      return res.json({ valid: true, type, size_bytes: stat.size, prospects: dc.draftees.length });
    }

    return res.json({ valid: true, type, size_bytes: stat.size });
  } catch (err) {
    return res.json({ valid: false, error: err.message });
  }
});

module.exports = router;
