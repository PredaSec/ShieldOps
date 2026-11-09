'use strict';

/**
 * Fallback analysis unit tests — no network required
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { summarize } = require('../src/summarize');
const { analyze } = require('../src/fallback');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides = {}) {
  return {
    gate: 'G2-sast',
    tool: 'semgrep',
    ruleId: 'test-rule',
    severity: 'MEDIUM',
    title: 'Test finding',
    location: 'src/app.js:1',
    description: 'Test description',
    remediation: 'Fix it',
    ...overrides,
  };
}

function makeFindings(specs) {
  return specs.map(([gate, tool, severity]) =>
    makeFinding({ gate, tool, severity, ruleId: `${tool}-rule-${severity}` })
  );
}

// ---------------------------------------------------------------------------
// Summarize tests
// ---------------------------------------------------------------------------
describe('summarize', () => {
  test('empty findings → zero counts', () => {
    const s = summarize([]);
    assert.equal(s.totalFindings, 0);
    assert.equal(s.bySeverity.CRITICAL, 0);
    assert.equal(s.blocking, false);
  });

  test('counts by severity correctly', () => {
    const findings = makeFindings([
      ['G1-secrets', 'gitleaks', 'CRITICAL'],
      ['G2-sast', 'semgrep', 'HIGH'],
      ['G2-sast', 'semgrep', 'MEDIUM'],
      ['G5-policy', 'conftest', 'HIGH'],
      ['G5-policy', 'conftest', 'LOW'],
    ]);
    const s = summarize(findings);
    assert.equal(s.totalFindings, 5);
    assert.equal(s.bySeverity.CRITICAL, 1);
    assert.equal(s.bySeverity.HIGH, 2);
    assert.equal(s.bySeverity.MEDIUM, 1);
    assert.equal(s.bySeverity.LOW, 1);
  });

  test('blocking=true when CRITICAL exists', () => {
    const findings = [makeFinding({ gate: 'G1-secrets', severity: 'CRITICAL' })];
    const s = summarize(findings);
    assert.equal(s.blocking, true);
  });

  test('blocking=false when only HIGH/MEDIUM', () => {
    const findings = [
      makeFinding({ severity: 'HIGH' }),
      makeFinding({ severity: 'MEDIUM' }),
    ];
    const s = summarize(findings);
    // No CRITICAL, so blocking=false (HIGH alone doesn't set blocking)
    assert.equal(s.blocking, false);
  });

  test('gate pass/fail: gate fails when HIGH exists', () => {
    const findings = [makeFinding({ gate: 'G2-sast', severity: 'HIGH' })];
    const s = summarize(findings);
    assert.equal(s.byGate['G2-sast'].passed, false);
  });

  test('gate pass/fail: gate passes when only MEDIUM/LOW', () => {
    const findings = [
      makeFinding({ gate: 'G5-policy', severity: 'MEDIUM' }),
      makeFinding({ gate: 'G5-policy', severity: 'LOW' }),
    ];
    const s = summarize(findings);
    assert.equal(s.byGate['G5-policy'].passed, true);
  });

  test('topFindings are sorted CRITICAL first', () => {
    const findings = makeFindings([
      ['G2-sast', 'semgrep', 'LOW'],
      ['G1-secrets', 'gitleaks', 'CRITICAL'],
      ['G2-sast', 'semgrep', 'HIGH'],
      ['G2-sast', 'semgrep', 'MEDIUM'],
    ]);
    const s = summarize(findings);
    assert.equal(s.topFindings[0].severity, 'CRITICAL');
    assert.equal(s.topFindings[1].severity, 'HIGH');
  });

  test('gates and tools arrays are populated', () => {
    const findings = makeFindings([
      ['G1-secrets', 'gitleaks', 'HIGH'],
      ['G2-sast', 'semgrep', 'MEDIUM'],
    ]);
    const s = summarize(findings);
    assert.ok(s.gates.includes('G1-secrets'));
    assert.ok(s.gates.includes('G2-sast'));
    assert.ok(s.tools.includes('gitleaks'));
    assert.ok(s.tools.includes('semgrep'));
  });
});

// ---------------------------------------------------------------------------
// Fallback analysis tests
// ---------------------------------------------------------------------------
describe('fallback.analyze', () => {
  test('CRITICAL finding → BACK_TO_DEV recommendation', () => {
    const findings = [makeFinding({ gate: 'G1-secrets', severity: 'CRITICAL' })];
    const summary = summarize(findings);
    const report = analyze(summary, 'staging');
    assert.equal(report.recommendation, 'BACK_TO_DEV');
  });

  test('no CRITICAL findings → DEPLOY recommendation', () => {
    const findings = [
      makeFinding({ severity: 'HIGH' }),
      makeFinding({ severity: 'MEDIUM' }),
    ];
    const summary = summarize(findings);
    const report = analyze(summary, 'staging');
    assert.equal(report.recommendation, 'DEPLOY');
  });

  test('source is "fallback"', () => {
    const summary = summarize([]);
    const report = analyze(summary, 'staging');
    assert.equal(report.source, 'fallback');
  });

  test('stage is reflected in report', () => {
    const summary = summarize([]);
    const report = analyze(summary, 'prod');
    assert.equal(report.stage, 'prod');
  });

  test('riskScore is 0 for empty findings', () => {
    const summary = summarize([]);
    const report = analyze(summary, 'staging');
    assert.equal(report.riskScore, 0);
  });

  test('riskScore increases with critical findings', () => {
    const findings = [makeFinding({ gate: 'G1-secrets', severity: 'CRITICAL' })];
    const summary = summarize(findings);
    const report = analyze(summary, 'staging');
    assert.ok(report.riskScore >= 10, `Expected riskScore >= 10, got ${report.riskScore}`);
  });

  test('riskLevel is CRITICAL when CRITICAL findings exist', () => {
    const findings = [makeFinding({ gate: 'G2-sast', severity: 'CRITICAL' })];
    const summary = summarize(findings);
    const report = analyze(summary, 'staging');
    assert.equal(report.riskLevel, 'CRITICAL');
  });

  test('riskLevel is NONE for empty scan', () => {
    const summary = summarize([]);
    const report = analyze(summary, 'staging');
    assert.equal(report.riskLevel, 'NONE');
  });

  test('report has required schema fields', () => {
    const summary = summarize([makeFinding()]);
    const report = analyze(summary, 'staging');
    assert.ok('riskScore' in report);
    assert.ok('riskLevel' in report);
    assert.ok('recommendation' in report);
    assert.ok('rationale' in report);
    assert.ok(Array.isArray(report.topFindings));
    assert.ok(Array.isArray(report.suggestedFixes));
    assert.ok(Array.isArray(report.gateSummaries));
    assert.ok('generatedAt' in report);
  });

  test('rationale is non-empty string', () => {
    const summary = summarize([makeFinding({ severity: 'CRITICAL' })]);
    const report = analyze(summary, 'staging');
    assert.ok(typeof report.rationale === 'string');
    assert.ok(report.rationale.length > 0);
  });

  test('gateSummaries reflect gate status', () => {
    const findings = [makeFinding({ gate: 'G1-secrets', severity: 'CRITICAL' })];
    const summary = summarize(findings);
    const report = analyze(summary, 'staging');
    const gateSum = report.gateSummaries.find((g) => g.gate === 'G1-secrets');
    assert.ok(gateSum);
    assert.equal(gateSum.status, 'BLOCKED');
    assert.equal(gateSum.criticalCount, 1);
  });

  test('BACK_TO_DEV with full fixture suite (has CRITICAL)', () => {
    // Simulate real pipeline with checkov CRITICAL and aws-access-token CRITICAL
    const realFindings = [
      makeFinding({ gate: 'G1-secrets', tool: 'gitleaks', ruleId: 'aws-access-token', severity: 'CRITICAL', title: 'AWS Access Token', location: '.env.bak:3', remediation: 'Rotate credential' }),
      makeFinding({ gate: 'G4-iac', tool: 'checkov', ruleId: 'CKV_AWS_19', severity: 'CRITICAL', title: 'S3 encryption disabled', location: 'terraform/main.tf:1', remediation: 'Enable S3 encryption' }),
      makeFinding({ gate: 'G3-sca-image', tool: 'trivy', ruleId: 'CVE-2023-45133', severity: 'CRITICAL', title: 'CVE in express', location: 'package.json', remediation: 'Upgrade express' }),
      makeFinding({ gate: 'G2-sast', tool: 'semgrep', ruleId: 'sqli-pg', severity: 'HIGH', title: 'SQL injection', location: 'src/index.js:79' }),
      makeFinding({ gate: 'G5-policy', tool: 'conftest', ruleId: 'SECURITY-001', severity: 'HIGH', title: 'No security context', location: '-' }),
      makeFinding({ gate: 'G7-dast', tool: 'zap', ruleId: '40012', severity: 'HIGH', title: 'XSS reflected', location: 'GET /search' }),
    ];

    const summary = summarize(realFindings);
    const report = analyze(summary, 'staging');

    assert.equal(report.recommendation, 'BACK_TO_DEV');
    assert.equal(report.source, 'fallback');
    assert.equal(report.riskLevel, 'CRITICAL');
    assert.ok(report.riskScore >= 10);
  });
});

// ---------------------------------------------------------------------------
// Gemini module unit tests (SDK mocked — no network)
// ---------------------------------------------------------------------------
describe('gemini module (mocked)', () => {
  test('buildPrompt includes severity counts', () => {
    const { buildPrompt } = require('../src/gemini');
    const summary = {
      totalFindings: 5,
      bySeverity: { CRITICAL: 2, HIGH: 1, MEDIUM: 1, LOW: 1, INFO: 0 },
      blocking: true,
      byGate: {
        'G1-secrets': { total: 2, bySeverity: { CRITICAL: 2, HIGH: 0 }, passed: false, blocking: true },
      },
      tools: ['gitleaks'],
      topFindings: [],
    };
    const prompt = buildPrompt(summary, 'staging');
    assert.ok(prompt.includes('CRITICAL: 2'));
    assert.ok(prompt.includes('HIGH: 1'));
    assert.ok(prompt.includes('STAGING'));
  });

  test('buildPrompt includes gate information', () => {
    const { buildPrompt } = require('../src/gemini');
    const summary = {
      totalFindings: 1,
      bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      blocking: true,
      byGate: {
        'G1-secrets': { total: 1, bySeverity: { CRITICAL: 1, HIGH: 0 }, passed: false, blocking: true },
      },
      tools: ['gitleaks'],
      topFindings: [],
    };
    const prompt = buildPrompt(summary, 'staging');
    assert.ok(prompt.includes('G1-secrets'));
  });

  test('throws if GEMINI_API_KEY not set', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { analyze } = require('../src/gemini');
      const summary = summarize([]);
      await assert.rejects(
        () => analyze(summary, 'staging'),
        /GEMINI_API_KEY/
      );
    } finally {
      if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
