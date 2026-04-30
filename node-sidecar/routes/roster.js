'use strict';

/**
 * node-sidecar/routes/roster.js
 *
 * Express route for reading a Madden .ros roster file.
 *   POST /read-roster  { file_path }
 *
 * SECURITY: This sidecar is internal-only (not exposed to the browser).
 *   All file_path values are resolved and validated against an allowlist of
 *   permitted base directories to prevent path traversal attacks.
 *   The route is rate-limited to guard against accidental tight loops.
 */

const fs = require('fs');
const path = require('path');
const router = require('express').Router();

// ── Rate limiter (simple in-memory token bucket) ──────────────────────────────
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

// madden-franchise may not be installed in dev environments.
let MaddenFranchise;
try {
  MaddenFranchise = require('madden-franchise');
} catch (e) {
  console.warn('[roster] madden-franchise not installed — /read-roster will return 503');
}

// All numeric rating fields to extract per player
const RATING_FIELDS = [
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
  'injury', 'morale', 'personality', 'devTrait',
];

const POS_ENUM_TO_STR = {
  0: 'QB', 1: 'HB', 2: 'FB', 3: 'WR', 4: 'TE',
  5: 'OT', 6: 'OG', 7: 'C', 8: 'DE', 9: 'DT',
  10: 'OLB', 11: 'MLB', 12: 'CB', 13: 'FS', 14: 'SS',
  15: 'K', 16: 'P', 17: 'LS',
};

// ── POST /read-roster ─────────────────────────────────────────────────────────
router.post('/read-roster', async (req, res) => {
  if (!MaddenFranchise) {
    return res.status(503).json({ error: 'madden-franchise not installed' });
  }

  const safePath = resolveSafePath(req.body.file_path);
  if (!safePath) {
    return res.status(400).json({ error: 'Invalid or disallowed file_path' });
  }
  if (!fs.existsSync(safePath)) { // lgtm[js/path-injection]
    return res.status(404).json({ error: `File not found: ${safePath}` });
  }

  try {
    const franchise = new MaddenFranchise(safePath, // lgtm[js/path-injection] { autoUnempty: true });
    await franchise.ready;

    const playerTable = franchise.getTableByName('Player');
    await playerTable.readRecords();

    const players = {};
    const byPosition = {};

    for (const record of playerTable.records) {
      if (!record || record.isEmpty) continue;

      const posNum = record.Position ?? record.position ?? 0;
      const pos = POS_ENUM_TO_STR[posNum] || `POS_${posNum}`;

      const ratings = {};
      for (const field of RATING_FIELDS) {
        const val = record[field];
        if (val !== undefined && val !== null) {
          ratings[field] = Number(val);
        }
      }

      const firstName = (record.FirstName || record.firstName || '').trim();
      const lastName  = (record.LastName  || record.lastName  || '').trim();
      const fullName  = `${firstName} ${lastName}`.trim();

      const playerObj = {
        firstName,
        lastName,
        name: fullName,
        position: pos,
        overall: ratings.overall ?? 0,
        devTrait: ratings.devTrait ?? 0,
        ratings,
      };

      if (fullName) {
        players[fullName] = playerObj;
      }

      if (!byPosition[pos]) byPosition[pos] = [];
      byPosition[pos].push(playerObj);
    }

    // Sort each position group by overall descending; keep top-10 for calibration
    const calibration = {};
    const full = {};
    for (const [pos, list] of Object.entries(byPosition)) {
      list.sort((a, b) => b.overall - a.overall);
      calibration[pos] = list.slice(0, 10);
      full[pos] = list;
    }

    return res.json({
      calibration,
      players,
      full,
      total: Object.values(players).length,
    });
  } catch (err) {
    console.error('[read-roster]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
