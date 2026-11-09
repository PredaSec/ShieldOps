'use strict';

/**
 * AWS preflight and credential redaction tests.
 * AWS CLI calls are mocked — no real AWS calls made.
 */

const { redactString, redactObject } = require('../src/middleware/redact');

// We test the preflight logic by mocking execFileAsync at the child_process level
jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn:    jest.fn(),
}));

const { execFile } = require('child_process');
const { promisify } = require('util');

// Make execFile return a promise-compatible form
function mockExecFile(impl) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    // promisify wraps the last arg as callback
    impl(cmd, args, opts).then(
      (val) => cb(null, val),
      (err) => cb(err)
    );
  });
}

// We load awsDeploy after mocking
const awsDeploy = require('../src/services/awsDeploy');

const VALID_CREDS = {
  accessKeyId:     'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region:          'us-east-1',
};

describe('AWS preflight', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns credentials_valid=true when STS succeeds', async () => {
    mockExecFile(async (cmd, args) => {
      if (args.includes('get-caller-identity'))
        return { stdout: JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/test' }), stderr: '' };
      if (args.includes('get-user'))
        return { stdout: '{}', stderr: '' };
      if (args.includes('--version'))
        return { stdout: 'aws-cli/2.x.x', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await awsDeploy.preflight(VALID_CREDS);
    const credsCheck = result.checks.find(c => c.name === 'credentials_valid');
    expect(credsCheck).toBeDefined();
    expect(credsCheck.passed).toBe(true);
  });

  test('returns credentials_valid=false and stops when STS fails', async () => {
    mockExecFile(async () => {
      const err = new Error('InvalidClientTokenId');
      err.stderr = 'An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation';
      throw err;
    });

    const result = await awsDeploy.preflight(VALID_CREDS);
    const credsCheck = result.checks.find(c => c.name === 'credentials_valid');
    expect(credsCheck.passed).toBe(false);
    // Should return early — no further checks beyond credentials_valid
    expect(result.checks.length).toBe(1);
  });

  test('allPassed is false when any check fails', async () => {
    // STS ok, EKS fails
    mockExecFile(async (cmd, args) => {
      if (args.includes('get-caller-identity'))
        return { stdout: JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/test' }), stderr: '' };
      if (args.includes('describe-cluster')) {
        const err = new Error('Cluster not found');
        err.stderr = 'ResourceNotFoundException';
        throw err;
      }
      return { stdout: '{}', stderr: '' };
    });

    const result = await awsDeploy.preflight({ ...VALID_CREDS, eksCluster: 'my-cluster' });
    const eksCheck = result.checks.find(c => c.name === 'eks_cluster_reachable');
    expect(eksCheck.passed).toBe(false);
  });

  test('detail field does not contain raw secret key', async () => {
    const errMsg = `AccessDenied for key ${VALID_CREDS.secretAccessKey}`;
    mockExecFile(async () => {
      const err = new Error(errMsg);
      err.stderr = errMsg;
      throw err;
    });

    const result = await awsDeploy.preflight(VALID_CREDS);
    const detail = result.checks[0].detail;
    // The raw 40-char secret must not appear in the detail
    expect(detail).not.toContain(VALID_CREDS.secretAccessKey);
  });

  test('detail field does not expose full access key ID', async () => {
    mockExecFile(async (cmd, args) => {
      if (args.includes('get-caller-identity'))
        return { stdout: JSON.stringify({ Account: '123456789012', Arn: `arn:aws:iam::123456789012:user/${VALID_CREDS.accessKeyId}` }), stderr: '' };
      return { stdout: '{}', stderr: '' };
    });
    const result = await awsDeploy.preflight(VALID_CREDS);
    const credsDetail = result.checks.find(c => c.name === 'credentials_valid')?.detail || '';
    // Full 20-char key must be redacted to AKIA…****
    expect(credsDetail).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
  });
});

describe('AWS credential redaction (unit)', () => {
  test('redactString masks full AKIA key in log line', () => {
    const line = `[deploy] Credentials: AKIAIOSFODNN7EXAMPLE for region us-east-1`;
    const out  = redactString(line);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('AKIA…****');
  });

  test('redactString masks secret in env-style line', () => {
    const line = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and region=us-east-1';
    const out  = redactString(line);
    expect(out).not.toContain('wJalrXUtnFEMI');
    expect(out).toContain('**REDACTED**');
  });

  test('startDeployJob returns a jobId without exposing creds', () => {
    const result = awsDeploy.startDeployJob({
      ...VALID_CREDS,
      environment: 'staging-test-' + Date.now(), // unique env to avoid conflict
    });
    expect(result.jobId).toBeDefined();
    expect(typeof result.jobId).toBe('string');
    // jobId should not contain any credential material
    expect(result.jobId).not.toContain(VALID_CREDS.accessKeyId);
    expect(result.jobId).not.toContain(VALID_CREDS.secretAccessKey);
  });

  test('getJob logs are redacted', (done) => {
    const env = 'test-env-' + Date.now();
    const { jobId } = awsDeploy.startDeployJob({ ...VALID_CREDS, environment: env });
    // Wait briefly for first log line
    setTimeout(() => {
      const job = awsDeploy.getJob(jobId);
      if (job && job.logs.length > 0) {
        for (const line of job.logs) {
          expect(line).not.toContain(VALID_CREDS.secretAccessKey);
          // Access key may appear as AKIA…**** but not as full key
          expect(line).not.toMatch(/AKIAIOSFODNN7EXAMPLE(?!…\*{4})/);
        }
      }
      done();
    }, 200);
  });
});

describe('AWS routes validation', () => {
  // Mock DB for routes
  jest.mock('../src/db/pool', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    on:    jest.fn(),
  }));

  const request = require('supertest');
  const app     = require('../src/index');

  // Get a valid JWT token
  let token;
  beforeAll(async () => {
    process.env.DASHBOARD_USER     = 'admin';
    process.env.DASHBOARD_PASSWORD = 'testpass';
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'testpass' });
    token = res.body.token;
  });

  test('POST /api/aws/validate requires auth', async () => {
    const res = await request(app)
      .post('/api/aws/validate')
      .send(VALID_CREDS);
    expect(res.status).toBe(401);
  });

  test('POST /api/aws/validate rejects invalid key format', async () => {
    const res = await request(app)
      .post('/api/aws/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_CREDS, accessKeyId: 'INVALID-KEY' });
    expect(res.status).toBe(400);
  });

  test('POST /api/aws/deploy requires auth', async () => {
    const res = await request(app)
      .post('/api/aws/deploy')
      .send(VALID_CREDS);
    expect(res.status).toBe(401);
  });

  test('GET /api/aws/deploy/:jobId requires auth', async () => {
    const res = await request(app)
      .get('/api/aws/deploy/some-job-id');
    expect(res.status).toBe(401);
  });

  test('GET /api/healthz returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
