'use strict';

/**
 * Checkov parser — converts native JSON output to Finding[]
 * Schema: { results: { failed_checks: [{ check_id, check_type, check_result,
 *           resource, file_path, file_line_range, check: { name, id, severity } }] } }
 */

const SEVERITY_MAP = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
  UNKNOWN: 'LOW',
};

function normalizeSeverity(sev) {
  if (!sev) return 'MEDIUM';
  return SEVERITY_MAP[sev.toUpperCase()] || 'MEDIUM';
}

/**
 * @param {any} raw - parsed JSON content of checkov.json
 * @returns {import('../types').Finding[]}
 */
function parse(raw) {
  if (!raw) return [];

  const findings = [];

  // Checkov can return a single result object OR an array (for multi-type scans)
  const resultSets = Array.isArray(raw) ? raw : [raw];

  for (const resultSet of resultSets) {
    const failedChecks = resultSet?.results?.failed_checks || [];

    for (const check of failedChecks) {
      const checkDef = check.check || {};
      const lineRange = check.file_line_range || [1, 1];
      const location = check.file_path
        ? `${check.file_path}:${lineRange[0]}`
        : (check.repo_file_path ? `${check.repo_file_path}:${lineRange[0]}` : 'unknown');

      findings.push({
        gate: 'G4-iac',
        tool: 'checkov',
        ruleId: check.check_id || checkDef.id || 'unknown',
        severity: normalizeSeverity(checkDef.severity || check.severity),
        title: checkDef.name || check.check_id || 'IaC misconfiguration',
        location,
        description: `Resource: ${check.resource || 'unknown'}. Check type: ${check.check_type || 'unknown'}.`,
        remediation: checkDef.guideline || `Fix the ${check.check_id} policy violation in ${check.file_path || 'terraform'}.`,
      });
    }
  }

  return findings;
}

module.exports = { parse };
