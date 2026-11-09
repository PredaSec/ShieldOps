import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { fetchPipelines, fetchPipeline } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';

export default function ReportsPage() {
  const [pipelines, setPipelines] = useState([]);
  const [selected,  setSelected]  = useState(null);
  const [report,    setReport]     = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [reportLoading, setReportLoading] = useState(false);

  useEffect(() => {
    fetchPipelines()
      .then(data => {
        setPipelines(data.filter(p => p.status === 'success' || p.status === 'failed'));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function loadReport(pipeline) {
    setSelected(pipeline);
    setReport(null);
    setReportLoading(true);
    try {
      const detail = await fetchPipeline(pipeline.id);
      setReport(detail.ai_report);
    } catch {}
    finally { setReportLoading(false); }
  }

  return (
    <div className="page">
      <div className="page-title">AI Reports Browser</div>
      <div className="grid-2">
        <div className="card" style={{ padding: 0 }}>
          {loading && <div style={{ padding: 20 }}><span className="spinner" /> Loading…</div>}
          <table>
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Branch</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.map(p => (
                <tr
                  key={p.id}
                  onClick={() => loadReport(p)}
                  style={{ cursor: 'pointer', background: selected?.id === p.id ? '#ffffff08' : undefined }}
                >
                  <td>#{p.gitlab_pipeline_id}</td>
                  <td><code style={{ fontSize: 12 }}>{p.branch}</code></td>
                  <td><StatusBadge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          {!selected && <div style={{ color: 'var(--text-muted)' }}>Select a pipeline to view its AI report.</div>}
          {selected && reportLoading && <div style={{ color: 'var(--text-muted)' }}><span className="spinner" /> Loading report…</div>}
          {selected && !reportLoading && !report && (
            <div style={{ color: 'var(--text-muted)' }}>
              No AI report for pipeline #{selected.gitlab_pipeline_id} — it failed before the AI-analysis gate (G6),
              so no report was generated. Pick a pipeline that reached G6 (e.g. one that passed the static gates).
            </div>
          )}
          {report && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                <strong>Pipeline #{selected.gitlab_pipeline_id}</strong>
                <StatusBadge status={report.risk_level} />
                <span style={{ color: report.recommendation === 'DEPLOY' ? 'var(--success)' : 'var(--danger)' }}>
                  {report.recommendation}
                </span>
              </div>
              <div style={{ background: '#0a0d14', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 18px', maxHeight: 500, overflowY: 'auto' }}>
                <ReactMarkdown>{report.content_md || '*No content*'}</ReactMarkdown>
              </div>
            </>
          )}
          {selected && report === null && !selected && (
            <div style={{ color: 'var(--text-muted)' }}>No AI report for this pipeline.</div>
          )}
        </div>
      </div>
    </div>
  );
}
