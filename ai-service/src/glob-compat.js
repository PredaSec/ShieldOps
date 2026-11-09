'use strict';

/**
 * Simple glob expansion for the patterns used in CI.
 * Supports: exact paths, *.ext patterns in directories.
 * Not a full glob implementation — handles CI use cases.
 */

const fs = require('fs');
const path = require('path');

function expand(pattern) {
  // Direct file path
  if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
    return [pattern];
  }

  // Simple "dir/*.ext" or "dir/*" pattern
  const lastSep = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf(path.sep));
  if (lastSep === -1) {
    // Pattern in current directory
    const dir = '.';
    const filePattern = pattern;
    return expandInDir(dir, filePattern);
  }

  const dir = pattern.substring(0, lastSep);
  const filePattern = pattern.substring(lastSep + 1);

  if (!fs.existsSync(dir)) return [];
  return expandInDir(dir, filePattern);
}

function expandInDir(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);

  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${regexStr}$`, 'i');

  return files
    .filter((f) => regex.test(f))
    .map((f) => path.join(dir, f));
}

module.exports = { expand };
