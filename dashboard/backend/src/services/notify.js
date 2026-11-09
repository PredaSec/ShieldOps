'use strict';

/**
 * Notification service — Nodemailer SMTP.
 * Recipients configured via NOTIFICATION_RECIPIENTS env var (comma-separated)
 * or fetched from DB settings.
 */

const nodemailer = require('nodemailer');
const pool       = require('../db/pool');

function createTransport() {
  // Support SMTP_URL (e.g. smtp://user:pass@host:587) or individual vars
  if (process.env.SMTP_URL) {
    return nodemailer.createTransport(process.env.SMTP_URL);
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'localhost',
    port:   parseInt(process.env.SMTP_PORT || '1025', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    } : undefined,
  });
}

async function getRecipients(overrideList) {
  if (overrideList && overrideList.length > 0) return overrideList;

  // Try env var first
  if (process.env.NOTIFICATION_RECIPIENTS) {
    return process.env.NOTIFICATION_RECIPIENTS.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Fallback to DB
  try {
    const { rows } = await pool.query(
      "SELECT value FROM settings WHERE key = 'notification_recipients'"
    );
    if (rows.length > 0) return rows[0].value;
  } catch {}

  return ['ops@example.com'];
}

async function send({ pipeline_id, subject, body: msgBody, recipients: overrideRecipients }) {
  const recipients = await getRecipients(overrideRecipients);
  const from       = process.env.SMTP_FROM || 'shieldops@example.com';

  const transport = createTransport();

  try {
    const info = await transport.sendMail({
      from,
      to:      recipients.join(', '),
      subject,
      text:    msgBody,
    });

    // Log notification
    if (pipeline_id) {
      await pool.query(`
        INSERT INTO notifications (pipeline_id, channel, recipients, sent_at, status)
        VALUES ($1, 'email', $2, NOW(), 'sent')
      `, [pipeline_id, recipients]).catch(() => {});
    }

    return { recipients, messageId: info.messageId };
  } catch (err) {
    // Log failed notification
    if (pipeline_id) {
      await pool.query(`
        INSERT INTO notifications (pipeline_id, channel, recipients, status, error)
        VALUES ($1, 'email', $2, 'failed', $3)
      `, [pipeline_id, recipients, err.message]).catch(() => {});
    }
    throw err;
  }
}

module.exports = { send };
