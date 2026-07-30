'use strict';

/**
 * node-sidecar/server.js
 *
 * Express server that wraps madden-franchise and madden-draft-class-tools
 * as HTTP endpoints for the Python FastAPI backend.
 *
 * Endpoints:
 *   GET  /health
 *   POST /read-draftclass    { file_path }
 *   POST /write-draftclass   { prospects, output_path }
 *   POST /read-roster        { file_path }
 *   POST /validate-file      { file_path, type: 'ros' | 'draftclass' }
 */

const express = require('express');
const draftclassRoutes = require('./routes/draftclass');
const rosterRoutes = require('./routes/roster');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'madden-node-sidecar' });
});

// ── Feature routes ────────────────────────────────────────────────────────────
app.use('/', draftclassRoutes);
app.use('/', rosterRoutes);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[sidecar error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[madden-node-sidecar] Listening on port ${PORT}`);
});
