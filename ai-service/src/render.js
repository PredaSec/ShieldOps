'use strict';

/**
 * render.js — converts an AI/fallback report JSON to human-readable Markdown
 */

const SEVERITY_EMOJI = {
  CRITICAL: 'X',
  HIGH: '!',
  MEDIUM: '~',
  LOW: '-',
  INFO: 'i',
  NONE: 'OK',
};

const RECOMMENDATION_STYLE = {
  BACK_TO_DEV: '## RECOMMENDATION: BACK TO DEV',
  DEPLOY: '## RECOMMENDATION: DEPLOY',
};

/**
 * @param {object} report - AI/fallback report object
 * @returns {string} markdown
 */
function render(report) {
  const now = report.generatedAt ? new Date(report.generatedAt).toUTCString() : new Date().toUTCString();
  const sourceLabel = report.source === 'gemini'
    ? `Google Gemini (${report.model || 'gemini-1.5-flash'})`
    : 'Rule-based Fallback (offline)';

  const sevBar = Object.entries(report.bySeverity || {})
    .filter(([, count]) => count > 0)
    .map(([sev, count]) => `${SEVERITY_EMOJI[sev] || sev} ${sev}: ${count}`)
    .join(' | ');

  const lines = [];

  lines.push(`# ShieldOps AI Security Analysis`);
  lines.push(``);
  lines.push(`**Stage:** ${(report.stage || 'unknown').toUpperCase()}  `);
  lines.push(`**Generated:** ${now}  `);
  lines.push(`**Analysis Source:** ${sourceLabel}  `);
  lines.push(`**Risk Score:** ${report.riskScore}/10 (${report.riskLevel})  `);
  lines.push(`**Total Findings:** ${report.totalFindings || 0}  `);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Recommendation banner
  lines.push(RECOMMENDATION_STYLE[report.recommendation] || `## RECOMMENDATION: ${report.recommendation}`);
  lines.push(``);
  lines.push(`**Rationale:** ${report.rationale || 'N/A'}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Severity summary
  lines.push(`## Severity Breakdown`);
  lines.push(``);
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  for (const [sev, count] of Object.entries(report.bySeverity || {})) {
    lines.push(`| ${sev} | ${count} |`);
  }
  lines.push(``);
  if (sevBar) {
    lines.push(`> ${sevBar}`);
    lines.push(``);
  }

  // Gate summaries
  if (report.gateSummaries && report.gateSummaries.length > 0) {
    lines.push(`## Gate Results`);
    lines.push(``);
    lines.push(`| Gate | Status | Findings | CRITICAL | HIGH |`);
    lines.push(`|------|--------|----------|----------|------|`);
    for (const g of report.gateSummaries) {
      const statusIcon = g.status === 'BLOCKED' ? 'BLOCKED' : (g.status === 'PASSED' ? 'PASSED' : 'WARNED');
      lines.push(`| ${g.gate} | ${statusIcon} | ${g.findingCount} | ${g.criticalCount || 0} | ${g.highCount || 0} |`);
    }
    lines.push(``);
  }

  // Top findings
  if (report.topFindings && report.topFindings.length > 0) {
    lines.push(`## Top Findings`);
    lines.push(``);
    for (const f of report.topFindings) {
      lines.push(`### [${f.severity}] ${f.tool}/${f.ruleId}`);
      lines.push(``);
      lines.push(`- **Title:** ${f.title}`);
      lines.push(`- **Location:** \`${f.location || 'unknown'}\``);
      if (f.description) {
        lines.push(`- **Description:** ${f.description.substring(0, 200)}`);
      }
      if (f.remediation) {
        lines.push(`- **Remediation:** ${f.remediation.substring(0, 200)}`);
      }
      lines.push(``);
    }
  }

  // Suggested fixes
  if (report.suggestedFixes && report.suggestedFixes.length > 0) {
    lines.push(`## Suggested Fixes (Priority Order)`);
    lines.push(``);
    for (let i = 0; i < report.suggestedFixes.length; i++) {
      lines.push(`${i + 1}. ${report.suggestedFixes[i]}`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*This report was generated automatically by ShieldOps AI Analysis. Human review is required before acting on the recommendation.*`);
  lines.push(``);

  return lines.join('\n');
}

module.exports = { render };
