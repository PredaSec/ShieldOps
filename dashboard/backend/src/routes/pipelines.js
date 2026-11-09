'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool     = require('../db/pool');
const notify   = require('../services/notify');
const gitlab   = require('../services/gitlab');
const findings   = require('../services/findings');
const aifix      = require('../services/aifix');
const acceptrisk = require('../services/acceptrisk');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/** GET /api/pipelines — list recent pipeline runs */
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*,
             COUNT(g.id) FILTER (WHERE g.status = 'success')  AS gates_passed,
             COUNT(g.id) FILTER (WHERE g.status = 'failed')   AS gates_failed,
             COUNT(g.id)                                        AS gates_total,
             d.status                                          AS deploy_status
      FROM pipeline_runs p
      LEFT JOIN gate_results g ON g.pipeline_id = p.id
      LEFT JOIN deployments  d ON d.pipeline_id = p.id
      GROUP BY p.id, d.status
      ORDER BY p.created_at DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    console.error('[pipelines] list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** GET /api/pipelines/:id — pipeline detail with gates + AI report */
router.get('/:id',
  param('id').isInt({ min: 1 }),
  validate,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const [pipelineRes, gatesRes, reportRes, deployRes] = await Promise.all([
        pool.query('SELECT * FROM pipeline_runs WHERE id = $1', [id]),
        pool.query('SELECT * FROM gate_results WHERE pipeline_id = $1 ORDER BY created_at', [id]),
        pool.query('SELECT * FROM ai_reports   WHERE pipeline_id = $1 ORDER BY created_at DESC LIMIT 1', [id]),
        pool.query('SELECT * FROM deployments  WHERE pipeline_id = $1 ORDER BY created_at DESC LIMIT 1', [id]),
      ]);

      if (pipelineRes.rows.length === 0) {
        return res.status(404).json({ error: 'Pipeline not found' });
      }

      res.json({
        pipeline:   pipelineRes.rows[0],
        gates:      gatesRes.rows,
        ai_report:  reportRes.rows[0] || null,
        deployment: deployRes.rows[0] || null,
      });
    } catch (err) {
      console.error('[pipelines] detail error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/** GET /api/pipelines/:id/gates/:gate/findings — what exactly failed (file/line/rule/fix) */
router.get('/:id/gates/:gate/findings',
  param('id').isInt({ min: 1 }),
  param('gate').isString().trim().isLength({ max: 64 }),
  validate,
  async (req, res) => {
    const id   = parseInt(req.params.id, 10);
    const gate = req.params.gate;
    const map  = findings.GATE_MAP[gate];
    try {
      const { rows } = await pool.query(
        'SELECT gitlab_pipeline_id, gitlab_project_id FROM pipeline_runs WHERE id = $1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Pipeline not found' });

      // Non-scanner gate (deploy / AI / ZAP): no machine-readable findings, so
      // surface the actual failure reason distilled from the job log.
      if (!map) {
        const err = await gitlab.getJobError(rows[0].gitlab_project_id, rows[0].gitlab_pipeline_id, gate);
        return res.json({
          tool: null, supported: false, findings: [],
          reason: err.ok ? err.reason : null,
          jobWebUrl: err.webUrl || null,
          note: err.ok ? null : err.reason,
        });
      }

      const art = await gitlab.getJobArtifact(rows[0].gitlab_project_id, rows[0].gitlab_pipeline_id, gate, map.file);
      if (!art.ok) return res.json({ tool: map.tool, supported: true, findings: [], note: art.reason });

      const all = findings.parse(map.tool, art.json);
      res.json({ tool: map.tool, supported: true, total: all.length, findings: all.slice(0, 25) });
    } catch (err) {
      console.error('[pipelines] findings error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/** POST /api/pipelines/:id/ai-fix — short AI remediation tip for one finding (backup) */
router.post('/:id/ai-fix',
  param('id').isInt({ min: 1 }),
  body('rule').optional().isString().isLength({ max: 200 }),
  body('message').optional().isString().isLength({ max: 1000 }),
  body('file').optional().isString().isLength({ max: 400 }),
  body('tool').optional().isString().isLength({ max: 40 }),
  validate,
  async (req, res) => {
    try {
      const out = await aifix.suggestFix({
        tool: req.body.tool, rule: req.body.rule, file: req.body.file,
        line: req.body.line, message: req.body.message,
      });
      if (!out.ok) return res.status(503).json({ error: out.reason });
      res.json({ ok: true, suggestion: out.suggestion });
    } catch (err) {
      console.error('[pipelines] ai-fix error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/** POST /api/pipelines/:id/accept-risk — suppress a finding via the tool's native
 *  ignore (committed to the app repo); the commit auto-triggers a fresh pipeline. */
router.post('/:id/accept-risk',
  param('id').isInt({ min: 1 }),
  body('tool').isString().isLength({ max: 40 }),
  body('rule').optional().isString().isLength({ max: 200 }),
  body('file').optional().isString().isLength({ max: 400 }),
  body('fingerprint').optional().isString().isLength({ max: 400 }),
  validate,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows } = await pool.query(
        'SELECT branch, gitlab_project_id FROM pipeline_runs WHERE id = $1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Pipeline not found' });

      const out = await acceptrisk.acceptRisk({
        projectId: rows[0].gitlab_project_id, branch: rows[0].branch,
        tool: req.body.tool, rule: req.body.rule, file: req.body.file,
        line: req.body.line, fingerprint: req.body.fingerprint,
      });
      if (!out.ok) return res.status(502).json({ error: out.reason });
      res.json({
        ok: true, accepted: out.desc, already: !!out.already,
        note: out.already
          ? 'Already accepted — re-run to proceed.'
          : `Committed to ${rows[0].branch}; a new pipeline starts automatically.`,
      });
    } catch (err) {
      console.error('[pipelines] accept-risk error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/** POST /api/pipelines/:id/deploy-aws — the "10/10 → Deploy to LocalStack (AWS)"
 *  action: play the g9-deploy-localstack job (ECR→S3 + S3 + Secrets Manager). */
router.post('/:id/deploy-aws',
  param('id').isInt({ min: 1 }),
  validate,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows } = await pool.query(
        'SELECT gitlab_pipeline_id, gitlab_project_id FROM pipeline_runs WHERE id = $1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Pipeline not found' });

      const out = await gitlab.playJobByName(
        rows[0].gitlab_project_id, rows[0].gitlab_pipeline_id, 'g9-deploy-localstack');
      if (!out.ok) return res.status(502).json({ error: out.reason });
      res.json({ ok: true, job: out.job, status: out.status, note: out.reason || 'Deploy to LocalStack started.' });
    } catch (err) {
      console.error('[pipelines] deploy-aws error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/** POST /api/pipelines/:id/rerun — trigger a fresh GitLab pipeline on the run's branch */
router.post('/:id/rerun',
  param('id').isInt({ min: 1 }),
  validate,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows } = await pool.query(
        'SELECT branch, gitlab_project_id FROM pipeline_runs WHERE id = $1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Pipeline not found' });

      const result = await gitlab.triggerPipeline({
        projectId: rows[0].gitlab_project_id,
        ref:       rows[0].branch,
      });
      if (!result.ok) return res.status(502).json({ error: `Re-run failed: ${result.reason}` });
      res.json({ ok: true, pipeline_id: result.pipeline_id, web_url: result.web_url });
    } catch (err) {
      console.error('[pipelines] rerun error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/** POST /api/pipelines/:id/approve */
router.post('/:id/approve',
  param('id').isInt({ min: 1 }),
  body('comment').optional().isString().trim().isLength({ max: 1000 }),
  body('approved_by').optional().isString().trim().isLength({ max: 200 }),
  validate,
  async (req, res) => {
    const id          = parseInt(req.params.id, 10);
    const { comment, approved_by } = req.body;
    try {
      // Upsert deployment record
      await pool.query(`
        INSERT INTO deployments (pipeline_id, environment, status, approved_by, decided_at, comment)
        VALUES ($1, 'production', 'approved', $2, NOW(), $3)
        ON CONFLICT (pipeline_id, environment)
        DO UPDATE SET status = 'approved', approved_by = $2, decided_at = NOW(), comment = $3
      `, [id, approved_by || 'dashboard', comment || null]);

      // Resume the manual deploy job in the corresponding GitLab pipeline (best-effort).
      let resume = { played: false, reason: 'not attempted' };
      try {
        const { rows } = await pool.query('SELECT gitlab_pipeline_id, gitlab_project_id FROM pipeline_runs WHERE id = $1', [id]);
        if (rows[0]) resume = await gitlab.playManualDeploy(rows[0].gitlab_pipeline_id, 'production', rows[0].gitlab_project_id);
      } catch (glErr) {
        console.warn('[approve] gitlab resume failed:', glErr.message);
        resume = { played: false, reason: glErr.message };
      }

      // Send notification
      try {
        await notify.send({
          pipeline_id: id,
          subject: `[ShieldOps] Pipeline #${id} APPROVED for production`,
          body:    `Pipeline ${id} has been approved for production deployment.\nComment: ${comment || '(none)'}`,
        });
      } catch (notifyErr) {
        console.warn('[approve] notification failed:', notifyErr.message);
      }

      res.json({ status: 'approved', pipeline_id: id, gitlab_resume: resume });
    } catch (err) {
      console.error('[pipelines] approve error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/** POST /api/pipelines/:id/reject */
router.post('/:id/reject',
  param('id').isInt({ min: 1 }),
  body('comment').optional().isString().trim().isLength({ max: 1000 }),
  body('approved_by').optional().isString().trim().isLength({ max: 200 }),
  validate,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { comment, approved_by } = req.body;
    try {
      await pool.query(`
        INSERT INTO deployments (pipeline_id, environment, status, approved_by, decided_at, comment)
        VALUES ($1, 'production', 'rejected', $2, NOW(), $3)
        ON CONFLICT (pipeline_id, environment)
        DO UPDATE SET status = 'rejected', approved_by = $2, decided_at = NOW(), comment = $3
      `, [id, approved_by || 'dashboard', comment || null]);

      try {
        await notify.send({
          pipeline_id: id,
          subject: `[ShieldOps] Pipeline #${id} REJECTED — back to dev`,
          body:    `Pipeline ${id} has been rejected. Back to development.\nReason: ${comment || '(none)'}`,
        });
      } catch (notifyErr) {
        console.warn('[reject] notification failed:', notifyErr.message);
      }

      res.json({ status: 'rejected', pipeline_id: id });
    } catch (err) {
      console.error('[pipelines] reject error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
