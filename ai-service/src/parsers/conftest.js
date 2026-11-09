'use strict';

/**
 * Conftest/OPA parser — converts conftest JSON output to Finding[]
 * Schema: array of { filename, warnings: [{msg}], failures: [{msg}], successes: [{msg}] }
 */

/**
 * @param {any} raw - parsed JSON content of conftest.json
 * @returns {import('../types').Finding[]}
 */
function parse(raw) {
  if (!raw) return [];

  const findings = [];

  // conftest --output json produces an array of result objects
  const results = Array.isArray(raw) ? raw : [raw];

  for (const result of results) {
    const filename = result.filename || '-';

    // Failures = policy violations (block by policy = HIGH severity)
    for (const failure of result.failures || []) {
      const msg = typeof failure === 'string' ? failure : (failure.msg || JSON.stringify(failure));
      // Extract rule ID from message if formatted as "RULE-XXX: ..."
      const ruleMatch = msg.match(/^([A-Z]+-\d+|[A-Z_]+):\s*/);
      const ruleId = ruleMatch ? ruleMatch[1] : 'opa-policy-violation';
      const title = ruleMatch ? msg.slice(ruleMatch[0].length).split('\n')[0] : msg.split('\n')[0];

      findings.push({
        gate: 'G5-policy',
        tool: 'conftest',
        ruleId,
        severity: 'HIGH',
        title: title.substring(0, 200),
        location: filename,
        description: msg.substring(0, 500),
        remediation: 'Fix the Kubernetes/Helm manifest to comply with the OPA policy. Review policy/opa/ for guidance.',
      });
    }

    // Warnings = informational findings (MEDIUM severity)
    for (const warning of result.warnings || []) {
      const msg = typeof warning === 'string' ? warning : (warning.msg || JSON.stringify(warning));
      const ruleMatch = msg.match(/^([A-Z]+-\d+|[A-Z_]+):\s*/);
      const ruleId = ruleMatch ? ruleMatch[1] : 'opa-policy-warning';
      const title = ruleMatch ? msg.slice(ruleMatch[0].length).split('\n')[0] : msg.split('\n')[0];

      findings.push({
        gate: 'G5-policy',
        tool: 'conftest',
        ruleId,
        severity: 'MEDIUM',
        title: title.substring(0, 200),
        location: filename,
        description: msg.substring(0, 500),
        remediation: 'Review and address the OPA policy warning.',
      });
    }
  }

  return findings;
}

module.exports = { parse };
