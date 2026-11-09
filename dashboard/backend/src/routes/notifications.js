'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const pool   = require('../db/pool');
const notify = require('../services/notify');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/** POST /api/notifications/send */
router.post('/send',
  body('subject').isString().trim().notEmpty().isLength({ max: 300 }),
  body('body').isString().trim().notEmpty().isLength({ max: 10000 }),
  body('pipeline_id').optional().isInt({ min: 1 }),
  body('recipients').optional().isArray(),
  validate,
  async (req, res) => {
    const { subject, body: msgBody, pipeline_id, recipients } = req.body;
    try {
      const result = await notify.send({ subject, body: msgBody, pipeline_id, recipients });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[notifications] send error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

/** GET /api/notifications — list recent notifications */
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100'
    );
    res.json(rows);
  } catch (err) {
    console.error('[notifications] list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
