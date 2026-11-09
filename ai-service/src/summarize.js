'use strict';

/**
 * summarize.js — aggregates Finding[] into a ScanSummary
 *
 * ScanSummary shape:
 * {
 *   totalFindings: number,
 *   bySeverity: { CRITICAL, HIGH, MEDIUM, LOW, INFO },
 *   byGate: { [gate]: { total, bySeverity, passed, blocking } },
 *   blocking: boolean,    // true if any CRITICAL finding exists
 *   gates: string[],      // all gate names seen
 *   tools: string[],      // all tool names seen
 *   topFindings: Finding[] // top 20 by severity for prompt
 * }
 */

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

function emptySeverityCount() {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
}

/**
 * Gates that are considered blocking if they have CRITICAL findings
 */
const BLOCKING_GATES = new Set(['G1-secrets', 'G2-sast', 'G3-sca-image', 'G4-iac']);

/**
 * @param {import('./types').Finding[]} findings
 * @returns {import('./types').ScanSummary}
 */
function summarize(findings) {
  const bySeverity = emptySeverityCount();
  const byGate = {};
  const gatesSet = new Set();
  const toolsSet = new Set();

  for (const f of findings) {
    const sev = f.severity || 'INFO';
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;

    const gate = f.gate || 'unknown';
    gatesSet.add(gate);
    toolsSet.add(f.tool || 'unknown');

    if (!byGate[gate]) {
      byGate[gate] = { total: 0, bySeverity: emptySeverityCount(), passed: true, blocking: false };
    }
    byGate[gate].total++;
    byGate[gate].bySeverity[sev] = (byGate[gate].bySeverity[sev] || 0) + 1;

    // A gate "fails" when it has any finding at HIGH or above
    if (sev === 'CRITICAL' || sev === 'HIGH') {
      byGate[gate].passed = false;
    }

    // A gate is "blocking" when it has CRITICAL findings AND is in the blocking set
    if (sev === 'CRITICAL' && BLOCKING_GATES.has(gate)) {
      byGate[gate].blocking = true;
    }
  }

  // Overall blocking = any blocking gate has CRITICAL
  const blocking = Object.values(byGate).some((g) => g.blocking) || bySeverity.CRITICAL > 0;

  // Sort findings for top-N: CRITICAL first, then HIGH, etc.
  const sorted = [...findings].sort((a, b) => {
    const ai = SEVERITY_ORDER.indexOf(a.severity);
    const bi = SEVERITY_ORDER.indexOf(b.severity);
    return ai - bi;
  });

  return {
    totalFindings: findings.length,
    bySeverity,
    byGate,
    blocking,
    gates: [...gatesSet].sort(),
    tools: [...toolsSet].sort(),
    topFindings: sorted.slice(0, 20),
  };
}

module.exports = { summarize };
