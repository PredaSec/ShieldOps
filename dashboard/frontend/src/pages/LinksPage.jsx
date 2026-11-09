import React, { useEffect, useState } from 'react';
import { fetchLinks } from '../api/client.js';

const LINK_DEFS = [
  { key: 'grafana',    label: 'Grafana',    desc: 'Dashboards, metrics visualization', icon: '📊' },
  { key: 'prometheus', label: 'Prometheus', desc: 'Metrics scraping & alerts',          icon: '🔥' },
  { key: 'loki',       label: 'Loki',       desc: 'Log aggregation',                    icon: '📋' },
  { key: 'zap',        label: 'OWASP ZAP',  desc: 'DAST scan reports',                  icon: '🕷️'  },
  { key: 'trivy',      label: 'Trivy',      desc: 'Container & IaC vulnerability reports', icon: '🔍' },
  { key: 'semgrep',    label: 'Semgrep',    desc: 'SAST findings',                      icon: '🔬' },
  { key: 'gitlab',     label: 'GitLab',     desc: 'CI/CD pipelines & source code',      icon: '🦊' },
];

export default function LinksPage() {
  const [links,   setLinks]   = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchLinks()
      .then(setLinks)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <div className="page-title">External Tool Links</div>
      <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
        Deep links to all ShieldOps platform tools. These open in a new tab — they are not embedded.
        URLs are configured via environment variables or Settings.
      </p>

      {loading && <div><span className="spinner" /> Loading links…</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {LINK_DEFS.map(def => {
          const url = links[def.key];
          return (
            <div key={def.key} className="card" style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 28 }}>{def.icon}</div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{def.label}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>{def.desc}</div>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    <button className="secondary" style={{ fontSize: 12, padding: '4px 12px' }}>
                      Open {def.label} →
                    </button>
                  </a>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Not configured</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
