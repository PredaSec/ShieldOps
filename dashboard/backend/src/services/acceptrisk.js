'use strict';

// "Accept risk" for one finding: suppress it using the scanner's NATIVE ignore
// mechanism, committed to the app repo (the commit is the audit trail). The commit
// itself triggers a fresh pipeline, so the gate re-runs clean.
//   gitleaks -> append fingerprint to .gitleaksignore
//   trivy    -> append CVE id to .trivyignore
//   semgrep  -> append `# nosemgrep` to the offending source line

const gitlab = require('./gitlab');

const COMMENT = {
  py: '#', rb: '#', sh: '#', yaml: '#', yml: '#', tf: '#', toml: '#',
  js: '//', jsx: '//', ts: '//', tsx: '//', go: '//', java: '//', c: '//', cpp: '//', php: '//',
};
const commentFor = (file) => COMMENT[String(file || '').split('.').pop().toLowerCase()] || '#';

async function acceptRisk({ projectId, branch, tool, rule, file, line, fingerprint }) {
  if (tool === 'gitleaks') {
    const fp = fingerprint || `${file}:${rule}:${line}`;
    return appendLine(projectId, branch, '.gitleaksignore', fp,
      `chore(security): accept risk — gitleaks ${rule} in ${file} (via dashboard)`);
  }
  if (tool === 'trivy') {
    if (!rule) return { ok: false, reason: 'no CVE id on finding' };
    return appendLine(projectId, branch, '.trivyignore', rule,
      `chore(security): accept risk — trivy ${rule} (via dashboard)`);
  }
  if (tool === 'semgrep') {
    return nosemgrep(projectId, branch, file, line, rule);
  }
  return { ok: false, reason: `accept-risk not supported for '${tool}'` };
}

async function appendLine(projectId, branch, path, entry, message) {
  const cur = await gitlab.getFile(projectId, branch, path);
  if (!cur.ok) return cur;
  const existing = cur.content || '';
  if (existing.split('\n').some(l => l.trim() === entry.trim())) {
    return { ok: true, already: true, desc: `${entry} already in ${path}` };
  }
  const body = (existing && !existing.endsWith('\n') ? existing + '\n' : existing) + entry + '\n';
  const put = await gitlab.putFile(projectId, branch, path, body, message, cur.exists);
  return put.ok ? { ok: true, desc: `added \`${entry}\` to ${path}` } : put;
}

async function nosemgrep(projectId, branch, file, line, rule) {
  if (!file || !line) return { ok: false, reason: 'finding has no file/line to annotate' };
  const cur = await gitlab.getFile(projectId, branch, file);
  if (!cur.ok) return cur;
  if (!cur.exists) return { ok: false, reason: `${file} not found on ${branch}` };
  const lines = cur.content.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return { ok: false, reason: `line ${line} out of range in ${file}` };
  if (/nosemgrep/.test(lines[idx]) || /nosemgrep/.test(lines[idx - 1] || '')) {
    return { ok: true, already: true, desc: `${file}:${line} already suppressed` };
  }
  if (/(^|\/)Dockerfile(\.(?!md$)[\w-]+)?$|\.dockerfile$/i.test(file)) {
    // Dockerfiles have no trailing comments: `CMD [...]  # x` turns the exec-form
    // CMD into a broken shell command. Semgrep also honours the line above.
    lines.splice(idx, 0, `${lines[idx].match(/^\s*/)[0]}# nosemgrep`);
  } else {
    lines[idx] = lines[idx].replace(/\s*$/, '') + `  ${commentFor(file)} nosemgrep`;
  }
  const put = await gitlab.putFile(projectId, branch, file, lines.join('\n'),
    `chore(security): accept risk — semgrep ${rule} at ${file}:${line} (via dashboard)`, true);
  return put.ok ? { ok: true, desc: `added \`# nosemgrep\` at ${file}:${line}` } : put;
}

module.exports = { acceptRisk };
