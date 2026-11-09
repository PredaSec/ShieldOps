'use strict';

/**
 * openrouter.js — OpenRouter client (OpenAI-compatible Chat Completions).
 *
 * Drop-in alternative to gemini.js with the same analyze(summary, stage)
 * interface and report shape. Uses a free model by default; constrains output
 * to JSON via response_format + an explicit schema in the system prompt.
 * Retries with exponential backoff on 429 (upstream provider rate limits).
 */

const { buildPrompt } = require('./gemini');

const BASE_URL  = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const MODEL_NAME = process.env.OPENROUTER_MODEL   || 'openai/gpt-oss-120b:free';
// Reasoning models (e.g. Flint) spend tokens thinking before answering; too low a
// cap leaves the JSON answer empty. Override per model in CI.
const MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS) || 2048;
// Optional comma-separated backup models: OpenRouter tries them in order when the
// primary is rate-limited or down (free models share a busy upstream pool).
const FALLBACK_MODELS = (process.env.OPENROUTER_FALLBACK_MODELS || '')
  .split(',').map((m) => m.trim()).filter(Boolean);
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 2000;

const SYSTEM_INSTRUCTION = `You are a senior DevSecOps security analyst reviewing automated security scan results for a Node.js/Helm/Kubernetes application pipeline.

Analyze the provided scan summary and produce a structured security assessment.

Decision rules (MANDATORY — never override these):
1. If there are ANY CRITICAL severity findings -> recommendation MUST be "BACK_TO_DEV".
2. If there are blocking gate failures (G1-secrets, G2-sast, G3-sca-image, G4-iac with CRITICAL) -> MUST be "BACK_TO_DEV".
3. If HIGH findings exceed 10 in a single gate -> strongly consider "BACK_TO_DEV".
4. Otherwise weigh the overall risk profile and recommend "DEPLOY" or "BACK_TO_DEV".

Risk score: 0=clean, 10=critical; be precise (e.g. 7.5). Rationale: cite tool names and counts. suggestedFixes: actionable and specific, max 7 items.

Respond with ONLY a JSON object (no markdown, no prose) matching EXACTLY this shape:
{
  "riskScore": number,                // 0..10
  "riskLevel": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"NONE",
  "recommendation": "DEPLOY"|"BACK_TO_DEV",
  "rationale": string,
  "topFindings": [ { "tool": string, "ruleId": string, "severity": string, "title": string, "location": string } ],
  "suggestedFixes": [ string ],
  "gateSummaries": [ { "gate": string, "status": string, "findingCount": number, "criticalCount": number, "highCount": number } ]
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract a JSON object from model output (tolerate ```json fences / stray prose / control chars). */
function extractJson(text) {
  if (!text) throw new Error('empty model response');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model response');
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (_e) {
    // Some models emit raw control characters inside string values (unescaped
    // newlines/tabs), which strict JSON.parse rejects. Sanitize and retry.
    const sanitized = Array.from(candidate).map((c) => {
      const code = c.charCodeAt(0);
      if (code === 9 || code === 10 || code === 13) return ' ';
      if (code < 32) return '';
      return c;
    }).join('');
    return JSON.parse(sanitized);
  }
}

/**
 * @param {import('./types').ScanSummary} summary
 * @param {string} stage
 * @returns {Promise<object>} report matching the shared schema
 */
async function analyze(summary, stage = 'staging') {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY environment variable not set');

  const body = {
    model: MODEL_NAME,
    ...(FALLBACK_MODELS.length && { models: [MODEL_NAME, ...FALLBACK_MODELS] }),
    temperature: 0.1,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: buildPrompt(summary, stage) },
    ],
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Optional attribution headers (recommended by OpenRouter).
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://shieldops.local',
          'X-Title': 'ShieldOps DevSecOps',
        },
        body: JSON.stringify(body),
      });

      if (resp.status === 429) throw Object.assign(new Error('rate limited (429)'), { status: 429 });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`OpenRouter HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      const parsed = extractJson(content);

      if (!parsed.recommendation || !['DEPLOY', 'BACK_TO_DEV'].includes(parsed.recommendation)) {
        throw new Error(`Invalid recommendation: ${parsed.recommendation}`);
      }

      // Safety: enforce CRITICAL -> BACK_TO_DEV regardless of model output.
      if (summary.bySeverity.CRITICAL > 0 && parsed.recommendation !== 'BACK_TO_DEV') {
        parsed.recommendation = 'BACK_TO_DEV';
        parsed.rationale = `[SAFETY OVERRIDE] BACK_TO_DEV enforced: ${summary.bySeverity.CRITICAL} CRITICAL finding(s) exist. ` + (parsed.rationale || '');
      }

      return {
        ...parsed,
        source: 'openrouter',
        model: data.model || MODEL_NAME,   // the model that actually answered
        stage,
        totalFindings: summary.totalFindings,
        bySeverity: summary.bySeverity,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      lastError = err;
      const isRateLimit = err.status === 429 || /429|rate limit/i.test(err.message || '');
      if (isRateLimit && attempt < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        console.warn(`[openrouter] rate limit (attempt ${attempt}/${MAX_RETRIES}), retrying in ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }
      break;
    }
  }
  throw lastError || new Error('OpenRouter analysis failed after retries');
}

module.exports = { analyze };
