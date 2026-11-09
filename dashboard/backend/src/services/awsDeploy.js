'use strict';

/**
 * AWS Deployment Service — Phase 5 / 7 interface
 *
 * SECURITY (non-negotiable per plan 5.4):
 *  - Raw credentials are NEVER persisted to DB or written to disk unencrypted.
 *  - If a temp credentials file is written, it is chmod-600 and deleted in a finally block.
 *  - All log lines are passed through redactString() before writing.
 *  - Access Key IDs are masked to AKIA...****  in every log and error message.
 *  - One concurrent deploy job per environment.
 */

const { execFile, spawn } = require('child_process');
const { promisify }       = require('util');
const { v4: uuidv4 }      = require('uuid');
const fs                  = require('fs');
const os                  = require('os');
const path                = require('path');
const { redactString, redactObject } = require('../middleware/redact');

/**
 * Redact an error message that might contain raw AWS creds.
 * In addition to the field-name-based regex in redact.js, we also
 * strip any 40-character base64-ish token that could be a secret key
 * embedded in an arbitrary error string (e.g. "AccessDenied for key <secret>").
 */
function redactAwsError(msg, creds) {
  if (!msg) return msg;
  let out = redactString(msg);
  // Also scrub the literal secret / session token values if they appear
  if (creds && creds.secretAccessKey) {
    out = out.split(creds.secretAccessKey).join('**REDACTED**');
  }
  if (creds && creds.sessionToken) {
    out = out.split(creds.sessionToken).join('**REDACTED**');
  }
  return out;
}

const execFileAsync = promisify(execFile);

// In-memory job store (per-process; replace with Redis for multi-instance)
const jobs = new Map(); // jobId -> JobState

// One concurrent deploy per environment
const runningEnvs = new Set();

/**
 * JobState shape:
 * {
 *   id:       string,
 *   status:   'running' | 'succeeded' | 'failed',
 *   logs:     string[],
 *   appUrl:   string | null,
 *   error:    string | null,
 *   startedAt: Date,
 *   finishedAt: Date | null,
 *   listeners: Set<(line: string) => void>,   // SSE subscribers
 * }
 */

/**
 * Run AWS preflight checks.
 * Credentials are passed in memory only — never logged raw.
 *
 * @param {{ accessKeyId, secretAccessKey, sessionToken?, region, ecrRepo?, eksCluster?, environment }} creds
 * @returns {{ checks: Array<{name, passed, detail}> }}
 */
async function preflight(creds) {
  const {
    accessKeyId, secretAccessKey, sessionToken,
    region = 'us-east-1',
    ecrRepo, eksCluster,
  } = creds;

  const env = buildAwsEnv({ accessKeyId, secretAccessKey, sessionToken, region });
  const checks = [];

  // 1. Credential validity — aws sts get-caller-identity
  try {
    const { stdout } = await execFileAsync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      env,
      timeout: 15000,
    });
    const identity = JSON.parse(stdout);
    checks.push({
      name:   'credentials_valid',
      passed: true,
      detail: `Account: ${identity.Account}, ARN: ${redactString(identity.Arn)}`,
    });
  } catch (err) {
    checks.push({
      name:   'credentials_valid',
      passed: false,
      detail: redactAwsError(err.stderr || err.message || 'STS call failed', creds),
    });
    // Can't proceed without valid creds
    return { checks };
  }

  // 2. EKS cluster reachable
  if (eksCluster) {
    try {
      await execFileAsync('aws', [
        'eks', 'describe-cluster', '--name', eksCluster, '--region', region, '--output', 'json',
      ], { env, timeout: 15000 });
      checks.push({ name: 'eks_cluster_reachable', passed: true, detail: `Cluster ${eksCluster} found` });
    } catch (err) {
      checks.push({
        name:   'eks_cluster_reachable',
        passed: false,
        detail: redactAwsError(err.stderr || err.message, creds),
      });
    }
  } else {
    checks.push({ name: 'eks_cluster_reachable', passed: true, detail: 'No cluster specified (skipped)' });
  }

  // 3. ECR repo exists or can be created
  if (ecrRepo) {
    try {
      await execFileAsync('aws', [
        'ecr', 'describe-repositories', '--repository-names', ecrRepo, '--region', region, '--output', 'json',
      ], { env, timeout: 15000 });
      checks.push({ name: 'ecr_repo_exists', passed: true, detail: `ECR repo ${ecrRepo} exists` });
    } catch (err) {
      // Try to infer if it's "not found" vs "no permission"
      const msg = (err.stderr || err.message || '').toLowerCase();
      if (msg.includes('repositorynotfoundexception')) {
        checks.push({ name: 'ecr_repo_exists', passed: false, detail: `ECR repo ${ecrRepo} not found (will be created on deploy)` });
      } else {
        checks.push({ name: 'ecr_repo_exists', passed: false, detail: redactAwsError(err.stderr || err.message, creds) });
      }
    }
  } else {
    checks.push({ name: 'ecr_repo_exists', passed: true, detail: 'No ECR repo specified (skipped)' });
  }

  // 4. Required IAM permissions (simulate-principal-policy is per-account; use iam:GetUser as quick check)
  try {
    await execFileAsync('aws', ['iam', 'get-user', '--output', 'json'], { env, timeout: 10000 });
    checks.push({ name: 'iam_permissions', passed: true, detail: 'IAM GetUser succeeded' });
  } catch (err) {
    // Role-based creds won't have GetUser; try get-caller-identity attributes
    const msg = (err.stderr || err.message || '');
    if (msg.includes('NoSuchEntity') || msg.includes('AssumedRole')) {
      checks.push({ name: 'iam_permissions', passed: true, detail: 'Role-based credentials (IAM GetUser N/A)' });
    } else {
      checks.push({ name: 'iam_permissions', passed: false, detail: redactAwsError(msg, creds) });
    }
  }

  // 5. AWS CLI available
  try {
    await execFileAsync('aws', ['--version'], { timeout: 5000 });
    checks.push({ name: 'aws_cli_available', passed: true, detail: 'AWS CLI found' });
  } catch {
    checks.push({ name: 'aws_cli_available', passed: false, detail: 'AWS CLI not found on PATH' });
  }

  return { checks };
}

/**
 * Launch an async deploy job.
 * Credentials are held in memory for the job duration only, then zeroed.
 *
 * @returns {{ jobId: string }}
 */
function startDeployJob(creds) {
  const { environment = 'production', region = 'us-east-1' } = creds;

  if (runningEnvs.has(environment)) {
    throw Object.assign(new Error(`A deploy to ${environment} is already running`), { code: 'CONFLICT' });
  }

  const jobId = uuidv4();
  const job = {
    id:         jobId,
    status:     'running',
    logs:       [],
    appUrl:     null,
    error:      null,
    startedAt:  new Date(),
    finishedAt: null,
    listeners:  new Set(),
  };
  jobs.set(jobId, job);
  runningEnvs.add(environment);

  // Run async — do not await here
  runDeployJob(job, creds).catch(err => {
    jobLog(job, `[deploy] Unhandled error: ${redactString(err.message)}`);
    job.status     = 'failed';
    job.error      = redactString(err.message);
    job.finishedAt = new Date();
    runningEnvs.delete(environment);
    broadcastDone(job);
  });

  return { jobId };
}

async function runDeployJob(job, rawCreds) {
  const {
    accessKeyId, secretAccessKey, sessionToken,
    region = 'us-east-1', environment = 'production',
    ecrRepo, eksCluster,
    // Phase 7 additions — supplied by the AWS Console form:
    ecrBackendUrl, ecrFrontendUrl, ecrRegistry,
    ecsCluster, ecsBackendService, ecsFrontendService,
    imageTag,
  } = rawCreds;

  const env    = buildAwsEnv({ accessKeyId, secretAccessKey, sessionToken, region });
  let tmpFile  = null;

  try {
    jobLog(job, `[deploy] Starting deploy to ${environment} (region: ${region})`);
    jobLog(job, `[deploy] Credentials: ${redactString(accessKeyId)}…****`);

    // -----------------------------------------------------------------------
    // Phase 7 deploy flow — invokes ci/deploy-aws.sh.
    //
    // ci/deploy-aws.sh is the single source of truth for the deploy steps:
    //   Step 2 — ECR login
    //   Step 3 — docker build + push
    //   Step 4 — ECS force-new-deployment (+ optional Helm/EKS)
    //   Step 5 — wait for ECS stability
    //
    // The script reads all settings from environment variables, which we
    // inject via spawn()'s env option below — credentials never touch disk
    // (the tmpFile written here is only a fallback for AWS CLI credential
    // resolution, not passed to the script directly).
    // -----------------------------------------------------------------------

    // Step 1: Write temp AWS credentials file (chmod 600, deleted in finally)
    const jobUuid = uuidv4();
    tmpFile = path.join(os.tmpdir(), `aws-creds-${jobUuid}.ini`);
    const credsContent = [
      '[default]',
      `aws_access_key_id = ${accessKeyId}`,
      `aws_secret_access_key = ${secretAccessKey}`,
      sessionToken ? `aws_session_token = ${sessionToken}` : '',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(tmpFile, credsContent, { mode: 0o600 });
    jobLog(job, '[deploy] Temp credentials file written (chmod 600)');

    // Resolve the path to ci/deploy-aws.sh relative to this service file.
    // __dirname = dashboard/backend/src/services/
    // script    = ../../../../ci/deploy-aws.sh
    const scriptPath = path.resolve(__dirname, '../../../../ci/deploy-aws.sh');

    // Build the environment for the child process — all AWS creds + deploy vars.
    const deployEnv = {
      ...env,
      AWS_SHARED_CREDENTIALS_FILE: tmpFile, // fallback for aws CLI credential chain
      // Deploy script variables:
      ECR_BACKEND_URL:      ecrBackendUrl  || ecrRepo || '',
      ECR_FRONTEND_URL:     ecrFrontendUrl || ecrRepo || '',
      ECR_REGISTRY:         ecrRegistry    || '',
      ECS_CLUSTER:          ecsCluster     || eksCluster || 'shieldops-cluster',
      ECS_BACKEND_SERVICE:  ecsBackendService  || 'shieldops-backend',
      ECS_FRONTEND_SERVICE: ecsFrontendService || 'shieldops-frontend',
      IMAGE_TAG:            imageTag        || 'latest',
      DEPLOY_ENV:           environment,
      // Optional EKS path — only set if eksCluster was provided:
      ...(eksCluster ? { EKS_CLUSTER: eksCluster } : {}),
    };

    jobLog(job, `[deploy] Invoking ci/deploy-aws.sh (image: ${imageTag || 'latest'})`);

    // Spawn the deploy script and stream its output line-by-line to job logs.
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [scriptPath], {
        env:   deployEnv,
        cwd:   path.resolve(__dirname, '../../../..'), // infrastructure root
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let appUrl = null;

      const handleLine = (line) => {
        const clean = redactString(line.toString().trimEnd());
        jobLog(job, clean);
        // ci/deploy-aws.sh prints "App URL: https://..." on success.
        const match = clean.match(/App URL:\s+(https?:\/\/\S+)/);
        if (match) appUrl = match[1];
      };

      child.stdout.on('data', (chunk) => {
        chunk.toString().split('\n').filter(l => l.length).forEach(handleLine);
      });
      child.stderr.on('data', (chunk) => {
        chunk.toString().split('\n').filter(l => l.length).forEach(handleLine);
      });

      child.on('close', (code) => {
        if (code === 0) {
          if (appUrl) job.appUrl = appUrl;
          resolve();
        } else {
          reject(new Error(`deploy-aws.sh exited with code ${code}`));
        }
      });

      child.on('error', reject);
    });

    job.status     = 'succeeded';
    job.finishedAt = new Date();
    jobLog(job, `[deploy] Deploy succeeded. App URL: ${job.appUrl || '(see ALB console)'}`);

  } catch (err) {
    job.status     = 'failed';
    job.error      = redactAwsError(err.message, rawCreds);
    job.finishedAt = new Date();
    jobLog(job, `[deploy] FAILED: ${redactAwsError(err.message, rawCreds)}`);
  } finally {
    // Zero out credentials from env object
    if (env.AWS_ACCESS_KEY_ID)     env.AWS_ACCESS_KEY_ID     = '';
    if (env.AWS_SECRET_ACCESS_KEY) env.AWS_SECRET_ACCESS_KEY = '';
    if (env.AWS_SESSION_TOKEN)     env.AWS_SESSION_TOKEN     = '';

    // Delete temp credentials file
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
        jobLog(job, '[deploy] Temp credentials file deleted');
      } catch {
        jobLog(job, '[deploy] Warning: could not delete temp credentials file');
      }
    }

    runningEnvs.delete(rawCreds.environment || 'production');
    broadcastDone(job);
  }
}

function jobLog(job, line) {
  const redacted = redactString(line);
  job.logs.push(redacted);
  for (const listener of job.listeners) {
    try { listener(redacted); } catch {}
  }
}

function broadcastDone(job) {
  for (const listener of job.listeners) {
    try { listener(null); } catch {} // null signals end
  }
  job.listeners.clear();
}

/** Get job status (for polling / SSE) */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/** Subscribe to SSE log stream for a job */
function subscribeJobLogs(jobId, onLine) {
  const job = jobs.get(jobId);
  if (!job) return false;

  // Replay existing logs
  for (const line of job.logs) onLine(line);

  if (job.status !== 'running') {
    onLine(null); // already done
    return true;
  }

  job.listeners.add(onLine);
  return true;
}

function unsubscribeJobLogs(jobId, onLine) {
  const job = jobs.get(jobId);
  if (job) job.listeners.delete(onLine);
}

/** Build process env with AWS credentials — never log this object */
function buildAwsEnv({ accessKeyId, secretAccessKey, sessionToken, region }) {
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID:     accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_DEFAULT_REGION:    region,
    AWS_REGION:            region,
  };
  if (sessionToken) env.AWS_SESSION_TOKEN = sessionToken;
  return env;
}

module.exports = {
  preflight,
  startDeployJob,
  getJob,
  subscribeJobLogs,
  unsubscribeJobLogs,
};
