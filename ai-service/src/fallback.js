'use strict';

/**
 * fallback.js — rule-based analysis when Gemini is unavailable
 *
 * Decision logic:
 *   - BACK_TO_DEV if any CRITICAL finding exists, OR any blocking gate failure
 *   - DEPLOY if only HIGH/MEDIUM/LOW/INFO (with caveats)
 *
 * Output schema matches the Gemini schema:
 * {
 *   source: "fallback",
 *   riskScore: 0-10,
 *   riskLevel: "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"NONE",
 *   recommendation: "DEPLOY"|"BACK_TO_DEV",
 *   rationale: string,
 *   topFindings: Finding[],
 *   suggestedFixes: string[],
 *   gateSummaries: [{ gate, status, findingCount, criticalCount }],
 *   generatedAt: ISO timestamp
 * }
 */

function computeRiskScore(summary) {
  // Weighted score: CRITICAL=10, HIGH=5, MEDIUM=2, LOW=0.5 (capped at 10)
  const { bySeverity } = summary;
  const raw =
    (bySeverity.CRITICAL || 0) * 10 +
    (bySeverity.HIGH || 0) * 5 +
    (bySeverity.MEDIUM || 0) * 2 +
    (bySeverity.LOW || 0) * 0.5;
  return Math.min(10, parseFloat(raw.toFixed(1)));
}

function computeRiskLevel(score, summary) {
  if (summary.bySeverity.CRITICAL > 0) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (score >= 1) return 'LOW';
  return 'NONE';
}

/**
 * @param {import('./types').ScanSummary} summary
 * @param {string} stage - 'staging' | 'prod'
 * @returns {object} AI-schema-compatible report
 */
function analyze(summary, stage = 'staging') {
  const riskScore = computeRiskScore(summary);
  const riskLevel = computeRiskLevel(riskScore, summary);

  const hasCritical = summary.bySeverity.CRITICAL > 0;
  const hasBlockingGate = Object.values(summary.byGate).some((g) => g.blocking);
  const recommendation = (hasCritical || hasBlockingGate) ? 'BACK_TO_DEV' : 'DEPLOY';

  // Build rationale
  const reasons = [];
  if (hasCritical) {
    reasons.push(`${summary.bySeverity.CRITICAL} CRITICAL finding(s) detected — mandatory remediation required before deployment`);
  }
  if (hasBlockingGate) {
    const blockingGates = Object.entries(summary.byGate)
      .filter(([, g]) => g.blocking)
      .map(([name]) => name);
    reasons.push(`Blocking gate failure(s): ${blockingGates.join(', ')}`);
  }
  if (!hasCritical && !hasBlockingGate) {
    reasons.push(`No CRITICAL findings; ${summary.bySeverity.HIGH || 0} HIGH, ${summary.bySeverity.MEDIUM || 0} MEDIUM findings present`);
    if (summary.bySeverity.HIGH > 5) {
      reasons.push('High count of HIGH-severity findings warrants developer review');
    }
  }

  // Suggested fixes from top findings
  const suggestedFixes = (summary.topFindings || [])
    .filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH')
    .slice(0, 5)
    .map((f) => `[${f.severity}] ${f.tool}/${f.ruleId}: ${f.remediation || f.title}`);

  if (suggestedFixes.length === 0) {
    suggestedFixes.push('Continue monitoring for new vulnerabilities. No immediate critical fixes required.');
  }

  // Gate summaries
  const gateSummaries = Object.entries(summary.byGate).map(([gate, g]) => ({
    gate,
    status: g.blocking ? 'BLOCKED' : (g.passed ? 'PASSED' : 'WARNED'),
    findingCount: g.total,
    criticalCount: g.bySeverity.CRITICAL || 0,
    highCount: g.bySeverity.HIGH || 0,
  }));

  return {
    source: 'fallback',
    stage,
    riskScore,
    riskLevel,
    recommendation,
    rationale: reasons.join('. ') + '.',
    topFindings: (summary.topFindings || []).slice(0, 10).map((f) => ({
      tool: f.tool,
      ruleId: f.ruleId,
      severity: f.severity,
      title: f.title,
      location: f.location,
    })),
    suggestedFixes,
    gateSummaries,
    totalFindings: summary.totalFindings,
    bySeverity: summary.bySeverity,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { analyze };
