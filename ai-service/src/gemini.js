'use strict';

/**
 * gemini.js — Google Gemini client with structured JSON output
 *
 * Uses @google/generative-ai with responseMimeType=application/json and
 * a responseSchema to constrain output. Low temperature for determinism.
 * Retries with exponential backoff on rate-limit (429) errors.
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

// Response schema — Gemini will be constrained to produce this structure
const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    riskScore: {
      type: SchemaType.NUMBER,
      description: 'Overall risk score from 0 (no risk) to 10 (critical risk)',
    },
    riskLevel: {
      type: SchemaType.STRING,
      enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'],
      description: 'Overall risk level',
    },
    recommendation: {
      type: SchemaType.STRING,
      enum: ['DEPLOY', 'BACK_TO_DEV'],
      description: 'Deployment recommendation',
    },
    rationale: {
      type: SchemaType.STRING,
      description: 'Explanation of the recommendation in 2-4 sentences',
    },
    topFindings: {
      type: SchemaType.ARRAY,
      description: 'Top security findings prioritized by risk',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          tool: { type: SchemaType.STRING },
          ruleId: { type: SchemaType.STRING },
          severity: { type: SchemaType.STRING },
          title: { type: SchemaType.STRING },
          location: { type: SchemaType.STRING },
        },
        required: ['tool', 'ruleId', 'severity', 'title'],
      },
    },
    suggestedFixes: {
      type: SchemaType.ARRAY,
      description: 'Prioritized list of remediation actions',
      items: { type: SchemaType.STRING },
    },
    gateSummaries: {
      type: SchemaType.ARRAY,
      description: 'Per-gate status summary',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          gate: { type: SchemaType.STRING },
          status: { type: SchemaType.STRING },
          findingCount: { type: SchemaType.NUMBER },
          criticalCount: { type: SchemaType.NUMBER },
          highCount: { type: SchemaType.NUMBER },
        },
        required: ['gate', 'status', 'findingCount'],
      },
    },
  },
  required: ['riskScore', 'riskLevel', 'recommendation', 'rationale', 'topFindings', 'suggestedFixes', 'gateSummaries'],
};

const SYSTEM_INSTRUCTION = `You are a senior DevSecOps security analyst reviewing automated security scan results for a Node.js/Helm/Kubernetes application pipeline.

Your task is to analyze the provided scan summary and produce a structured security assessment.

Decision rules (MANDATORY — never override these):
1. If there are ANY CRITICAL severity findings → recommendation MUST be "BACK_TO_DEV"
2. If there are blocking gate failures (G1-secrets, G2-sast, G3-sca-image, G4-iac with CRITICAL) → MUST be "BACK_TO_DEV"
3. If HIGH findings exceed 10 in a single gate → strongly consider "BACK_TO_DEV"
4. Otherwise, weigh the overall risk profile and recommend "DEPLOY" or "BACK_TO_DEV"

Risk score: 0=clean, 10=critical. Be precise (e.g. 7.5 not just 8).
Rationale: Be specific about which findings drove the decision. Cite tool names and counts.
SuggestedFixes: Provide actionable, specific fixes (not generic advice). Maximum 7 items.`;

/**
 * Sleep with exponential backoff
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the prompt from the scan summary (token-bounded)
 * @param {import('./types').ScanSummary} summary
 * @param {string} stage
 * @returns {string}
 */
function buildPrompt(summary, stage) {
  // Include only top findings to stay within token limits
  const topFindings = (summary.topFindings || []).slice(0, 15);

  const prompt = `
## Security Scan Summary — ${stage.toUpperCase()} environment

### Overall Counts
- Total findings: ${summary.totalFindings}
- CRITICAL: ${summary.bySeverity.CRITICAL}
- HIGH: ${summary.bySeverity.HIGH}
- MEDIUM: ${summary.bySeverity.MEDIUM}
- LOW: ${summary.bySeverity.LOW}
- INFO: ${summary.bySeverity.INFO}
- Blocking: ${summary.blocking}

### Gates Scanned
${Object.entries(summary.byGate).map(([gate, g]) => (
  `- ${gate}: ${g.total} findings (CRITICAL: ${g.bySeverity.CRITICAL}, HIGH: ${g.bySeverity.HIGH}) — ${g.passed ? 'PASSED' : 'FAILED'}${g.blocking ? ' [BLOCKING]' : ''}`
)).join('\n')}

### Top Findings (by severity)
${topFindings.map((f, i) => (
  `${i + 1}. [${f.severity}] ${f.tool}/${f.ruleId} @ ${f.location}\n   ${f.title}\n   Remediation: ${(f.remediation || '').substring(0, 150)}`
)).join('\n\n')}

### Tools Run
${summary.tools.join(', ')}

Analyze the above and produce a structured security assessment following the output schema.
`;
  return prompt.trim();
}

/**
 * Call Gemini API with retry/backoff
 * @param {import('./types').ScanSummary} summary
 * @param {string} stage
 * @returns {Promise<object>} - report matching response schema
 */
async function analyze(summary, stage = 'staging') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable not set');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTION,
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const prompt = buildPrompt(summary, stage);

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(text);

      // Validate mandatory fields
      if (!parsed.recommendation || !['DEPLOY', 'BACK_TO_DEV'].includes(parsed.recommendation)) {
        throw new Error(`Invalid recommendation: ${parsed.recommendation}`);
      }

      // Safety: enforce CRITICAL → BACK_TO_DEV regardless of model output
      if (summary.bySeverity.CRITICAL > 0 && parsed.recommendation !== 'BACK_TO_DEV') {
        parsed.recommendation = 'BACK_TO_DEV';
        parsed.rationale = `[SAFETY OVERRIDE] BACK_TO_DEV enforced: ${summary.bySeverity.CRITICAL} CRITICAL finding(s) exist. ` + (parsed.rationale || '');
      }

      return {
        ...parsed,
        source: 'gemini',
        model: MODEL_NAME,
        stage,
        totalFindings: summary.totalFindings,
        bySeverity: summary.bySeverity,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      lastError = err;
      // Check for rate limit
      const isRateLimit = err.message?.includes('429') || err.status === 429 || err.message?.includes('quota');
      if (isRateLimit && attempt < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        console.warn(`[gemini] Rate limit hit (attempt ${attempt}/${MAX_RETRIES}), retrying in ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }
      // Non-retryable or last attempt
      break;
    }
  }

  throw lastError || new Error('Gemini analysis failed after retries');
}

module.exports = { analyze, buildPrompt };
