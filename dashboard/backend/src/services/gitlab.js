'use strict';

// Thin GitLab API client used by the approval flow to resume the manual
// deploy job in the corresponding GitLab pipeline (dashboard -> GitLab control).
// Credentials come from env; never hardcode a token.

const API   = process.env.GITLAB_API_URL  || 'http://gitlab:8929/api/v4';
const TOKEN = process.env.GITLAB_TOKEN     || '';
const PROJECT = encodeURIComponent(process.env.GITLAB_PROJECT_ID || 'root/shieldops');

function headers() {
  return { 'PRIVATE-TOKEN': TOKEN, 'Content-Type': 'application/json' };
}

/** Resolve the project path for the API: per-run id if known, else the env default. */
function projectRef(projectId) {
  return projectId ? encodeURIComponent(String(projectId)) : PROJECT;
}

/**
 * Trigger a fresh pipeline on a branch (a "re-run" that re-runs every gate and
 * picks up any central-pipeline changes).
 * @param {object} opts { projectId, ref }
 * @returns {Promise<{ok:boolean, pipeline_id?:number, web_url?:string, reason?:string}>}
 */
async function triggerPipeline({ projectId, ref } = {}) {
  if (!TOKEN) return { ok: false, reason: 'GITLAB_TOKEN not configured' };
  if (!ref)   return { ok: false, reason: 'no branch/ref on record' };
  const url = `${API}/projects/${projectRef(projectId)}/pipeline?ref=${encodeURIComponent(ref)}`;
  const resp = await fetch(url, { method: 'POST', headers: headers() });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, reason: data.message || `HTTP ${resp.status}` };
  return { ok: true, pipeline_id: data.id, web_url: data.web_url };
}

/**
 * Find the manual deploy job in a GitLab pipeline and play (resume) it.
 * @param {number|string} gitlabPipelineId
 * @param {'staging'|'production'} environment
 * @returns {Promise<{played:boolean, job?:string, reason?:string}>}
 */
async function playManualDeploy(gitlabPipelineId, environment = 'production', projectId = null) {
  if (!TOKEN) return { played: false, reason: 'GITLAB_TOKEN not configured' };
  if (!gitlabPipelineId) return { played: false, reason: 'no gitlab_pipeline_id on record' };

  const proj = projectRef(projectId);
  const jobsUrl = `${API}/projects/${proj}/pipelines/${gitlabPipelineId}/jobs?per_page=100`;
  const resp = await fetch(jobsUrl, { headers: headers() });
  if (!resp.ok) return { played: false, reason: `list jobs failed: ${resp.status}` };
  const jobs = await resp.json();

  // Pick the manual deploy job for the requested environment (fallback: any manual deploy).
  const want = environment === 'staging' ? 'deploy-staging' : 'deploy-production';
  const job =
    jobs.find(j => j.status === 'manual' && j.name.includes(want)) ||
    jobs.find(j => j.status === 'manual' && j.name.includes('deploy'));
  if (!job) return { played: false, reason: 'no pending manual deploy job found' };

  const playResp = await fetch(`${API}/projects/${proj}/jobs/${job.id}/play`, {
    method: 'POST', headers: headers(),
  });
  if (!playResp.ok) return { played: false, job: job.name, reason: `play failed: ${playResp.status}` };
  return { played: true, job: job.name };
}

/**
 * Find a manual/created job by name in a pipeline and play (run) it.
 * Used by the dashboard's "Deploy to LocalStack" (10/10) action.
 * @returns {Promise<{ok:boolean, job?:string, status?:string, reason?:string}>}
 */
async function playJobByName(projectId, pipelineId, jobName) {
  if (!TOKEN) return { ok: false, reason: 'GITLAB_TOKEN not configured' };
  if (!pipelineId) return { ok: false, reason: 'no gitlab_pipeline_id on record' };
  const proj = projectRef(projectId);
  const jr = await fetch(`${API}/projects/${proj}/pipelines/${pipelineId}/jobs?per_page=100`, { headers: headers() });
  if (!jr.ok) return { ok: false, reason: `list jobs failed: ${jr.status}` };
  const jobs = await jr.json();
  const job = jobs.find(j => j.name === jobName) || jobs.find(j => j.name.includes(jobName));
  if (!job) return { ok: false, reason: `job '${jobName}' not found in pipeline` };
  if (job.status === 'success') return { ok: true, job: job.name, status: 'success', reason: 'already deployed' };
  if (job.status === 'running' || job.status === 'pending') return { ok: true, job: job.name, status: job.status, reason: 'already running' };
  const pr = await fetch(`${API}/projects/${proj}/jobs/${job.id}/play`, { method: 'POST', headers: headers() });
  if (!pr.ok) {
    // 'play' only works on manual jobs; if it can't be played, retry it instead.
    const rr = await fetch(`${API}/projects/${proj}/jobs/${job.id}/retry`, { method: 'POST', headers: headers() });
    if (!rr.ok) return { ok: false, job: job.name, reason: `play/retry failed: ${pr.status}/${rr.status}` };
  }
  return { ok: true, job: job.name, status: 'started' };
}

/**
 * Download a single artifact file from a job (found by name) in a pipeline.
 * @returns {Promise<{ok:boolean, json?:any, text?:string, reason?:string}>}
 */
async function getJobArtifact(projectId, pipelineId, jobName, artifactPath) {
  if (!TOKEN) return { ok: false, reason: 'GITLAB_TOKEN not configured' };
  if (!pipelineId) return { ok: false, reason: 'no gitlab_pipeline_id on record' };
  const proj = projectRef(projectId);
  const jr = await fetch(`${API}/projects/${proj}/pipelines/${pipelineId}/jobs?per_page=100`, { headers: headers() });
  if (!jr.ok) return { ok: false, reason: `list jobs failed: ${jr.status}` };
  const jobs = await jr.json();
  const job = jobs.find(j => j.name === jobName) || jobs.find(j => j.name.includes(jobName));
  if (!job) return { ok: false, reason: `job '${jobName}' not found in pipeline` };

  const ar = await fetch(`${API}/projects/${proj}/jobs/${job.id}/artifacts/${artifactPath}`, { headers: headers() });
  if (!ar.ok) return { ok: false, reason: `artifact '${artifactPath}' not available (${ar.status})` };
  const text = await ar.text();
  try { return { ok: true, json: JSON.parse(text) }; }
  catch { return { ok: true, json: null, text }; }
}

/**
 * Fetch a failed job's trace and distil it to a SHORT, human-readable reason
 * (the actual cause line, not the whole log) plus a link to the full log.
 * @returns {Promise<{ok:boolean, reason?:string, webUrl?:string, jobName?:string}>}
 */
async function getJobError(projectId, pipelineId, jobName) {
  if (!TOKEN) return { ok: false, reason: 'GITLAB_TOKEN not configured' };
  if (!pipelineId) return { ok: false, reason: 'no gitlab_pipeline_id on record' };
  const proj = projectRef(projectId);
  const jr = await fetch(`${API}/projects/${proj}/pipelines/${pipelineId}/jobs?per_page=100`, { headers: headers() });
  if (!jr.ok) return { ok: false, reason: `list jobs failed: ${jr.status}` };
  const jobs = await jr.json();
  const job = jobs.find(j => j.name === jobName) || jobs.find(j => j.name.includes(jobName));
  if (!job) return { ok: false, reason: `job '${jobName}' not found in pipeline` };
  const tr = await fetch(`${API}/projects/${proj}/jobs/${job.id}/trace`, { headers: headers() });
  if (!tr.ok) return { ok: false, reason: `job log unavailable (${tr.status})` };
  return { ok: true, reason: extractError(await tr.text()), webUrl: job.web_url, jobName: job.name };
}

/** Reduce a raw GitLab job trace to the 1–3 lines that explain the failure. */
function extractError(raw) {
  const lines = String(raw)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')   // ANSI colour codes
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')   // trace timestamp
      .replace(/^[0-9]+[OE]\+?/, '')                    // stream markers (00O/01E)
      .replace(/section_(start|end):\d+:\S*/g, '')
      .replace(/\[0K/g, '')
      .trim())
    .filter(Boolean);

  // Specific causes worth surfacing; the generic "Job failed" marker is only a fallback.
  const SPECIFIC = /(is invalid|Invalid value|already allocated|UPGRADE FAILED|INSTALLATION FAILED|Connection refused|connection reset|TLS handshake|no such|not found|permission denied|access denied|denied|fatal:|unable to|cannot\b|Error:|error occurred|failed to|timed out|exited with)/i;
  const JOBFAIL = /ERROR: Job failed/i;
  const isCommandEcho = (l) => /^\$\s/.test(l);   // GitLab echoes each script line as "$ <cmd>"
  // Runner bookkeeping that is never the cause of a failure.
  const NOISE = /(Uploading artifacts|Downloading artifacts|found \d+ matching|Cleaning up|to coordinator|responseStatus=|correlation_id=|Saving cache|Restoring cache|Checking out|Skipping Git|Created fresh|Reinitialized|Getting source|Using docker image|Preparing)/i;

  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) { if (JOBFAIL.test(lines[i])) { end = i; break; } }
  const window = lines.slice(Math.max(0, end - 25), end).filter(l => !isCommandEcho(l) && !NOISE.test(l));
  let pick = window.filter(l => SPECIFIC.test(l) && !JOBFAIL.test(l)).slice(-3);
  if (pick.length === 0) pick = window.slice(-3);           // fallback: last lines before failure
  let msg = pick.join('\n').replace(/\s+\*\s+/g, ' ').trim();
  if (msg.length > 500) msg = msg.slice(0, 500) + '…';
  return msg || 'Job failed — see full log for details.';
}

/** Read a repo file on a branch. Returns { ok, exists, content }. */
async function getFile(projectId, branch, path) {
  if (!TOKEN) return { ok: false, reason: 'GITLAB_TOKEN not configured' };
  const url = `${API}/projects/${projectRef(projectId)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: headers() });
  if (r.status === 404) return { ok: true, exists: false, content: '' };
  if (!r.ok) return { ok: false, reason: `get file failed: ${r.status}` };
  const d = await r.json();
  return { ok: true, exists: true, content: Buffer.from(d.content || '', 'base64').toString('utf8') };
}

/** Create or update a repo file on a branch (a normal commit -> triggers CI). */
async function putFile(projectId, branch, path, content, message, exists) {
  if (!TOKEN) return { ok: false, reason: 'GITLAB_TOKEN not configured' };
  const url = `${API}/projects/${projectRef(projectId)}/repository/files/${encodeURIComponent(path)}`;
  const r = await fetch(url, {
    method: exists ? 'PUT' : 'POST',
    headers: headers(),
    body: JSON.stringify({ branch, content, commit_message: message, encoding: 'text' }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); return { ok: false, reason: `put file failed: ${r.status} ${t.slice(0, 120)}` }; }
  return { ok: true };
}

module.exports = { playManualDeploy, playJobByName, triggerPipeline, getJobArtifact, getJobError, getFile, putFile };
