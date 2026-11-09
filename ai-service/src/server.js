'use strict';

/**
 * ShieldOps AI Analysis HTTP Server
 * POST /analyze — analyze reports from a directory or inline findings
 * GET  /healthz  — health check
 */

const express = require('express');
const { loadReports } = require('./loader');
const { summarize } = require('./summarize');
const { analyze: fallbackAnalyze } = require('./fallback');
const { render } = require('./render');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

/**
 * GET /healthz
 */
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    service: 'shieldops-ai',
    version: '1.0.0',
    gemini: !!process.env.GEMINI_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /analyze
 * Body: { reportsDir: string, stage?: string } OR { findings: Finding[] }
 * Returns: AI report JSON
 */
app.post('/analyze', async (req, res) => {
  const { reportsDir, stage = 'staging', findings: inlineFindings } = req.body;

  try {
    let findings;

    if (inlineFindings && Array.isArray(inlineFindings)) {
      findings = inlineFindings;
    } else if (reportsDir) {
      findings = await loadReports(reportsDir);
    } else {
      return res.status(400).json({ error: 'Provide either reportsDir or findings array' });
    }

    const summary = summarize(findings);

    // Provider preference: OpenRouter -> Gemini -> rule-based fallback.
    let report;
    const providers = [];
    if (process.env.OPENROUTER_API_KEY) providers.push(['OpenRouter', './openrouter']);
    if (process.env.GEMINI_API_KEY)     providers.push(['Gemini', './gemini']);

    for (const [name, mod] of providers) {
      try {
        const { analyze: providerAnalyze } = require(mod);
        report = await providerAnalyze(summary, stage);
        break;
      } catch (err) {
        console.warn(`[server] ${name} failed: ${err.message}`);
      }
    }
    if (!report) report = fallbackAnalyze(summary, stage);

    res.json(report);
  } catch (err) {
    console.error('[server] Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /render
 * Body: AI report JSON
 * Returns: Markdown text
 */
app.post('/render', (req, res) => {
  try {
    // `render` is a local pure JSON->markdown function, not a server-side
    // template engine — no template/path injection is possible.
    const markdown = render(req.body); // nosemgrep: res-render-injection
    res.type('text/markdown').send(markdown);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[shieldops-ai] HTTP server listening on port ${PORT}`);
    console.log(`[shieldops-ai] Gemini: ${process.env.GEMINI_API_KEY ? 'enabled' : 'fallback mode'}`);
  });
}

module.exports = app;
