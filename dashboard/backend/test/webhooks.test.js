'use strict';

/**
 * GitLab webhook handler tests.
 * Uses supertest to drive the Express router, with DB calls mocked.
 */

// Mock the DB pool before requiring the app
jest.mock('../src/db/pool', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
  on:    jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const webhooksRouter = require('../src/routes/webhooks');

function buildApp(token) {
  const app = express();
  app.use(express.json());
  if (token) process.env.GITLAB_WEBHOOK_TOKEN = token;
  else       delete process.env.GITLAB_WEBHOOK_TOKEN;
  app.use('/api/webhooks', webhooksRouter);
  return app;
}

const samplePipelinePayload = {
  object_kind: 'pipeline',
  object_attributes: {
    id:          42,
    sha:         'abc123def456',
    ref:         'main',
    status:      'success',
    created_at:  '2024-01-01T00:00:00Z',
    finished_at: '2024-01-01T00:05:00Z',
  },
  commit: { id: 'abc123def456', message: 'Fix bug' },
  builds: [
    { name: 'g1-gitleaks',   status: 'success' },
    { name: 'g2-semgrep',    status: 'success' },
    { name: 'g3-trivy-image',status: 'failed'  },
  ],
};

describe('POST /api/webhooks/gitlab', () => {
  afterEach(() => jest.clearAllMocks());

  test('accepts valid token and pipeline event', async () => {
    const app = buildApp('test-secret');
    const res = await request(app)
      .post('/api/webhooks/gitlab')
      .set('X-Gitlab-Token', 'test-secret')
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .send(samplePipelinePayload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('rejects wrong token with 401', async () => {
    const app = buildApp('correct-secret');
    const res = await request(app)
      .post('/api/webhooks/gitlab')
      .set('X-Gitlab-Token', 'wrong-secret')
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .send(samplePipelinePayload);
    expect(res.status).toBe(401);
  });

  test('rejects missing token with 401', async () => {
    const app = buildApp('correct-secret');
    const res = await request(app)
      .post('/api/webhooks/gitlab')
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .send(samplePipelinePayload);
    expect(res.status).toBe(401);
  });

  test('skips non-pipeline events', async () => {
    const app = buildApp('test-secret');
    const res = await request(app)
      .post('/api/webhooks/gitlab')
      .set('X-Gitlab-Token', 'test-secret')
      .set('X-Gitlab-Event', 'Push Hook')
      .send({ ref: 'main' });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
  });

  test('works without token set (dev mode)', async () => {
    const app = buildApp(undefined);
    const res = await request(app)
      .post('/api/webhooks/gitlab')
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .send(samplePipelinePayload);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('maps GitLab statuses correctly', async () => {
    const pool = require('../src/db/pool');
    const app  = buildApp(undefined);
    await request(app)
      .post('/api/webhooks/gitlab')
      .set('X-Gitlab-Event', 'Pipeline Hook')
      .send({
        ...samplePipelinePayload,
        object_attributes: { ...samplePipelinePayload.object_attributes, status: 'running' },
      });
    // Should have called pool.query with 'running' status
    expect(pool.query).toHaveBeenCalled();
    const firstCall = pool.query.mock.calls[0];
    expect(firstCall[1]).toContain('running');
  });
});
