# G2 — Semgrep

## Why chosen

Semgrep is a lightweight, language-aware static analysis tool that supports custom rules written in a declarative YAML DSL. Unlike AST-based tools that require full compilation, Semgrep uses a pattern-matching approach on parsed syntax trees. This makes it trivial to write new rules targeting application-specific patterns — which is exactly what the custom SQLi rule does.

Version pinned: `returntocorp/semgrep:1.58.0`

## Rule sets used

1. **`p/owasp-top-ten`** — community-maintained rules covering OWASP Top 10 categories
2. **`p/nodejs`** — Node.js-specific patterns (eval injection, prototype pollution, etc.)
3. **`policy/semgrep/custom-rules.yaml`** — two ShieldOps-authored rules (see below)

## The custom rules

Config file: `policy/semgrep/custom-rules.yaml`

### Rule A: `shieldops.nodejs.sqli-pg-concat-var`

Detects the V2 vulnerability pattern: a SQL string assembled with binary `+` concatenation and then passed to `pool.query()` or `client.query()` without a parameterised placeholder array.

```yaml
patterns:
  - pattern: |
      $SQL = $A + $B + $C;
      ...
      $OBJ.query($SQL);
  - pattern-not: |
      $SQL = $A + $B + $C;
      ...
      $OBJ.query($SQL, [...]);
```

The `pattern-not` clause means the rule does NOT fire if a parameterised array is present — reducing false positives on legitimate dynamic query builders that already use `$1` placeholders.

### Rule B: `shieldops.nodejs.sqli-pg-template-literal`

Detects template literals with embedded expressions (`${...}`) passed directly to `pool.query()`.

```yaml
pattern: |
  $OBJ.query(`...`)
pattern-not: |
  $OBJ.query("...")
```

This catches patterns like `pool.query(\`SELECT * FROM tasks WHERE id = ${userId}\`)` that Rule A would miss (no explicit assignment + concatenation).

Both rules carry:
- `severity: ERROR` — causes `semgrep --error` to exit non-zero
- CWE-89 and OWASP A03:2021 metadata
- `confidence: HIGH` / `impact: CRITICAL`

## Tests

Test files: `policy/semgrep/tests/`

- `true-positive.js` — 4 test cases that MUST be flagged (annotated with `ruleid:` comments)
- `true-negative.js` — parameterised patterns that must NOT be flagged

Run locally:

```bash
semgrep --test policy/semgrep/
# Expected: all tests pass
```

The pipeline also runs `semgrep --test policy/semgrep/ || true` (non-blocking) to show test results in the CI log.

## Pipeline policy

- **Stage:** `sast`
- **Two-pass approach:** SARIF output (for GitLab SAST artifact) first (`--error` disabled), then JSON with `--error` to set pass/fail. This is required because Semgrep 1.58.0 rejects a repeated `--output` flag.
- **allow_failure: false** — any ERROR-severity finding blocks the pipeline
- Scans: `app/` and `ai-service/src/`
- Reports: `semgrep.sarif` (GitLab integration) + `semgrep.json` (AI analysis input)

## Why a custom rule matters

The `p/nodejs` ruleset catches generic injection patterns, but it does not know about the specific `node-postgres` (`pg`) library calling convention. The generic rule might miss `pool.query(someVar)` where `someVar` was built by concatenation two lines earlier. The custom rule closes this gap by following the data flow within the function scope.

## OWASP mapping

A03:2021 — Injection (SQL Injection specifically)
