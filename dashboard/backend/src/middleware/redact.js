'use strict';

/**
 * Credential redaction utilities.
 *
 * Security requirement (plan 5.4, non-negotiable):
 *   - Never persist raw AWS credentials to DB or logs.
 *   - Redact access keys / secrets from ALL log and error output.
 */

// Matches AWS Access Key IDs (20 uppercase alphanumeric chars starting with AKIA/ASIA/AROA/AIDA/ANPA/ANVA)
const AWS_KEY_RE  = /(AKIA|ASIA|AROA|AIDA|ANPA|ANVA)[A-Z0-9]{16}/g;
// Matches anything that looks like a secret key after a known field name
const AWS_SECRET_RE = /(?<=(aws_secret_access_key|SecretAccessKey|secret_access_key|secretAccessKey)[=:\s"']+)[A-Za-z0-9/+]{40}/gi;
// Session tokens are very long base64; match common field names
const SESSION_RE  = /(?<=(aws_session_token|SessionToken|session_token|sessionToken)[=:\s"']+)[A-Za-z0-9/+=]{100,}/gi;

/**
 * Redact sensitive AWS credentials from a string.
 * Access Key IDs are partially preserved for traceability: AKIA…****
 */
function redactString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(AWS_KEY_RE,    (m) => m.slice(0, 4) + '…****')
    .replace(AWS_SECRET_RE, '**REDACTED**')
    .replace(SESSION_RE,    '**REDACTED**');
}

/**
 * Deep-redact an object (for logging).
 * Never mutates the original object.
 */
function redactObject(obj, depth = 0) {
  if (depth > 10) return '[deep]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(v => redactObject(v, depth + 1));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (lk.includes('secret') || lk.includes('password') || lk.includes('token') || lk.includes('session')) {
        out[k] = '**REDACTED**';
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

/**
 * Wrap console methods to auto-redact — call once at startup.
 */
function installGlobalRedaction() {
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  const safeArgs = (args) => args.map(a =>
    typeof a === 'string' ? redactString(a) : a
  );

  console.log   = (...a) => origLog(...safeArgs(a));
  console.warn  = (...a) => origWarn(...safeArgs(a));
  console.error = (...a) => origError(...safeArgs(a));
}

module.exports = { redactString, redactObject, installGlobalRedaction };
