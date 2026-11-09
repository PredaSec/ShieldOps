'use strict';

// Minimal OpenRouter call for a short, plain remediation tip — used as a BACKUP
// when the scanner's own fix hint isn't enough. Degrades gracefully with no key.

const KEY   = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.OPENROUTER_MODEL   || 'nvidia/nemotron-3.5-super-vl:free';
// Backup models OpenRouter tries in order if the primary is busy (free models share a pool).
const FALLBACK_MODELS = (process.env.OPENROUTER_FALLBACK_MODELS || '')
  .split(',').map((m) => m.trim()).filter(Boolean);
// Reasoning models think before answering; too low a cap leaves the tip empty.
const MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS) || 4000;
const URL   = 'https://openrouter.ai/api/v1/chat/completions';

async function suggestFix({ tool, rule, file, line, message } = {}) {
  if (!KEY) return { ok: false, reason: 'OPENROUTER_API_KEY not configured on the dashboard' };

  const prompt =
    `A "${tool}" security scan flagged a finding. Give a short, practical fix ` +
    `(2-4 sentences, plain language, include a corrected code idea if obvious). ` +
    `Do not be verbose.\n\n` +
    `Rule: ${rule}\nFile: ${file}${line ? ':' + line : ''}\nFinding: ${message}`;

  // A cold outbound connection occasionally times out (no IPv6 route in the
  // container); retry once on a network-level failure before giving up.
  const post = (attempt = 1) => fetch(URL, {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      ...(FALLBACK_MODELS.length && { models: [MODEL, ...FALLBACK_MODELS] }),
      messages: [
        { role: 'system', content: 'You are a senior application security engineer giving concise remediation advice.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
    }),
  }).catch((e) => {
    if (attempt < 2 && e.name !== 'TimeoutError') return post(attempt + 1);
    throw e;
  });

  try {
    const resp = await post();
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, reason: `OpenRouter HTTP ${resp.status}${t ? ': ' + t.slice(0, 120) : ''}` };
    }
    const data = await resp.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return { ok: false, reason: 'no content from model' };
    return { ok: true, suggestion: text.trim() };
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'AI provider took too long (90s)' : (e.cause?.code || e.message);
    return { ok: false, reason: `Could not reach OpenRouter: ${why}` };
  }
}

module.exports = { suggestFix };
