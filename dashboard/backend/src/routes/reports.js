'use strict';

const express = require('express');
const { param, body, validationResult } = require('express-validator');
const axios  = require('axios');
const pool   = require('../db/pool');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/**
 * POST /api/reports/ingest — CI (G6/G8) posts the AI report it generated.
 * Token-protected (same shared token as the GitLab webhook). Upserts ai_reports
 * keyed by (pipeline_id, stage); creates a minimal pipeline_run if the webhook
 * hasn't arrived yet. Keyed by the GitLab pipeline id so CI doesn't need our id.
 */
router.post('/ingest', async (req, res) => {
  const expected = process.env.GITLAB_WEBHOOK_TOKEN;
  const token = req.headers['x-gitlab-token'];
  if (expected && token !== expected) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const { gitlab_pipeline_id, stage = 'staging', recommendation, risk_level, content_md, raw } = req.body || {};
  if (!gitlab_pipeline_id) return res.status(400).json({ error: 'gitlab_pipeline_id required' });
  try {
    // Ensure the pipeline_run exists (webhook may not have landed yet).
    const pr = await pool.query(`
      INSERT INTO pipeline_runs (gitlab_pipeline_id, commit_sha, branch, status, updated_at)
      VALUES ($1, 'unknown', 'unknown', 'running', NOW())
      ON CONFLICT (gitlab_pipeline_id) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `, [gitlab_pipeline_id]);
    const pipelineId = pr.rows[0].id;

    await pool.query(`
      INSERT INTO ai_reports (pipeline_id, stage, content_md, recommendation, risk_level, raw)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (pipeline_id, stage)
      DO UPDATE SET content_md = EXCLUDED.content_md, recommendation = EXCLUDED.recommendation,
                    risk_level = EXCLUDED.risk_level, raw = EXCLUDED.raw, created_at = NOW()
    `, [pipelineId, stage, content_md || null, recommendation || null, risk_level || null,
        raw ? JSON.stringify(raw) : null]);

    res.json({ ok: true, pipeline_id: pipelineId, stage });
  } catch (err) {
    console.error('[reports] ingest error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /api/reports/:id */
router.get('/:id',
  param('id').isInt({ min: 1 }),
  validate,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows } = await pool.query(
        'SELECT * FROM ai_reports WHERE id = $1',
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Report not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('[reports] get error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/analyze — proxy to Phase 4 AI service and persist result.
 * Body: { pipeline_id?, stage?, findings?, reportsDir? }
 */
router.post('/analyze',
  body('pipeline_id').optional().isInt({ min: 1 }),
  body('stage').optional().isString().isIn(['staging', 'production']),
  validate,
  async (req, res) => {
    const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:3000';
    const { pipeline_id, stage = 'staging', findings, reportsDir } = req.body;

    try {
      const aiRes = await axios.post(`${AI_SERVICE_URL}/analyze`, {
        stage,
        findings,
        reportsDir,
      }, { timeout: 30000 });

      const report = aiRes.data;

      // Persist to DB if pipeline_id is provided
      if (pipeline_id) {
        await pool.query(`
          INSERT INTO ai_reports (pipeline_id, stage, content_md, recommendation, risk_level, raw)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          pipeline_id,
          stage,
          report.content_md || null,
          report.recommendation || null,
          report.risk_level || null,
          JSON.stringify(report),
        ]);
      }

      res.json(report);
    } catch (err) {
      console.error('[analyze] proxy error:', err.message);
      if (err.response) {
        return res.status(err.response.status).json(err.response.data);
      }
      res.status(502).json({ error: 'AI service unavailable', detail: err.message });
    }
  }
);

module.exports = router;
