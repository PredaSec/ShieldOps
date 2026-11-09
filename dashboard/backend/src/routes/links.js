'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');

const router = express.Router();

/** GET /api/links — return configured external tool links */
router.get('/links', async (req, res) => {
  // Return from env if set, otherwise fetch from DB settings
  const linksFromEnv = {
    grafana:    process.env.LINK_GRAFANA,
    prometheus: process.env.LINK_PROMETHEUS,
    loki:       process.env.LINK_LOKI,
    zap:        process.env.LINK_ZAP,
    trivy:      process.env.LINK_TRIVY,
    semgrep:    process.env.LINK_SEMGREP,
    gitlab:     process.env.LINK_GITLAB,
  };

  // If any env-based links exist, use those; otherwise query DB
  const hasEnvLinks = Object.values(linksFromEnv).some(Boolean);
  if (hasEnvLinks) {
    // Filter out nulls
    const links = Object.fromEntries(
      Object.entries(linksFromEnv).filter(([, v]) => v)
    );
    return res.json(links);
  }

  try {
    const { rows } = await pool.query(
      "SELECT value FROM settings WHERE key = 'links'"
    );
    const links = rows[0]?.value || {};
    res.json(links);
  } catch (err) {
    console.error('[links] error:', err.message);
    // Return safe defaults on DB error
    res.json({
      grafana:    'http://localhost:3000',
      prometheus: 'http://localhost:9090',
      loki:       'http://localhost:3100',
      gitlab:     'http://localhost:8929',
    });
  }
});

/** GET /api/settings — get settings */
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM settings');
    const result = {};
    for (const row of rows) result[row.key] = row.value;
    res.json(result);
  } catch (err) {
    console.error('[settings] get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** PUT /api/settings/:key — update a setting */
router.put('/settings/:key',
  body('value').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { key }   = req.params;
    const { value } = req.body;
    // Allowlist settable keys
    const allowed = ['notification_recipients', 'links'];
    if (!allowed.includes(key)) {
      return res.status(403).json({ error: 'Setting not configurable via API' });
    }

    try {
      await pool.query(`
        INSERT INTO settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key, JSON.stringify(value)]);
      res.json({ ok: true, key });
    } catch (err) {
      console.error('[settings] put error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
