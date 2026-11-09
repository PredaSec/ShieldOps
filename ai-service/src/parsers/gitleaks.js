'use strict';

/**
 * Gitleaks parser — converts native JSON array to Finding[]
 * Gitleaks JSON schema: array of { RuleID, Description, File, StartLine, Match, Secret, ... }
 */

const SEVERITY_MAP = {
  // Gitleaks doesn't emit severity natively; secret exposure = HIGH by default
  // Override specific rule IDs if needed
  'generic-api-key': 'HIGH',
  'aws-access-token': 'CRITICAL',
  'aws-secret-access-key': 'CRITICAL',
  'github-pat': 'CRITICAL',
  'gitlab-pat': 'CRITICAL',
  'private-key': 'CRITICAL',
  'stripe-secret-key': 'CRITICAL',
  'twilio-api-key': 'HIGH',
  'sendgrid-api-key': 'HIGH',
};

function normalizeSeverity(ruleId) {
  return SEVERITY_MAP[ruleId] || 'HIGH';
}

/**
 * @param {any} raw - parsed JSON content of gitleaks.json
 * @returns {import('../types').Finding[]}
 */
function parse(raw) {
  if (!raw) return [];

  // Gitleaks JSON is an array; it may be null when no findings
  const items = Array.isArray(raw) ? raw : [];

  return items.map((item) => ({
    gate: 'G1-secrets',
    tool: 'gitleaks',
    ruleId: item.RuleID || item.ruleId || 'unknown',
    severity: normalizeSeverity(item.RuleID || item.ruleId || ''),
    title: item.Description || item.description || `Secret detected: ${item.RuleID || 'unknown'}`,
    location: item.File
      ? `${item.File}:${item.StartLine || 1}`
      : (item.file ? `${item.file}:${item.startLine || 1}` : 'unknown'),
    description: `Secret pattern matched by rule "${item.RuleID || item.ruleId}". Match: ${
      (item.Match || item.match || '').substring(0, 80)
    }`,
    remediation: 'Remove the secret from source code and git history. Rotate the exposed credential immediately. Use environment variables or a secrets manager (e.g. HashiCorp Vault, AWS Secrets Manager).',
  }));
}

module.exports = { parse };
