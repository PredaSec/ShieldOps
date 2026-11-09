# AI Analysis Service

## Overview

The ShieldOps AI analysis service (`ai-service/src/`) aggregates all security scan reports from G1–G7 and produces a structured risk recommendation: `DEPLOY` or `BACK_TO_DEV`. It runs twice in the pipeline — once before staging (G6) and once before production (G8, with ZAP results added).

The philosophy is **"AI assists, human decides"**. The AI report is advisory. The pipeline pauses at manual gates (`g6-deploy-staging`, `g8-deploy-production`) where a human operator reviews the recommendation before approving.

---

## Architecture

```
                        ┌─────────────────┐
scan reports (JSON)     │   loader.js      │  parse 7 tool formats
gitleaks.json           │   parsers/       │  → normalised Finding[]
semgrep.json            └────────┬────────┘
trivy-fs.json                    │
trivy-image.json        ┌────────▼────────┐
checkov.json            │   summarize.js  │  → ScanSummary
tfsec.json              │                 │    (bySeverity, byGate,
conftest.json           └────────┬────────┘     topFindings, blocking)
zap-report.json                  │
                        ┌────────▼─────────────────────────────────┐
                        │         index.js (CLI entrypoint)        │
                        │  if OPENROUTER_API_KEY: → openrouter.js  │
                        │  then if GEMINI_API_KEY: → gemini.js     │
                        │  no key / all providers fail:            │
                        │    → fallback.js (rule-based)            │
                        └────────┬─────────────────────────────────┘
                                 │
                    ┌────────────▼────────────────┐
                    │  ai-report-{staging|prod}    │
                    │  .json + .md                 │
                    │  uploaded to S3              │
                    └─────────────────────────────┘
```

---

## Provider order

`index.js` builds a provider list from the environment and tries each in turn:

1. **OpenRouter** (`openrouter.js`), if `OPENROUTER_API_KEY` is set. OpenAI-compatible API; default model `openai/gpt-oss-120b:free`, overridable with `OPENROUTER_MODEL`, with optional backups in `OPENROUTER_FALLBACK_MODELS`. The JSON object is extracted from the model's reply and validated against the same schema.
2. **Gemini** (`gemini.js`), if `GEMINI_API_KEY` is set (details below).
3. **Rule-based fallback** (`fallback.js`), if no key is set or every provider failed.

The report's `source` field records which one produced it (`openrouter`, `gemini` or `fallback`).

---

## Gemini integration

File: `ai-service/src/gemini.js`

### Model

`gemini-1.5-flash` (configurable via `GEMINI_MODEL` env var). Flash is used over Pro because:
- Lower latency (~2–5 seconds vs 15–30 seconds)
- Free tier quota sufficient for CI use
- The structured JSON output constraint removes ambiguity, making Pro-level reasoning unnecessary

### Constrained JSON output

Gemini is called with `responseMimeType: 'application/json'` and a `responseSchema` that constrains the output to a fixed structure. This eliminates JSON-parse failures from free-form text responses:

```javascript
const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  required: ['riskScore', 'riskLevel', 'recommendation', 'rationale',
             'topFindings', 'suggestedFixes', 'gateSummaries'],
  properties: {
    riskScore:      { type: NUMBER },        // 0–10
    riskLevel:      { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'] },
    recommendation: { enum: ['DEPLOY', 'BACK_TO_DEV'] },
    rationale:      { type: STRING },        // 2–4 sentence explanation
    topFindings:    { type: ARRAY, ... },    // prioritised by risk
    suggestedFixes: { type: ARRAY },         // max 7 actionable items
    gateSummaries:  { type: ARRAY, ... },    // per-gate pass/fail
  }
}
```

### System instruction (prompt design)

The system instruction (`SYSTEM_INSTRUCTION` in `gemini.js`) defines the analyst role and enforces hard decision rules:

```
You are a senior DevSecOps security analyst...

Decision rules (MANDATORY — never override these):
1. If there are ANY CRITICAL severity findings → recommendation MUST be "BACK_TO_DEV"
2. If there are blocking gate failures (G1-secrets, G2-sast, G3, G4 CRITICAL) → MUST be "BACK_TO_DEV"
3. If HIGH findings exceed 10 in a single gate → strongly consider "BACK_TO_DEV"
4. Otherwise, weigh the overall risk profile...
```

### Prompt construction

`buildPrompt(summary, stage)` sends a structured text summary (not raw JSON reports) to stay within token limits:

```
## Security Scan Summary — STAGING environment

### Overall Counts
- Total findings: N
- CRITICAL: N   HIGH: N   MEDIUM: N   LOW: N
- Blocking: true/false

### Gates Scanned
- g1-secrets: 0 findings (CRITICAL: 0) — PASSED
- g2-sast: 2 findings (CRITICAL: 2) — FAILED [BLOCKING]
...

### Top Findings (by severity, max 15)
1. [CRITICAL] semgrep/shieldops.nodejs.sqli-pg-concat-var @ app/backend/src/index.js
   SQL injection risk: ...
```

Temperature is set to `0.1` for near-deterministic output on the same input.

### Safety override (post-processing)

Even if Gemini returns `DEPLOY` (e.g. due to model drift), the service applies a hard safety check after parsing:

```javascript
if (summary.bySeverity.CRITICAL > 0 && parsed.recommendation !== 'BACK_TO_DEV') {
  parsed.recommendation = 'BACK_TO_DEV';
  parsed.rationale = `[SAFETY OVERRIDE] BACK_TO_DEV enforced: ${summary.bySeverity.CRITICAL} CRITICAL finding(s) exist. ` + parsed.rationale;
}
```

This means a CRITICAL finding **always** produces `BACK_TO_DEV`, regardless of what the model says. The AI can be wrong; this hard rule cannot be overridden.

### Retry / backoff

The Gemini client retries up to 3 times with exponential backoff (2 s, 4 s) on 429 rate-limit errors. After 3 failures it throws, and the service falls back to rule-based analysis.

---

## Rule-based fallback

File: `ai-service/src/fallback.js`

When no AI provider key is set, or when every provider fails (quota, network, parse error), the service uses a deterministic rule-based fallback. The output schema is **identical** to the AI output — the caller can only tell the sources apart by the `source` field in the JSON.

Decision logic:

```
riskScore = CRITICAL×10 + HIGH×5 + MEDIUM×2 + LOW×0.5  (capped at 10)
riskLevel = CRITICAL if any CRITICAL, else HIGH/MEDIUM/LOW by score

recommendation = BACK_TO_DEV  if (CRITICAL > 0 OR blocking gate failure)
               = DEPLOY        otherwise
```

The fallback produces:
- `rationale`: explicit string citing counts and gate names
- `topFindings`: top 10 findings from the summary
- `suggestedFixes`: derived from CRITICAL/HIGH findings, max 5
- `gateSummaries`: per-gate PASSED/WARNED/BLOCKED status

**Why it matters:** free-tier AI quotas run out (the original Gemini key was denied generation quota, which is why OpenRouter was added). The fallback is not a degraded mode — it is a fully functional risk engine; the only difference is that it cannot reason about nuanced trade-offs between findings the way a language model can.

---

## Output formats

For each run the service writes:
- `ai-report-staging.json` / `ai-report-prod.json` — structured risk report
- `ai-report-staging.md` / `ai-report-prod.md` — human-readable Markdown summary

Both are exposed as GitLab CI artifacts (30-day retention) and uploaded to S3:
- `s3://shieldops-reports/<pipeline-id>/g6-ai-staging/`
- `s3://shieldops-reports/<pipeline-id>/g8-ai-prod/`

---

## Tests

65 unit tests cover parsers, summarize, fallback, and render:

```bash
cd ai-service && npm test
# 65 tests pass
```

The Gemini client (`gemini.js`) is not unit-tested (it requires a live API key) but is covered by the fallback path tests.

---

## "AI assists, human decides"

The service always exits 0 (`process.exit(0)` at the end of `index.js`). A `BACK_TO_DEV` recommendation does NOT block the pipeline job. The AI report is an input to the human operator's decision at the manual gate. This design:

1. Prevents the AI from becoming a single point of failure (if Gemini is down, the pipeline still works)
2. Keeps humans accountable — the operator must consciously override a `BACK_TO_DEV` recommendation
3. Allows context the AI cannot see (e.g. "this HIGH finding is in a test-only dependency and we accept the risk")
