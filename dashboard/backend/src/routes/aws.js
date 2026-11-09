'use strict';

/**
 * AWS Deployment Console Routes — Plan 5.4
 *
 * POST /api/aws/validate     — preflight checklist
 * POST /api/aws/deploy       — launch deploy job (returns jobId)
 * GET  /api/aws/deploy/:id   — SSE log stream + status
 *
 * ALL routes require auth (requireAuth middleware).
 * Rate-limited to prevent credential stuffing.
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const { requireAuth }  = require('../middleware/auth');
const awsDeploy        = require('../services/awsDeploy');
const { redactObject } = require('../middleware/redact');

const router = express.Router();

const awsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max:      10,
  message:  { error: 'Too many AWS API requests — slow down' },
  standardHeaders: true,
  legacyHeaders:   false,
});

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/** Validate AWS credential fields from body */
const awsCredsValidators = [
  body('accessKeyId')
    .isString().trim().notEmpty()
    .matches(/^(AKIA|ASIA|AROA|AIDA|ANPA|ANVA)[A-Z0-9]{16}$/)
    .withMessage('Invalid AWS Access Key ID format'),
  body('secretAccessKey')
    .isString().trim().notEmpty()
    .isLength({ min: 40, max: 45 })
    .withMessage('Invalid AWS Secret Access Key length'),
  body('sessionToken')
    .optional({ nullable: true })
    .isString(),
  body('region')
    .optional()
    .isString()
    .matches(/^[a-z]{2}-[a-z]+-\d+$/)
    .withMessage('Invalid AWS region format'),
  body('environment')
    .optional()
    .isIn(['production', 'staging'])
    .withMessage('Environment must be production or staging'),
  body('ecrRepo')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 256 }),
  body('eksCluster')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 256 }),
];

/**
 * POST /api/aws/validate
 * Runs preflight checklist.  Returns green/red per check.
 * Deploy button on the frontend is disabled until allPassed === true.
 */
router.post('/validate',
  requireAuth,
  awsLimiter,
  awsCredsValidators,
  validate,
  async (req, res) => {
    // NOTE: intentionally log redacted representation, never raw creds
    console.log('[aws/validate] Preflight requested by', req.user?.sub,
      'key:', req.body.accessKeyId?.slice(0, 4) + '…****',
      'region:', req.body.region || 'us-east-1'
    );

    try {
      const result = await awsDeploy.preflight(req.body);
      const allPassed = result.checks.every(c => c.passed);
      res.json({ ...result, allPassed });
    } catch (err) {
      console.error('[aws/validate] error:', err.message);
      res.status(500).json({ error: 'Preflight failed', detail: err.message });
    }
  }
);

/**
 * POST /api/aws/deploy
 * Launches deploy job.  Frontend must call /validate first and only enable
 * this button when allPassed === true.
 */
router.post('/deploy',
  requireAuth,
  awsLimiter,
  awsCredsValidators,
  validate,
  async (req, res) => {
    console.log('[aws/deploy] Deploy requested by', req.user?.sub,
      'env:', req.body.environment || 'production',
      'key:', req.body.accessKeyId?.slice(0, 4) + '…****'
    );

    try {
      const { jobId } = awsDeploy.startDeployJob(req.body);
      // Credentials are now held only in the async job closure — not stored anywhere else
      res.json({ jobId, status: 'running', message: 'Deploy job started' });
    } catch (err) {
      if (err.code === 'CONFLICT') {
        return res.status(409).json({ error: err.message });
      }
      console.error('[aws/deploy] error:', err.message);
      res.status(500).json({ error: 'Failed to start deploy job' });
    }
  }
);

/**
 * GET /api/aws/deploy/:jobId
 * Server-Sent Events log stream.
 * Also accepts ?poll=1 for simple HTTP polling (returns current state).
 */
router.get('/deploy/:jobId',
  requireAuth,
  param('jobId').isUUID(),
  validate,
  (req, res) => {
    const { jobId } = req.params;
    const job       = awsDeploy.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Polling mode
    if (req.query.poll === '1') {
      return res.json({
        jobId:     job.id,
        status:    job.status,
        logs:      job.logs,
        appUrl:    job.appUrl,
        error:     job.error,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      });
    }

    // SSE streaming mode
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    function sendLine(line) {
      if (line === null) {
        // Job finished — send status event
        res.write(`event: done\ndata: ${JSON.stringify({ status: job.status, appUrl: job.appUrl, error: job.error })}\n\n`);
        res.end();
      } else {
        res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
      }
    }

    const ok = awsDeploy.subscribeJobLogs(jobId, sendLine);
    if (!ok) {
      res.write('event: error\ndata: {"error":"Job not found"}\n\n');
      res.end();
      return;
    }

    req.on('close', () => {
      awsDeploy.unsubscribeJobLogs(jobId, sendLine);
    });
  }
);

module.exports = router;
