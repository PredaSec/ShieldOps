'use strict';

/**
 * Trivy parser — handles trivy JSON output (fs scan + image scan)
 * Schema: { Results: [{ Target, Type, Vulnerabilities: [{ VulnerabilityID, PkgName, Severity,
 *           Title, Description, InstalledVersion, FixedVersion, PrimaryURL }] }] }
 * Also handles Misconfigurations: [{ ID, Type, Severity, Title, Description, Resolution }]
 */

const SEVERITY_MAP = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  UNKNOWN: 'INFO',
  NONE: 'INFO',
};

function normalizeSeverity(sev) {
  if (!sev) return 'INFO';
  return SEVERITY_MAP[sev.toUpperCase()] || 'MEDIUM';
}

/**
 * @param {any} raw - parsed JSON content of trivy-*.json
 * @param {string} [gate] - override gate label (default: G3-sca-image)
 * @returns {import('../types').Finding[]}
 */
function parse(raw, gate = 'G3-sca-image') {
  if (!raw || !raw.Results) return [];

  const findings = [];

  for (const result of raw.Results) {
    const target = result.Target || 'unknown';

    // Vulnerabilities
    for (const vuln of result.Vulnerabilities || []) {
      findings.push({
        gate,
        tool: 'trivy',
        ruleId: vuln.VulnerabilityID || 'unknown',
        severity: normalizeSeverity(vuln.Severity),
        title: vuln.Title || `${vuln.VulnerabilityID} in ${vuln.PkgName}`,
        location: `${target}:${vuln.PkgName}@${vuln.InstalledVersion || 'unknown'}`,
        description: (vuln.Description || '').substring(0, 500),
        remediation: vuln.FixedVersion
          ? `Upgrade ${vuln.PkgName} to version ${vuln.FixedVersion}. See: ${vuln.PrimaryURL || ''}`
          : `No fixed version available yet. Monitor ${vuln.PrimaryURL || vuln.VulnerabilityID}.`,
      });
    }

    // Misconfigurations
    for (const mc of result.Misconfigurations || []) {
      findings.push({
        gate,
        tool: 'trivy',
        ruleId: mc.ID || 'unknown',
        severity: normalizeSeverity(mc.Severity),
        title: mc.Title || mc.ID || 'Misconfiguration',
        location: target,
        description: (mc.Description || '').substring(0, 500),
        remediation: mc.Resolution || 'Review and fix the misconfiguration.',
      });
    }

    // Secrets (trivy --scanners secret)
    for (const secret of result.Secrets || []) {
      findings.push({
        gate,
        tool: 'trivy',
        ruleId: secret.RuleID || 'secret',
        severity: 'HIGH',
        title: secret.Title || `Secret: ${secret.Category || 'unknown'}`,
        location: `${target}:${secret.StartLine || 1}`,
        description: (secret.Match || '').substring(0, 200),
        remediation: 'Remove the secret and rotate it immediately.',
      });
    }
  }

  return findings;
}

module.exports = { parse };
