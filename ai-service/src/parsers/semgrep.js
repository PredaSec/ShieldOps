'use strict';

/**
 * Semgrep parser — handles BOTH SARIF and native JSON output
 * SARIF: { runs[].results[].{ ruleId, level, message, locations } }
 * JSON:  { results: [{ check_id, severity, message, path, start.line }] }
 */

const SARIF_LEVEL_MAP = {
  error: 'HIGH',
  warning: 'MEDIUM',
  note: 'LOW',
  none: 'INFO',
};

const JSON_SEVERITY_MAP = {
  ERROR: 'HIGH',
  WARNING: 'MEDIUM',
  INFO: 'LOW',
  // Semgrep custom severity via metadata
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

function normalizeSarifLevel(level) {
  return SARIF_LEVEL_MAP[level] || 'MEDIUM';
}

function normalizeJsonSeverity(sev) {
  if (!sev) return 'MEDIUM';
  const upper = sev.toUpperCase();
  return JSON_SEVERITY_MAP[upper] || 'MEDIUM';
}

/**
 * Detect if content looks like SARIF (has $schema or runs[].tool.driver)
 */
function isSarif(raw) {
  return raw && (raw.$schema || (Array.isArray(raw.runs) && raw.runs[0]?.tool));
}

function parseSarif(raw) {
  const findings = [];
  for (const run of raw.runs || []) {
    const rules = {};
    for (const rule of run.tool?.driver?.rules || []) {
      rules[rule.id] = rule;
    }
    for (const result of run.results || []) {
      const ruleId = result.ruleId || 'unknown';
      const rule = rules[ruleId] || {};
      // Check for custom severity in properties or tags
      const metaSev = rule.properties?.['security-severity'] ||
        rule.properties?.severity ||
        result.properties?.severity;
      const level = result.level || 'warning';
      const location = result.locations?.[0]?.physicalLocation;
      const filepath = location?.artifactLocation?.uri || 'unknown';
      const line = location?.region?.startLine || 1;

      // Map security-severity (CVSS float) to level
      let severity;
      if (metaSev && typeof metaSev === 'string' && JSON_SEVERITY_MAP[metaSev.toUpperCase()]) {
        severity = JSON_SEVERITY_MAP[metaSev.toUpperCase()];
      } else if (metaSev && !isNaN(parseFloat(metaSev))) {
        const score = parseFloat(metaSev);
        if (score >= 9) severity = 'CRITICAL';
        else if (score >= 7) severity = 'HIGH';
        else if (score >= 4) severity = 'MEDIUM';
        else severity = 'LOW';
      } else {
        severity = normalizeSarifLevel(level);
      }

      findings.push({
        gate: 'G2-sast',
        tool: 'semgrep',
        ruleId,
        severity,
        title: result.message?.text || rule.shortDescription?.text || ruleId,
        location: `${filepath}:${line}`,
        description: result.message?.text || rule.fullDescription?.text || '',
        remediation: rule.help?.text || rule.help?.markdown || 'Review and fix the flagged code pattern.',
      });
    }
  }
  return findings;
}

function parseJson(raw) {
  const results = raw.results || [];
  return results.map((r) => {
    // Semgrep metadata may contain extra info
    const extra = r.extra || {};
    const metaSev = extra.metadata?.severity || extra.metadata?.['security-severity'];
    let severity;
    if (metaSev) {
      severity = normalizeJsonSeverity(metaSev);
    } else {
      severity = normalizeJsonSeverity(extra.severity || r.severity);
    }
    return {
      gate: 'G2-sast',
      tool: 'semgrep',
      ruleId: r.check_id || 'unknown',
      severity,
      title: extra.message || r.message || r.check_id || 'unknown',
      location: `${r.path || 'unknown'}:${r.start?.line || 1}`,
      description: extra.message || r.message || '',
      remediation: extra.metadata?.fix || extra.fix || 'Review and fix the flagged code pattern.',
    };
  });
}

/**
 * @param {any} raw - parsed JSON/SARIF content
 * @returns {import('../types').Finding[]}
 */
function parse(raw) {
  if (!raw) return [];
  if (isSarif(raw)) return parseSarif(raw);
  return parseJson(raw);
}

module.exports = { parse };
