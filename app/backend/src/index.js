'use strict';

// V1 FIX: credentials are read from the environment (injected via K8s Secrets /
// AWS Secrets Manager), never hardcoded or committed to source.
const AWS_ACCESS_KEY_ID     = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const client  = require('prom-client');

const app  = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Prometheus metrics — default Node/process metrics + per-request histogram.
// Scraped by Prometheus (Phase 6) to power the Grafana "Application Health" board.
// ---------------------------------------------------------------------------
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

app.use(cors());
app.use(express.json());

// Time every request and record it against the matched route.
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route ? req.baseUrl + req.route.path : req.path, status: res.statusCode });
  });
  next();
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------------------------------------------------------------------
// Database pool — reads from env with insecure plaintext fallbacks (fine for
// local POC; production should inject secrets via K8s Secrets).
// ---------------------------------------------------------------------------
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  user:     process.env.DB_USER     || 'shieldops',
  password: process.env.DB_PASSWORD || 'shieldops',
  database: process.env.DB_NAME     || 'shieldops',
});

// ---------------------------------------------------------------------------
// Health / readiness probes (required for Kubernetes liveness + readiness).
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tasks — Safe, parameterised query (the baseline).
// ---------------------------------------------------------------------------
app.get('/api/tasks', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, description, status, created_at FROM tasks ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/tasks error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tasks/search?keyword= — V2 FIX: parameterised query.
// The keyword is bound as a parameter ($1), so it can never alter the SQL.
// ---------------------------------------------------------------------------
app.get('/api/tasks/search', async (req, res) => {
  const keyword = String(req.query.keyword || '').slice(0, 100);
  const like = `%${keyword}%`;
  try {
    const result = await pool.query(
      'SELECT id, title, description, status, created_at FROM tasks WHERE title ILIKE $1 OR description ILIKE $1 ORDER BY created_at DESC',
      [like]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/tasks/search error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tasks — V3 FIX: validate and constrain input before insert.
// ---------------------------------------------------------------------------
const ALLOWED_STATUS = ['todo', 'in_progress', 'done', 'pending'];

app.post('/api/tasks', async (req, res) => {
  const { title, description, status } = req.body || {};
  // V3 FIX: type + length + enum validation
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 255) {
    return res.status(400).json({ error: 'title is required (1-255 chars)' });
  }
  if (description != null && (typeof description !== 'string' || description.length > 2000)) {
    return res.status(400).json({ error: 'description must be a string (<=2000 chars)' });
  }
  if (status != null && !ALLOWED_STATUS.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${ALLOWED_STATUS.join(', ')}` });
  }
  try {
    const result = await pool.query(
      'INSERT INTO tasks (title, description, status) VALUES ($1, $2, $3) RETURNING *',
      [title, description || '', status || 'todo']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/tasks error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id — Safe parameterised delete.
// ---------------------------------------------------------------------------
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [parseInt(id, 10)]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/tasks/:id error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`ShieldOps backend listening on port ${PORT}`);
  console.log(`DB: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'shieldops'}`);
});
