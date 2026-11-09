'use strict';

/**
 * loader.js — discovers report files in a directory and routes them to parsers
 *
 * File-name → parser routing:
 *   gitleaks*.json         → gitleaks parser
 *   semgrep*.sarif         → semgrep SARIF parser
 *   semgrep*.json          → semgrep JSON parser
 *   trivy*.json            → trivy parser
 *   checkov*.json          → checkov parser
 *   tfsec*.json            → tfsec parser
 *   conftest*.json         → conftest parser
 *   zap*.json              → zap parser
 */

const fs = require('fs');
const path = require('path');
const glob = require('./glob-compat');

const parsers = {
  gitleaks: require('./parsers/gitleaks'),
  semgrep: require('./parsers/semgrep'),
  trivy: require('./parsers/trivy'),
  checkov: require('./parsers/checkov'),
  tfsec: require('./parsers/tfsec'),
  conftest: require('./parsers/conftest'),
  zap: require('./parsers/zap'),
};

/**
 * Determine which parser to use based on filename
 * @param {string} filename - basename of file
 * @returns {string|null} parser name or null if not recognized
 */
function detectParser(filename) {
  const name = path.basename(filename).toLowerCase();
  if (name.startsWith('gitleaks')) return 'gitleaks';
  if (name.startsWith('semgrep') || name.endsWith('.sarif')) return 'semgrep';
  if (name.startsWith('trivy')) return 'trivy';
  if (name.startsWith('checkov')) return 'checkov';
  if (name.startsWith('tfsec')) return 'tfsec';
  if (name.startsWith('conftest') || name.startsWith('opa')) return 'conftest';
  if (name.startsWith('zap')) return 'zap';
  return null;
}

/**
 * Load and parse reports from a directory path or glob pattern
 * @param {string} inputPath - directory path or glob pattern
 * @returns {Promise<import('./types').Finding[]>}
 */
async function loadReports(inputPath) {
  const allFindings = [];

  // Resolve glob or directory
  let files = [];

  if (fs.existsSync(inputPath) && fs.statSync(inputPath).isDirectory()) {
    // Directory: scan for JSON and SARIF files
    const dirFiles = fs.readdirSync(inputPath);
    files = dirFiles
      .filter((f) => f.endsWith('.json') || f.endsWith('.sarif'))
      .map((f) => path.join(inputPath, f));
  } else {
    // Treat as glob pattern (simple implementation for CI use)
    files = glob.expand(inputPath);
  }

  if (files.length === 0) {
    console.warn(`[loader] No report files found at: ${inputPath}`);
    return allFindings;
  }

  for (const file of files) {
    if (!fs.existsSync(file)) continue;

    const parserName = detectParser(file);
    if (!parserName) {
      console.warn(`[loader] No parser for file: ${path.basename(file)} — skipping`);
      continue;
    }

    let raw;
    try {
      const content = fs.readFileSync(file, 'utf8');
      raw = JSON.parse(content);
    } catch (err) {
      console.warn(`[loader] Could not parse ${path.basename(file)}: ${err.message}`);
      continue;
    }

    try {
      const parser = parsers[parserName];
      const findings = parser.parse(raw);
      console.log(`[loader] ${path.basename(file)} → ${parserName} → ${findings.length} finding(s)`);
      allFindings.push(...findings);
    } catch (err) {
      console.warn(`[loader] Parser error for ${path.basename(file)}: ${err.message}`);
    }
  }

  return allFindings;
}

module.exports = { loadReports, detectParser };
