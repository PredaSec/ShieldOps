'use strict';

const express = require('express');
const crypto  = require('crypto');
const pool    = require('../db/pool');

const router = express.Router();

/**
 * POST /api/webhooks/gitlab
 *
 * Verifies the X-Gitlab-Token header, then upserts pipeline_runs + gate_results.
 * GitLab Pipeline events: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#pipeline-events
 */
router.post('/gitlab', async (req, res) => {
  const token         = req.headers['x-gitlab-token'];
  const expectedToken = process.env.GITLAB_WEBHOOK_TOKEN;

  if (!expectedToken) {
    console.warn('[webhook] GITLAB_WEBHOOK_TOKEN not set — accepting all (dev mode)');
  } else if (!token || !safeCompare(token, expectedToken)) {
    console.warn('[webhook] Invalid token from', req.ip);
    return res.status(401).json({ error: 'Invalid webhook token' });
  }

  const event = req.headers['x-gitlab-event'] || '';
  if (!event.toLowerCase().includes('pipeline')) {
    // Not a pipeline event — acknowledge and skip
    return res.json({ ok: true, skipped: true });
  }

  const body = req.body;
  try {
    await handlePipelineEvent(body);
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    res.status(500).json({ error: 'Handler failed' });
  }
});

async function handlePipelineEvent(payload) {
  const pipeline = payload.object_attributes || {};
  const commit   = payload.commit || {};
  const builds   = payload.builds || [];
  const project  = payload.project || {};

  const gitlabPipelineId = pipeline.id;
  const commitSha        = pipeline.sha || commit.id || 'unknown';
  const branch           = pipeline.ref || 'unknown';
  const status           = mapStatus(pipeline.status);
  const startedAt        = pipeline.created_at  || null;
  const finishedAt       = pipeline.finished_at || null;
  const projectId        = project.id || null;
  const projectWebUrl    = project.web_url || null;

  if (!gitlabPipelineId) {
    console.warn('[webhook] No pipeline ID in payload');
    return;
  }

  // Upsert pipeline_run
  const { rows } = await pool.query(`
    INSERT INTO pipeline_runs (gitlab_pipeline_id, commit_sha, branch, status, started_at, finished_at, gitlab_project_id, project_web_url, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (gitlab_pipeline_id)
    DO UPDATE SET
      status            = EXCLUDED.status,
      branch            = EXCLUDED.branch,
      finished_at       = EXCLUDED.finished_at,
      gitlab_project_id = COALESCE(EXCLUDED.gitlab_project_id, pipeline_runs.gitlab_project_id),
      project_web_url   = COALESCE(EXCLUDED.project_web_url, pipeline_runs.project_web_url),
      updated_at        = NOW()
    RETURNING id
  `, [gitlabPipelineId, commitSha, branch, status, startedAt, finishedAt, projectId, projectWebUrl]);

  const pipelineRunId = rows[0].id;

  // Upsert gate_results from builds
  for (const build of builds) {
    const gateName = build.name  || 'unknown';
    const tool     = inferTool(build.name);
    const gStatus  = mapStatus(build.status);

    await pool.query(`
      INSERT INTO gate_results (pipeline_id, gate_name, tool, status, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (pipeline_id, gate_name)
      DO UPDATE SET status = EXCLUDED.status, tool = EXCLUDED.tool, updated_at = NOW()
    `, [pipelineRunId, gateName, tool, gStatus]);
  }
}

/** Map GitLab statuses to our internal set */
function mapStatus(s) {
  const map = {
    success:  'success',
    failed:   'failed',
    running:  'running',
    pending:  'pending',
    canceled: 'cancelled',
    skipped:  'skipped',
    created:  'pending',
    manual:   'pending',
  };
  return map[s] || s || 'unknown';
}

/** Infer tool name from job name (best-effort) */
function inferTool(name) {
  if (!name) return 'unknown';
  const n = name.toLowerCase();
  if (n.includes('semgrep'))  return 'semgrep';
  if (n.includes('trivy'))    return 'trivy';
  if (n.includes('checkov'))  return 'checkov';
  if (n.includes('tfsec'))    return 'tfsec';
  if (n.includes('gitleaks')) return 'gitleaks';
  if (n.includes('opa') || n.includes('conftest')) return 'opa';
  if (n.includes('zap'))      return 'zap';
  if (n.includes('ai'))       return 'ai';
  if (n.includes('build'))    return 'build';
  if (n.includes('deploy'))   return 'deploy';
  return 'ci';
}

/** Timing-safe string comparison */
function safeCompare(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

module.exports = router;
