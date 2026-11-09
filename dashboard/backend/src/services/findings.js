'use strict';

// Compact scanner-report parsers: turn a tool's raw JSON into a small, display-
// friendly list. Each finding: { severity, file, line, rule, message, fix }.
// The "fix" is the tool's OWN remediation hint (no AI needed) where available.

function clamp(s, n = 280) {
  if (s == null) return null;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function parseGitleaks(raw) {
  return (Array.isArray(raw) ? raw : []).map(f => ({
    severity: 'HIGH',
    file: f.File,
    line: f.StartLine,
    rule: f.RuleID || f.Rule || 'secret',
    message: clamp(f.Description || 'Hardcoded secret detected'),
    fix: 'Remove the secret from the code and rotate it; load it from a secret manager or CI variable instead.',
    fingerprint: f.Fingerprint || null,
  }));
}

const SEMGREP_SEV = { ERROR: 'HIGH', WARNING: 'MEDIUM', INFO: 'LOW' };

function parseSemgrep(raw) {
  const results = (raw && raw.results) || [];
  return results.map(r => {
    const extra = r.extra || {};
    const meta  = extra.metadata || {};
    const auto  = extra.fix || meta.fix;
    const ref   = Array.isArray(meta.references) ? meta.references[0] : null;
    return {
      severity: SEMGREP_SEV[(extra.severity || '').toUpperCase()] || extra.severity || 'MEDIUM',
      file: r.path,
      line: r.start && r.start.line,
      rule: String(r.check_id || '').split('.').pop() || 'rule',
      message: clamp(extra.message || r.check_id),
      // A concrete autofix counts as a tool recommendation; a bare link does not.
      fix: auto ? ('Suggested fix: ' + clamp(auto, 180)) : null,
      ref: ref || null,
    };
  });
}

function parseTrivy(raw) {
  const out = [];
  for (const res of (raw && raw.Results) || []) {
    for (const v of res.Vulnerabilities || []) {
      out.push({
        severity: v.Severity,
        file: res.Target,
        line: null,
        rule: v.VulnerabilityID,
        message: clamp(`${v.PkgName} ${v.InstalledVersion} — ${v.Title || v.VulnerabilityID}`),
        fix: v.FixedVersion
          ? `Upgrade ${v.PkgName} to ${v.FixedVersion}`
          : 'No fixed version upstream — pin/replace the package or apply a mitigation.',
        ref: v.PrimaryURL || null,
      });
    }
    for (const m of res.Misconfigurations || []) {
      out.push({
        severity: m.Severity,
        file: res.Target,
        line: (m.CauseMetadata && m.CauseMetadata.StartLine) || null,
        rule: m.ID,
        message: clamp(m.Title || m.Description),
        fix: clamp(m.Resolution) || null,
      });
    }
    for (const s of res.Secrets || []) {
      out.push({
        severity: s.Severity || 'HIGH', file: res.Target, line: s.StartLine,
        rule: s.RuleID, message: clamp(s.Title), fix: 'Remove and rotate the secret.',
      });
    }
  }
  return out;
}

// gate_name -> { tool, artifact file }. Drives which report to fetch + how to parse.
const GATE_MAP = {
  'g1-secrets':     { tool: 'gitleaks', file: 'gitleaks.json' },
  'g2-sast':        { tool: 'semgrep',  file: 'semgrep.json'  },
  'g3-trivy-fs':    { tool: 'trivy',    file: 'trivy-fs.json' },
  'g3-trivy-image': { tool: 'trivy',    file: 'trivy-image.json' },
};

const PARSERS = { gitleaks: parseGitleaks, semgrep: parseSemgrep, trivy: parseTrivy };

function parse(tool, raw) {
  const fn = PARSERS[tool];
  if (!fn) return [];
  try { return fn(raw).filter(f => f && (f.file || f.message)); }
  catch { return []; }
}

module.exports = { parse, GATE_MAP };
