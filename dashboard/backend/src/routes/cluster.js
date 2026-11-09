'use strict';

// Cluster inspect/manage API for the deployed app (staging + production on kind).
// All routes require auth. Only the two demo namespaces are allowed, and the
// deployment name is validated, so this can never touch arbitrary cluster objects.

const express = require('express');
const { param, body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const k8s  = require('../services/k8s');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const NS_OK = new Set(['staging', 'production']);

function vns(req, res, next) {
  if (!NS_OK.has(req.params.ns)) return res.status(400).json({ error: `unknown environment '${req.params.ns}'` });
  next();
}
function validate(req, res, next) {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ errors: e.array() });
  next();
}
function kubeErr(res, err) {
  const msg = (err.stderr || err.message || 'kubectl error').toString().replace(/\s+/g, ' ').trim();
  return res.status(502).json({ error: msg.slice(0, 240) });
}

/** GET /api/cluster/:ns — workloads + the AWS (LocalStack) deploy relation. */
router.get('/:ns', vns, async (req, res) => {
  try {
    const wl = await k8s.getWorkloads(req.params.ns);

    // AWS relation: the most recent g9-deploy-localstack (the "deploy to AWS" stage).
    let aws = null;
    try {
      const { rows } = await pool.query(`
        SELECT pr.gitlab_pipeline_id, pr.project_web_url, g.status, g.updated_at
        FROM gate_results g
        JOIN pipeline_runs pr ON pr.id = g.pipeline_id
        WHERE g.gate_name = 'g9-deploy-localstack'
        ORDER BY g.updated_at DESC NULLS LAST
        LIMIT 1`);
      if (rows[0]) aws = {
        pipeline_id: rows[0].gitlab_pipeline_id,
        status:      rows[0].status,
        web_url:     rows[0].project_web_url,
        at:          rows[0].updated_at,
      };
    } catch (e) { /* relation is best-effort */ }

    res.json({ namespace: req.params.ns, ...wl, aws });
  } catch (err) {
    console.error('[cluster] get error:', err.message);
    kubeErr(res, err);
  }
});

/** POST /api/cluster/:ns/:deploy/restart — rollout restart. */
router.post('/:ns/:deploy/restart',
  vns, param('deploy').matches(/^[a-z0-9-]{1,63}$/), validate,
  async (req, res) => {
    try { res.json(await k8s.restart(req.params.ns, req.params.deploy)); }
    catch (err) { kubeErr(res, err); }
  });

/** POST /api/cluster/:ns/:deploy/scale { replicas } */
router.post('/:ns/:deploy/scale',
  vns, param('deploy').matches(/^[a-z0-9-]{1,63}$/), body('replicas').isInt({ min: 0, max: 10 }), validate,
  async (req, res) => {
    try { res.json(await k8s.scale(req.params.ns, req.params.deploy, req.body.replicas)); }
    catch (err) { kubeErr(res, err); }
  });

/** POST /api/cluster/:ns/:deploy/rollback — undo to previous revision. */
router.post('/:ns/:deploy/rollback',
  vns, param('deploy').matches(/^[a-z0-9-]{1,63}$/), validate,
  async (req, res) => {
    try { res.json(await k8s.rollback(req.params.ns, req.params.deploy)); }
    catch (err) { kubeErr(res, err); }
  });

/** GET /api/cluster/:ns/:deploy/logs — last N lines (plain text). */
router.get('/:ns/:deploy/logs',
  vns, param('deploy').matches(/^[a-z0-9-]{1,63}$/), validate,
  async (req, res) => {
    try { res.type('text/plain').send(await k8s.logs(req.params.ns, req.params.deploy, req.query.lines)); }
    catch (err) { kubeErr(res, err); }
  });

module.exports = router;
