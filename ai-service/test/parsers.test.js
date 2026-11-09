'use strict';

/**
 * Parser unit tests — uses node:test (built-in, no deps)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const FIXTURES = path.join(__dirname, 'fixtures');

// Helper to load a fixture
function loadFixture(name) {
  const content = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// Gitleaks parser
// ---------------------------------------------------------------------------
describe('gitleaks parser', () => {
  const { parse } = require('../src/parsers/gitleaks');

  test('parses fixture with 2 findings', () => {
    const raw = loadFixture('gitleaks.json');
    const findings = parse(raw);
    assert.equal(findings.length, 2);
  });

  test('gate is G1-secrets', () => {
    const raw = loadFixture('gitleaks.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.gate === 'G1-secrets'));
  });

  test('aws-access-token → CRITICAL severity', () => {
    const raw = loadFixture('gitleaks.json');
    const findings = parse(raw);
    const awsFinding = findings.find((f) => f.ruleId === 'aws-access-token');
    assert.ok(awsFinding, 'should find aws-access-token finding');
    assert.equal(awsFinding.severity, 'CRITICAL');
  });

  test('generic-api-key → HIGH severity', () => {
    const raw = loadFixture('gitleaks.json');
    const findings = parse(raw);
    const apiFinding = findings.find((f) => f.ruleId === 'generic-api-key');
    assert.ok(apiFinding, 'should find generic-api-key finding');
    assert.equal(apiFinding.severity, 'HIGH');
  });

  test('finding has required Finding shape fields', () => {
    const raw = loadFixture('gitleaks.json');
    const [f] = parse(raw);
    assert.ok(f.gate);
    assert.ok(f.tool);
    assert.ok(f.ruleId);
    assert.ok(f.severity);
    assert.ok(f.title);
    assert.ok(f.location);
    assert.ok(f.description);
    assert.ok(f.remediation);
  });

  test('returns empty array for null input', () => {
    assert.deepEqual(parse(null), []);
  });

  test('returns empty array for empty array input', () => {
    assert.deepEqual(parse([]), []);
  });
});

// ---------------------------------------------------------------------------
// Semgrep parser (JSON format)
// ---------------------------------------------------------------------------
describe('semgrep parser (JSON)', () => {
  const { parse } = require('../src/parsers/semgrep');

  test('parses real semgrep JSON fixture', () => {
    const raw = loadFixture('semgrep.json');
    const findings = parse(raw);
    assert.ok(findings.length >= 1, `Expected at least 1 finding, got ${findings.length}`);
  });

  test('gate is G2-sast', () => {
    const raw = loadFixture('semgrep.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.gate === 'G2-sast'));
  });

  test('tool is semgrep', () => {
    const raw = loadFixture('semgrep.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.tool === 'semgrep'));
  });

  test('SQLi finding has HIGH or CRITICAL severity (from metadata ERROR level)', () => {
    const raw = loadFixture('semgrep.json');
    const findings = parse(raw);
    assert.ok(findings.some((f) => ['HIGH', 'CRITICAL'].includes(f.severity)));
  });

  test('returns empty for null input', () => {
    assert.deepEqual(parse(null), []);
  });
});

// ---------------------------------------------------------------------------
// Semgrep parser (SARIF format)
// ---------------------------------------------------------------------------
describe('semgrep parser (SARIF)', () => {
  const { parse } = require('../src/parsers/semgrep');

  const sarifFixture = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'semgrep',
            rules: [
              {
                id: 'test.sqli',
                shortDescription: { text: 'SQL injection' },
                help: { text: 'Use parameterized queries' },
                properties: { severity: 'CRITICAL' },
              },
            ],
          },
        },
        results: [
          {
            ruleId: 'test.sqli',
            level: 'error',
            message: { text: 'SQL injection vulnerability' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'src/db.js' },
                  region: { startLine: 42 },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  test('parses SARIF format correctly', () => {
    const findings = parse(sarifFixture);
    assert.equal(findings.length, 1);
  });

  test('SARIF finding has CRITICAL severity from properties', () => {
    const findings = parse(sarifFixture);
    assert.equal(findings[0].severity, 'CRITICAL');
  });

  test('SARIF finding has correct location', () => {
    const findings = parse(sarifFixture);
    assert.equal(findings[0].location, 'src/db.js:42');
  });
});

// ---------------------------------------------------------------------------
// Trivy parser
// ---------------------------------------------------------------------------
describe('trivy parser', () => {
  const { parse } = require('../src/parsers/trivy');

  test('parses trivy-fs.json fixture', () => {
    const raw = loadFixture('trivy-fs.json');
    const findings = parse(raw);
    assert.ok(findings.length >= 3, `Expected >=3 findings, got ${findings.length}`);
  });

  test('gate is G3-sca-image by default', () => {
    const raw = loadFixture('trivy-fs.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.gate === 'G3-sca-image'));
  });

  test('CRITICAL CVE has CRITICAL severity', () => {
    const raw = loadFixture('trivy-fs.json');
    const findings = parse(raw);
    const crit = findings.find((f) => f.ruleId === 'CVE-2023-45133');
    assert.ok(crit, 'Should find CRITICAL CVE');
    assert.equal(crit.severity, 'CRITICAL');
  });

  test('HIGH CVE has HIGH severity', () => {
    const raw = loadFixture('trivy-fs.json');
    const findings = parse(raw);
    const high = findings.find((f) => f.ruleId === 'CVE-2023-26159');
    assert.ok(high, 'Should find HIGH CVE');
    assert.equal(high.severity, 'HIGH');
  });

  test('remediation mentions fixed version', () => {
    const raw = loadFixture('trivy-fs.json');
    const findings = parse(raw);
    const crit = findings.find((f) => f.ruleId === 'CVE-2023-45133');
    assert.ok(crit.remediation.includes('4.18.3'));
  });

  test('returns empty for no Results', () => {
    assert.deepEqual(parse({ SchemaVersion: 2, Results: [] }), []);
  });

  test('returns empty for null input', () => {
    assert.deepEqual(parse(null), []);
  });
});

// ---------------------------------------------------------------------------
// Checkov parser
// ---------------------------------------------------------------------------
describe('checkov parser', () => {
  const { parse } = require('../src/parsers/checkov');

  test('parses checkov.json fixture', () => {
    const raw = loadFixture('checkov.json');
    const findings = parse(raw);
    assert.equal(findings.length, 4, `Expected 4 failed checks, got ${findings.length}`);
  });

  test('gate is G4-iac', () => {
    const raw = loadFixture('checkov.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.gate === 'G4-iac'));
  });

  test('CKV_AWS_19 is CRITICAL', () => {
    const raw = loadFixture('checkov.json');
    const findings = parse(raw);
    const f = findings.find((f) => f.ruleId === 'CKV_AWS_19');
    assert.ok(f);
    assert.equal(f.severity, 'CRITICAL');
  });

  test('returns empty for null input', () => {
    assert.deepEqual(parse(null), []);
  });
});

// ---------------------------------------------------------------------------
// tfsec parser
// ---------------------------------------------------------------------------
describe('tfsec parser', () => {
  const { parse } = require('../src/parsers/tfsec');

  test('parses tfsec.json fixture', () => {
    const raw = loadFixture('tfsec.json');
    const findings = parse(raw);
    assert.equal(findings.length, 3);
  });

  test('gate is G4-iac', () => {
    const raw = loadFixture('tfsec.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.gate === 'G4-iac'));
  });

  test('HIGH severity normalized correctly', () => {
    const raw = loadFixture('tfsec.json');
    const findings = parse(raw);
    assert.ok(findings.some((f) => f.severity === 'HIGH'));
  });

  test('location includes filename and line number', () => {
    const raw = loadFixture('tfsec.json');
    const findings = parse(raw);
    assert.ok(findings[0].location.includes('terraform/main.tf'));
  });

  test('returns empty for null input', () => {
    assert.deepEqual(parse(null), []);
  });
});

// ---------------------------------------------------------------------------
// Conftest parser
// ---------------------------------------------------------------------------
describe('conftest parser', () => {
  const { parse } = require('../src/parsers/conftest');

  test('parses real conftest.json fixture (30 failures)', () => {
    const raw = loadFixture('conftest.json');
    const findings = parse(raw);
    assert.ok(findings.length >= 1, `Expected >=1 findings, got ${findings.length}`);
  });

  test('gate is G5-policy', () => {
    const raw = loadFixture('conftest.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.gate === 'G5-policy'));
  });

  test('failures map to HIGH severity', () => {
    const raw = loadFixture('conftest.json');
    const findings = parse(raw);
    // Failures should be HIGH
    assert.ok(findings.some((f) => f.severity === 'HIGH'));
  });

  test('returns empty for empty array', () => {
    assert.deepEqual(parse([]), []);
  });

  test('returns empty for null input', () => {
    assert.deepEqual(parse(null), []);
  });
});

// ---------------------------------------------------------------------------
// ZAP parser
// ---------------------------------------------------------------------------
describe('zap parser', () => {
  const { parse } = require('../src/parsers/zap');

  test('parses zap-report.json fixture', () => {
    const raw = loadFixture('zap-report.json');
    const findings = parse(raw);
    assert.equal(findings.length, 4);
  });

  test('gate is G7-dast', () => {
    const raw = loadFixture('zap-report.json');
    const findings = parse(raw);
    assert.ok(findings.every((f) => f.gate === 'G7-dast'));
  });

  test('XSS (riskcode 3) → HIGH severity', () => {
    const raw = loadFixture('zap-report.json');
    const findings = parse(raw);
    const xss = findings.find((f) => f.ruleId === '40012');
    assert.ok(xss, 'Should find XSS finding');
    assert.equal(xss.severity, 'HIGH');
  });

  test('Low risk (riskcode 1) → LOW severity', () => {
    const raw = loadFixture('zap-report.json');
    const findings = parse(raw);
    const csrf = findings.find((f) => f.ruleId === '10202');
    assert.ok(csrf, 'Should find CSRF finding');
    assert.equal(csrf.severity, 'LOW');
  });

  test('strips HTML tags from description', () => {
    const raw = loadFixture('zap-report.json');
    const findings = parse(raw);
    findings.forEach((f) => {
      assert.ok(!f.description.includes('<p>'), `Description should not contain HTML: ${f.description}`);
    });
  });

  test('returns empty for null input', () => {
    assert.deepEqual(parse(null), []);
  });
});
