'use strict';

/**
 * OWASP ZAP parser — converts ZAP JSON output to Finding[]
 * Schema: { site: [{ @name, @host, alerts: [{ pluginid, alert, name, riskcode, confidence,
 *           riskdesc, desc, solution, instances: [{ uri, method, evidence }] }] }] }
 * riskcode: 3=High, 2=Medium, 1=Low, 0=Informational
 */

const RISK_CODE_MAP = {
  3: 'HIGH',
  2: 'MEDIUM',
  1: 'LOW',
  0: 'INFO',
};

const RISKDESC_MAP = {
  'High (High)': 'CRITICAL',
  'High (Medium)': 'HIGH',
  'High (Low)': 'HIGH',
  'Medium (High)': 'MEDIUM',
  'Medium (Medium)': 'MEDIUM',
  'Medium (Low)': 'MEDIUM',
  'Low (High)': 'LOW',
  'Low (Medium)': 'LOW',
  'Low (Low)': 'LOW',
  'Informational (High)': 'INFO',
  'Informational (Medium)': 'INFO',
  'Informational (Low)': 'INFO',
  'Informational (Informational)': 'INFO',
};

function normalizeSeverity(alert) {
  // Try riskdesc first (more precise with confidence)
  if (alert.riskdesc && RISKDESC_MAP[alert.riskdesc]) {
    return RISKDESC_MAP[alert.riskdesc];
  }
  // Fall back to riskcode
  const code = parseInt(alert.riskcode, 10);
  return RISK_CODE_MAP[code] || 'INFO';
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {any} raw - parsed JSON content of zap-report.json
 * @returns {import('../types').Finding[]}
 */
function parse(raw) {
  if (!raw) return [];

  const findings = [];

  // ZAP JSON has a 'site' array
  const sites = raw.site || [];

  for (const site of sites) {
    const host = site['@host'] || site['@name'] || 'unknown';

    for (const alert of site.alerts || []) {
      const severity = normalizeSeverity(alert);
      const instances = alert.instances || alert.instance || [];
      const firstInstance = Array.isArray(instances) ? instances[0] : instances;
      const uri = firstInstance?.uri || firstInstance?.['uri'] || host;
      const method = firstInstance?.method || 'GET';

      findings.push({
        gate: 'G7-dast',
        tool: 'zap',
        ruleId: alert.pluginid || alert.alertRef || 'unknown',
        severity,
        title: alert.name || alert.alert || 'ZAP finding',
        location: `${method} ${uri}`,
        description: stripHtml(alert.desc || alert.description || '').substring(0, 500),
        remediation: stripHtml(alert.solution || '').substring(0, 500) || 'Review and fix the web application vulnerability.',
      });
    }
  }

  return findings;
}

module.exports = { parse };
