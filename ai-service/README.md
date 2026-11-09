# ShieldOps AI Analysis Service

AI-powered security report analysis (OpenRouter or Google Gemini, with a rule-based
fallback). Ingests scan reports
from Gitleaks, Semgrep, Trivy, Checkov, tfsec, OPA/Conftest, and OWASP ZAP,
then produces a structured **DEPLOY / BACK_TO_DEV** recommendation.

## Features

- Parses 7 scanner formats into a normalized Finding shape
- Provider chain: **OpenRouter → Gemini → rule-based fallback**. A provider is tried
  only when its key is set; if every provider fails, the fallback runs.
- Structured JSON output (schema-constrained for Gemini, JSON-extracted for OpenRouter)
- CLI mode (for CI) + HTTP API (for dashboard)
- S3 upload of `ai-report-<stage>.{json,md}`
- Never hard-blocks the pipeline — always exits 0; human has final say

## Quickstart

```bash
# Install
npm ci

# Run (fallback mode, no API key needed)
node src/index.js analyze --input /path/to/reports --stage staging --out ./out

# Run with OpenRouter (default model: openai/gpt-oss-120b:free)
OPENROUTER_API_KEY=your_key node src/index.js analyze --input ./reports --stage prod --out ./out

# Run with Gemini
GEMINI_API_KEY=your_key node src/index.js analyze --input ./reports --stage prod --out ./out
```

## CLI Reference

```
node src/index.js analyze [options]

Options:
  --input <path>     Directory or glob of report files (required)
  --stage <stage>    staging | prod (default: staging)
  --out <dir>        Output directory (default: .)
  --format <fmts>    Output formats: json,md (default: json,md)
  --pipeline-id <id> Pipeline ID for report metadata
  --s3-bucket <b>    Upload to this S3 bucket (optional)
  --s3-prefix <p>    S3 key prefix (optional)
```

## HTTP API

```bash
# Start server
npm start   # listens on PORT (default 3000)

# Health check
curl http://localhost:3000/healthz

# Analyze from directory
curl -X POST http://localhost:3000/analyze \
  -H 'Content-Type: application/json' \
  -d '{"reportsDir": "/path/to/reports", "stage": "staging"}'

# Render JSON report to markdown
curl -X POST http://localhost:3000/render \
  -H 'Content-Type: application/json' \
  -d @ai-report-staging.json
```

## Docker

```bash
# Build
docker build -t shieldops-ai .

# CLI mode (mount reports + output dirs)
docker run --rm \
  -e GEMINI_API_KEY="${GEMINI_API_KEY}" \
  -e AWS_ENDPOINT_URL="http://localstack:4566" \
  -v "$(pwd)/reports:/reports:ro" \
  -v "$(pwd)/out:/out" \
  --network shieldops-net \
  shieldops-ai \
  node src/index.js analyze --input /reports --stage staging --out /out

# HTTP server mode
docker run -d -p 3000:3000 \
  -e GEMINI_API_KEY="${GEMINI_API_KEY}" \
  --network shieldops-net \
  shieldops-ai
```

## GitLab CI Integration

The service is called by `g6-ai-staging-analysis` and `g8-ai-prod-analysis` jobs.

**Optional GitLab CI/CD variables (masked):**

| Variable | Type | Masked | Protected | Description |
|----------|------|--------|-----------|-------------|
| `OPENROUTER_API_KEY` | Variable | Yes | Yes | OpenRouter API key (tried first) |
| `GEMINI_API_KEY` | Variable | Yes | Yes | Google Gemini API key |

Optional tuning: `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODELS` (comma-separated),
`OPENROUTER_MAX_TOKENS`. Free keys: https://openrouter.ai/keys, https://aistudio.google.com/app/apikey

The pipeline jobs run the CLI via `node src/index.js analyze`. If no provider key
is set, or every provider fails, the rule-based analysis runs automatically — the
pipeline never blocks because an AI provider is unavailable.

## Output Schema (JSON)

```json
{
  "source": "gemini" | "fallback",
  "stage": "staging" | "prod",
  "riskScore": 0-10,
  "riskLevel": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE",
  "recommendation": "DEPLOY" | "BACK_TO_DEV",
  "rationale": "string",
  "topFindings": [{ "tool", "ruleId", "severity", "title", "location" }],
  "suggestedFixes": ["string"],
  "gateSummaries": [{ "gate", "status", "findingCount", "criticalCount", "highCount" }],
  "totalFindings": 0,
  "bySeverity": { "CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0, "INFO": 0 },
  "generatedAt": "ISO timestamp"
}
```

## Tests

```bash
npm test   # runs all 65 unit tests (parsers + fallback + gemini mocked)
```

Tests cover all 7 parsers with real fixtures and the fallback decision logic.
No network access required — Gemini is mocked.
