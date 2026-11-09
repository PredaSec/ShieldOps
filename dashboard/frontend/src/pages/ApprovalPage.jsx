import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { fetchPipeline, fetchPipelines, approvePipeline, rejectPipeline } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';

function ApprovalDetail({ pipelineId, onDone }) {
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [comment,  setComment]  = useState('');
  const [acting,   setActing]   = useState(false);
  const [msg,      setMsg]      = useState(null);

  useEffect(() => {
    fetchPipeline(pipelineId)
      .then(setData)
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [pipelineId]);

  async function handleDecision(action) {
    if (!window.confirm(`${action === 'approve' ? 'Approve' : 'Reject'} pipeline #${data.pipeline.gitlab_pipeline_id}?`)) return;
    setActing(true);
    try {
      const fn = action === 'approve' ? approvePipeline : rejectPipeline;
      await fn(pipelineId, comment);
      setMsg({ type: action, text: `Pipeline ${action === 'approve' ? 'approved' : 'rejected'} successfully.` });
      if (onDone) onDone();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setActing(false);
    }
  }

  if (loading) return <div><span className="spinner" /> Loading…</div>;
  if (error)   return <div className="error-msg">{error}</div>;
  if (!data)   return null;

  const { pipeline, ai_report, deployment } = data;
  const decided = deployment?.status === 'approved' || deployment?.status === 'rejected';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <strong>Pipeline #{pipeline.gitlab_pipeline_id}</strong>
        <StatusBadge status={pipeline.status} />
        <code style={{ fontSize: 12, color: 'var(--text-muted)' }}>{pipeline.branch}</code>
      </div>

      {msg && (
        <div className={msg.type === 'approve' ? 'success-msg' : 'error-msg'} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {decided && (
        <div className="info-msg" style={{ marginBottom: 12 }}>
          Decision recorded: <StatusBadge status={deployment.status} /> by {deployment.approved_by} — {deployment.comment || '(no comment)'}
        </div>
      )}

      {ai_report && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            AI Report
            <StatusBadge status={ai_report.risk_level || 'unknown'} />
            <span style={{ color: ai_report.recommendation === 'DEPLOY' ? 'var(--success)' : 'var(--danger)', fontSize: 13 }}>
              → {ai_report.recommendation}
            </span>
          </div>
          <div style={{ background: '#0a0d14', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 18px', maxHeight: 300, overflowY: 'auto' }}>
            <ReactMarkdown>{ai_report.content_md || '*No report*'}</ReactMarkdown>
          </div>
        </div>
      )}

      {!decided && (
        <div>
          <div className="form-group">
            <label>Comment (optional)</label>
            <textarea
              rows={3}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Reason for approval or rejection…"
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="success" onClick={() => handleDecision('approve')} disabled={acting}>
              {acting ? <span className="spinner" /> : null} Approve
            </button>
            <button className="danger" onClick={() => handleDecision('reject')} disabled={acting}>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ApprovalPage() {
  const { id }      = useParams();
  const navigate    = useNavigate();
  const [pipelines, setPipelines] = useState([]);
  const [selected,  setSelected]  = useState(id || null);

  useEffect(() => {
    fetchPipelines().then(data => {
      // Show only pipelines without a final decision
      setPipelines(data.filter(p => !p.deploy_status || p.deploy_status === 'pending'));
    }).catch(() => {});
  }, []);

  return (
    <div className="page">
      <div className="page-title">Approval Queue</div>
      <div className="grid-2">
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Branch</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--text-muted)', padding: 20 }}>No pending approvals</td></tr>
              )}
              {pipelines.map(p => (
                <tr
                  key={p.id}
                  onClick={() => setSelected(String(p.id))}
                  style={{ cursor: 'pointer', background: selected === String(p.id) ? '#ffffff08' : undefined }}
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
          {selected ? (
            <ApprovalDetail
              key={selected}
              pipelineId={selected}
              onDone={() => {
                fetchPipelines().then(data =>
                  setPipelines(data.filter(p => !p.deploy_status || p.deploy_status === 'pending'))
                ).catch(() => {});
              }}
            />
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>Select a pipeline from the queue to review.</div>
          )}
        </div>
      </div>
    </div>
  );
}
