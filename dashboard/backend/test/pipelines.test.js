'use strict';

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  on:    jest.fn(),
}));

jest.mock('../src/services/notify', () => ({
  send: jest.fn().mockResolvedValue({ recipients: ['test@example.com'] }),
}));

const request  = require('supertest');
const express  = require('express');
const pool     = require('../src/db/pool');
const pipelinesRouter = require('../src/routes/pipelines');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pipelines', pipelinesRouter);
  return app;
}

describe('GET /api/pipelines', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns pipeline list', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, gitlab_pipeline_id: 42, branch: 'main', status: 'success', gates_passed: 7, gates_failed: 0 },
      ],
    });
    const app = buildApp();
    const res = await request(app).get('/api/pipelines');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(1);
  });

  test('handles DB error gracefully', async () => {
    pool.query.mockRejectedValueOnce(new Error('DB connection failed'));
    const app = buildApp();
    const res = await request(app).get('/api/pipelines');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/pipelines/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns pipeline detail', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, gitlab_pipeline_id: 42, branch: 'main', status: 'success' }] })
      .mockResolvedValueOnce({ rows: [{ id: 10, gate_name: 'g1-gitleaks', tool: 'gitleaks', status: 'success' }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, content_md: '# Report', recommendation: 'DEPLOY' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/pipelines/1');
    expect(res.status).toBe(200);
    expect(res.body.pipeline.id).toBe(1);
    expect(res.body.gates.length).toBe(1);
    expect(res.body.ai_report.recommendation).toBe('DEPLOY');
  });

  test('returns 404 for missing pipeline', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await request(app).get('/api/pipelines/999');
    expect(res.status).toBe(404);
  });

  test('rejects non-integer id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/pipelines/not-a-number');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/pipelines/:id/approve', () => {
  beforeEach(() => jest.clearAllMocks());

  test('approves pipeline and returns status', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .post('/api/pipelines/1/approve')
      .send({ comment: 'Looks good', approved_by: 'alice' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  test('rejects non-integer pipeline id', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/pipelines/abc/approve')
      .send({});
    expect(res.status).toBe(400);
  });

  test('rejects overly long comment', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/pipelines/1/approve')
      .send({ comment: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/pipelines/:id/reject', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects pipeline and returns status', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .post('/api/pipelines/5/reject')
      .send({ comment: 'Security issues found', approved_by: 'bob' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });
});
