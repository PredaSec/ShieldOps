#!/usr/bin/env node
'use strict';

/**
 * ShieldOps AI Analysis CLI
 * Usage: node src/index.js analyze --input <dir|globs> --stage staging|prod --out <dir>
 */

const path = require('path');
const fs = require('fs');
const { Command } = require('commander');

const { loadReports } = require('./loader');
const { summarize } = require('./summarize');
const { analyze: fallbackAnalyze } = require('./fallback');
const { render } = require('./render');

const program = new Command();

program
  .name('shieldops-ai')
  .description('ShieldOps AI security report analysis service')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze security scan reports and produce AI-powered recommendations')
  .requiredOption('--input <path>', 'Directory or glob pattern of report files to analyze')
  .option('--stage <stage>', 'Pipeline stage (staging|prod)', 'staging')
  .option('--out <dir>', 'Output directory for reports', '.')
  .option('--format <formats>', 'Output formats, comma-separated (json,md)', 'json,md')
  .option('--s3-bucket <bucket>', 'S3 bucket to upload reports (optional)', process.env.S3_REPORTS_BUCKET || '')
  .option('--s3-prefix <prefix>', 'S3 key prefix (e.g. pipeline-123/ai)', '')
  .option('--pipeline-id <id>', 'Pipeline ID for S3 path and report metadata', process.env.CI_PIPELINE_ID || 'local')
  .action(async (opts) => {
    const stage = opts.stage;
    const outDir = path.resolve(opts.out);
    const formats = opts.format.split(',').map((f) => f.trim());
    const pipelineId = opts.pipelineId;

    // Ensure output directory exists
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`[shieldops-ai] Loading reports from: ${opts.input}`);

    // Load and parse all reports
    let findings;
    try {
      findings = await loadReports(opts.input);
      console.log(`[shieldops-ai] Loaded ${findings.length} findings from scan reports`);
    } catch (err) {
      console.error(`[shieldops-ai] Error loading reports: ${err.message}`);
      process.exit(1);
    }

    // Summarize
    const summary = summarize(findings);
    console.log(`[shieldops-ai] Summary: CRITICAL=${summary.bySeverity.CRITICAL} HIGH=${summary.bySeverity.HIGH} MEDIUM=${summary.bySeverity.MEDIUM} LOW=${summary.bySeverity.LOW} | blocking=${summary.blocking}`);

    // Provider preference: OpenRouter -> Gemini -> rule-based fallback.
    let report;
    const providers = [];
    if (process.env.OPENROUTER_API_KEY) providers.push(['OpenRouter', './openrouter']);
    if (process.env.GEMINI_API_KEY)     providers.push(['Gemini', './gemini']);

    for (const [name, mod] of providers) {
      try {
        console.log(`[shieldops-ai] ${name} key present — attempting ${name} analysis...`);
        const { analyze: providerAnalyze } = require(mod);
        report = await providerAnalyze(summary, stage);
        console.log(`[shieldops-ai] ${name} analysis complete. Recommendation: ${report.recommendation}`);
        break;
      } catch (err) {
        console.warn(`[shieldops-ai] ${name} failed (${err.message})`);
      }
    }

    if (!report) {
      if (providers.length === 0) console.log('[shieldops-ai] No AI provider key set — using rule-based fallback analysis');
      else console.warn('[shieldops-ai] All AI providers failed — using rule-based fallback analysis');
      report = fallbackAnalyze(summary, stage);
      console.log(`[shieldops-ai] Fallback analysis complete. Recommendation: ${report.recommendation}`);
    }

    // Add pipeline metadata
    report.pipelineId = pipelineId;
    report.commit = process.env.CI_COMMIT_SHA || 'unknown';

    // Write outputs
    const outSuffix = stage === 'prod' ? 'prod' : 'staging';
    const jsonPath = path.join(outDir, `ai-report-${outSuffix}.json`);
    const mdPath = path.join(outDir, `ai-report-${outSuffix}.md`);

    if (formats.includes('json')) {
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      console.log(`[shieldops-ai] Written: ${jsonPath}`);
    }

    if (formats.includes('md')) {
      const markdown = render(report);
      fs.writeFileSync(mdPath, markdown);
      console.log(`[shieldops-ai] Written: ${mdPath}`);
    }

    // Upload to S3 if configured
    if (opts.s3Bucket) {
      await uploadToS3(opts.s3Bucket, opts.s3Prefix || `${pipelineId}/ai`, outDir, outSuffix, formats);
    } else if (process.env.S3_REPORTS_BUCKET && process.env.AWS_ENDPOINT_URL) {
      const prefix = `${pipelineId}/g${stage === 'prod' ? '8' : '6'}-ai-${outSuffix}`;
      await uploadToS3(process.env.S3_REPORTS_BUCKET, prefix, outDir, outSuffix, formats);
    }

    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`ShieldOps AI Analysis Summary`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Stage:          ${stage}`);
    console.log(`Source:         ${report.source}`);
    console.log(`Risk Score:     ${report.riskScore}/10 (${report.riskLevel})`);
    console.log(`Recommendation: ${report.recommendation}`);
    console.log(`Rationale:      ${report.rationale}`);
    console.log(`${'='.repeat(60)}\n`);

    // Always exit 0 — human decides (non-blocking by design)
    process.exit(0);
  });

/**
 * Upload reports to S3 via AWS CLI (if available) or AWS SDK
 */
async function uploadToS3(bucket, prefix, outDir, suffix, formats) {
  const { execSync } = require('child_process');
  const endpoint = process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT || '';
  const endpointArg = endpoint ? `--endpoint-url "${endpoint}"` : '';

  for (const fmt of formats) {
    if (fmt === 'json' || fmt === 'md') {
      const filename = `ai-report-${suffix}.${fmt}`;
      const localPath = path.join(outDir, filename);
      const s3Key = `s3://${bucket}/${prefix}/${filename}`;
      if (!fs.existsSync(localPath)) continue;

      try {
        execSync(`aws ${endpointArg} s3 cp "${localPath}" "${s3Key}" --no-progress`, { stdio: 'pipe' });
        console.log(`[shieldops-ai] Uploaded to ${s3Key}`);
      } catch (err) {
        // Non-fatal — S3 upload failures don't block the pipeline
        console.warn(`[shieldops-ai] S3 upload failed (non-fatal): ${err.message}`);
      }
    }
  }
}

program.parse(process.argv);
