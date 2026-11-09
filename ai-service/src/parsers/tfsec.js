'use strict';

/**
 * tfsec parser — converts native JSON output to Finding[]
 * Schema: { results: [{ rule_id, rule_description, severity, description,
 *           location: { filename, start_line, end_line }, links, impact, resolution }] }
 */

const SEVERITY_MAP = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
  WARNING: 'MEDIUM',
};

function normalizeSeverity(sev) {
  if (!sev) return 'MEDIUM';
  return SEVERITY_MAP[sev.toUpperCase()] || 'MEDIUM';
}

/**
 * @param {any} raw - parsed JSON content of tfsec.json
 * @returns {import('../types').Finding[]}
 */
function parse(raw) {
  if (!raw) return [];

  const results = raw.results || [];

  return results.map((result) => {
    const loc = result.location || {};
    const location = loc.filename
      ? `${loc.filename}:${loc.start_line || 1}`
      : 'unknown';

    return {
      gate: 'G4-iac',
      tool: 'tfsec',
      ruleId: result.rule_id || result.long_id || 'unknown',
      severity: normalizeSeverity(result.severity),
      title: result.rule_description || result.rule_id || 'tfsec finding',
      location,
      description: [result.description || '', result.impact || ''].filter(Boolean).join(' Impact: ').substring(0, 500),
      remediation: result.resolution || (result.links || []).join(' ') || 'Fix the Terraform misconfiguration.',
    };
  });
}

module.exports = { parse };
