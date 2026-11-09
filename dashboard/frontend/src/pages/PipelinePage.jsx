import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { fetchPipeline, rerunPipeline, fetchGateFindings, aiFix, acceptRisk, deployToAws } from '../api/client.js';
import StatusBadge from '../components/StatusBadge.jsx';

const linkBtn = {
  background: 'none', border: 'none', color: 'var(--accent, #6ab0ff)',
  cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 12, textDecoration: 'underline',
};

// One scanner finding: file:line, rule, message, the tool's own fix hint, and an
// optional AI suggestion fetched on demand.
function Finding({ pipelineId, tool, f }) {
  const [ai, setAi]   = useState({ loading: false, text: null, err: null });
  const [risk, setRisk] = useState({ loading: false, msg: null, err: null });
  async function askAi() {
    setAi({ loading: true, text: null, err: null });
    try {
      const d = await aiFix(pipelineId, { tool, rule: f.rule, file: f.file, line: f.line, message: f.message });
      setAi({ loading: false, text: d.suggestion, err: null });
    } catch (e) {
      setAi({ loading: false, text: null, err: e.response?.data?.error || e.message });
    }
  }
  async function accept() {
    if (!window.confirm(`Accept risk for ${f.rule} (${f.file}${f.line ? ':' + f.line : ''})?\nThis suppresses the finding and re-runs the pipeline.`)) return;
    setRisk({ loading: true, msg: null, err: null });
    try {
      const d = await acceptRisk(pipelineId, { tool, rule: f.rule, file: f.file, line: f.line, fingerprint: f.fingerprint });
      setRisk({ loading: false, msg: `${d.accepted} — ${d.note}`, err: null });
    } catch (e) {
      setRisk({ loading: false, msg: null, err: e.response?.data?.error || e.message });
    }
  }

  // If the tool gave a concrete fix, show it. If not, automatically ask the AI.
  useEffect(() => { if (!f.fix) askAi(); }, []);

  return (
    <div style={{ borderLeft: '3px solid var(--border)', padding: '8px 12px', margin: '8px 0' }}>
      <div style={{ fontSize: 13 }}>
        <span className={`badge badge-${(f.severity || 'medium').toLowerCase()}`}>{f.severity}</span>{' '}
        <code style={{ fontSize: 12 }}>{f.file}{f.line ? ':' + f.line : ''}</code>{' '}
        <strong>{f.rule}</strong>
      </div>
      <div style={{ fontSize: 13, margin: '4px 0' }}>{f.message}</div>

      {f.fix && <div style={{ fontSize: 12, color: 'var(--success)' }}>🛠 {f.fix}</div>}
      {f.ref && <div style={{ fontSize: 12, marginTop: 2 }}><a href={f.ref} target="_blank" rel="noreferrer">↗ reference</a></div>}

      {/* No tool fix -> AI fills in automatically. Tool fix present -> AI on demand. */}
      {!f.fix
        ? (ai.loading
            ? <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>🤖 No tool recommendation — asking AI…</div>
            : null)
        : <button style={{ ...linkBtn, marginTop: 6 }} onClick={askAi} disabled={ai.loading}>
            {ai.loading ? 'Asking AI…' : '🤖 Ask AI for more'}
          </button>
      }

      {ai.err && (
        <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>
          {ai.err} <button style={linkBtn} onClick={askAi}>retry</button>
        </div>
      )}
      {ai.text && (
        <div style={{ fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap', background: '#11151f', padding: '8px 10px', borderRadius: 4 }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>🤖 AI suggestion</div>
          {ai.text}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <button
          style={{ ...linkBtn, color: 'var(--danger, #e06c75)' }}
          onClick={accept}
          disabled={risk.loading || !!risk.msg}
          title="Suppress this finding (scanner ignore) and re-run, so later gates can run"
        >
          {risk.loading ? 'Accepting…' : (risk.msg ? '✓ Risk accepted' : '⚠ Accept risk & re-run')}
        </button>
        {risk.msg && <span style={{ fontSize: 12, color: 'var(--success)', marginLeft: 8 }}>{risk.msg}</span>}
        {risk.err && <span style={{ fontSize: 12, color: 'var(--danger)', marginLeft: 8 }}>{risk.err}</span>}
      </div>
    </div>
  );
}

function GateRow({ pipelineId, gate, firstFailed }) {
  const [open, setOpen]         = useState(false);
  const [findings, setFindings] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [note, setNote]         = useState(null);
  // Canonical scanner name from the findings endpoint (e.g. 'gitleaks'); the
  // DB's gate.tool is a display label ('ci') and is NOT what accept-risk expects.
  const [scanTool, setScanTool] = useState(null);
  // For non-scanner gates (deploy/AI/ZAP): the distilled failure reason + log link.
  const [reason, setReason]     = useState(null);
  const [jobUrl, setJobUrl]     = useState(null);

  // Any failed gate is inspectable: scanner gates show findings, the rest show why.
  const canInspect = gate.status === 'failed';

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && findings === null) {
      setLoading(true);
      try {
        const d = await fetchGateFindings(pipelineId, gate.gate_name);
        setFindings(d.findings || []);
        setScanTool(d.tool || null);
        setReason(d.reason || null);
        setJobUrl(d.jobWebUrl || null);
        setNote(d.note || null);
      } catch (e) {
        setFindings([]); setNote(e.response?.data?.error || e.message);
      } finally { setLoading(false); }
    }
  }

  return (
    <>
      <tr>
        <td>{gate.gate_name}</td>
        <td><code style={{ fontSize: 12 }}>{gate.tool}</code></td>
        <td>
          <StatusBadge status={gate.status} />
          {gate.status === 'skipped' && (
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
              {firstFailed ? <>blocked by <strong>{firstFailed.gate_name}</strong></> : 'pipeline stopped before this gate'}
            </div>
          )}
        </td>
        <td><SeverityBadges counts={gate.severity_counts} /></td>
        <td>
          {canInspect
            ? <button style={linkBtn} onClick={toggle}>{open ? 'Hide' : 'What failed?'}</button>
            : (gate.report_url ? <a href={gate.report_url} target="_blank" rel="noreferrer">View</a> : '—')}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: '#0a0d14' }}>
            {loading && <span className="spinner" />}
            {/* Non-scanner gate (deploy/AI/ZAP): show the plain-English failure reason. */}
            {!loading && reason && (
              <div style={{ padding: '10px 12px' }}>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 6 }}>Why it failed</div>
                <pre style={{
                  margin: 0, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5,
                  color: 'var(--danger, #e06c75)', background: '#160d10',
                  border: '1px solid var(--border)', borderRadius: 4, padding: '10px 12px',
                }}>{reason}</pre>
                {jobUrl && (
                  <div style={{ marginTop: 6 }}>
                    <a href={jobUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>↗ View full job log in GitLab</a>
                  </div>
                )}
              </div>
            )}
            {!loading && !reason && findings && findings.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{note || 'No findings reported.'}</div>
            )}
            {!loading && findings && findings.map((f, i) => (
              <Finding key={i} pipelineId={pipelineId} tool={scanTool || gate.tool} f={f} />
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function SeverityBadges({ counts }) {
  if (!counts) return null;
  const items = Object.entries(counts).filter(([, v]) => v > 0);
  if (!items.length) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>None</span>;
  return (
    <span>
      {items.map(([sev, count]) => (
        <span key={sev} className={`badge badge-${sev.toLowerCase()}`} style={{ marginRight: 4 }}>
          {sev} {count}
        </span>
      ))}
    </span>
  );
}

export default function PipelinePage() {
  const { id } = useParams();
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [rerun,   setRerun]   = useState({ loading: false, msg: null, url: null, error: null });
  const [aws,     setAws]     = useState({ loading: false, msg: null, error: null });

  useEffect(() => {
    fetchPipeline(id)
      .then(setData)
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleRerun() {
    setRerun({ loading: true, msg: null, url: null, error: null });
    try {
      const r = await rerunPipeline(id);
      setRerun({ loading: false, msg: `Re-run started — new pipeline #${r.pipeline_id}`, url: r.web_url, error: null });
    } catch (e) {
      setRerun({ loading: false, msg: null, url: null, error: e.response?.data?.error || e.message });
    }
  }

  async function handleDeployAws() {
    if (!window.confirm('Deploy this release to AWS (LocalStack)?\nPublishes the release to S3 + Secrets Manager via the g9 pipeline stage.')) return;
    setAws({ loading: true, msg: null, error: null });
    try {
      const r = await deployToAws(id);
      setAws({ loading: false, msg: `Deploy to LocalStack ${r.status === 'success' ? 'already done' : 'started'} (job ${r.job}).`, error: null });
    } catch (e) {
      setAws({ loading: false, msg: null, error: e.response?.data?.error || e.message });
    }
  }

  if (loading) return <div className="page"><span className="spinner" /> Loading…</div>;
  if (error)   return <div className="page"><div className="error-msg">{error}</div></div>;
  if (!data)   return null;

  const { pipeline, gates, ai_report, deployment } = data;

  // Gates in canonical pipeline order (g1-… < g2-… < …). A "skipped" gate didn't
  // run because an earlier gate failed and stopped the pipeline — surface that.
  const orderedGates = [...gates].sort((a, b) => (a.gate_name || '').localeCompare(b.gate_name || ''));
  const firstFailed  = orderedGates.find(g => g.status === 'failed');
  const skippedCount = orderedGates.filter(g => g.status === 'skipped').length;

  // "10/10" = every security/deploy gate passed (g1…g8). g9 is the AWS deploy
  // itself, so it's excluded from the unlock condition and shown separately.
  const g9Gate    = orderedGates.find(g => g.gate_name === 'g9-deploy-localstack');
  const coreGates = orderedGates.filter(g => g.gate_name !== 'g9-deploy-localstack');
  const allGreen  = coreGates.length > 0 && coreGates.every(g => g.status === 'success');
  const score     = `${coreGates.filter(g => g.status === 'success').length}/${coreGates.length}`;

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Link to="/" style={{ color: 'var(--text-muted)', fontSize: 13 }}>← Back</Link>
        <div className="page-title" style={{ margin: 0 }}>
          Pipeline #{pipeline.gitlab_pipeline_id}
        </div>
        <StatusBadge status={pipeline.status} />
        <button
          className="primary"
          style={{ marginLeft: 'auto' }}
          onClick={handleRerun}
          disabled={rerun.loading}
          title="Trigger a fresh pipeline on this branch"
        >
          {rerun.loading ? 'Re-running…' : '↻ Re-run pipeline'}
        </button>
      </div>
      {(rerun.msg || rerun.error) && (
        <div className={rerun.error ? 'error-msg' : ''} style={{ marginBottom: 16, fontSize: 13, color: rerun.error ? undefined : 'var(--success)' }}>
          {rerun.error || rerun.msg}
          {rerun.url && <> — <a href={rerun.url} target="_blank" rel="noreferrer">open in GitLab →</a></>}
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Pipeline Info</div>
          <table>
            <tbody>
              <tr><td style={{ color: 'var(--text-muted)', width: 120 }}>Branch</td><td><code>{pipeline.branch}</code></td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Commit</td><td><code style={{ fontSize: 12 }}>{pipeline.commit_sha?.slice(0, 8)}</code></td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Started</td><td>{pipeline.started_at ? new Date(pipeline.started_at).toLocaleString() : '—'}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Finished</td><td>{pipeline.finished_at ? new Date(pipeline.finished_at).toLocaleString() : '—'}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Deployment Decision</div>
          {deployment ? (
            <table><tbody>
              <tr><td style={{ color: 'var(--text-muted)', width: 120 }}>Status</td><td><StatusBadge status={deployment.status} /></td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>By</td><td>{deployment.approved_by || '—'}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>At</td><td>{deployment.decided_at ? new Date(deployment.decided_at).toLocaleString() : '—'}</td></tr>
              <tr><td style={{ color: 'var(--text-muted)' }}>Comment</td><td>{deployment.comment || '—'}</td></tr>
            </tbody></table>
          ) : (
            <div>
              <div style={{ color: 'var(--text-muted)', marginBottom: 10 }}>No decision yet.</div>
              <Link to={`/approvals/${id}`}><button className="primary">Go to Approval View →</button></Link>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Gate Results ({gates.length})</div>
        {skippedCount > 0 && firstFailed && (
          <div style={{
            background: '#1a1206', border: '1px solid var(--border)', borderRadius: 6,
            padding: '10px 14px', marginBottom: 12, fontSize: 13, color: 'var(--text-muted)',
          }}>
            ⏭ <strong>{skippedCount}</strong> gate{skippedCount > 1 ? 's' : ''} didn’t run because{' '}
            <strong style={{ color: 'var(--danger)' }}>{firstFailed.gate_name}</strong> failed — GitLab stops the
            pipeline at the first failed gate. Fix that gate, then <strong>↻ Re-run pipeline</strong> above.
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>Gate</th>
              <th>Tool</th>
              <th>Status</th>
              <th>Severities</th>
              <th>Report</th>
            </tr>
          </thead>
          <tbody>
            {orderedGates.length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--text-muted)' }}>No gate results yet</td></tr>
            )}
            {orderedGates.map(g => (
              <GateRow key={g.id} pipelineId={id} gate={g} firstFailed={firstFailed} />
            ))}
          </tbody>
        </table>
      </div>

      {/* 10/10 → promote to the emulated AWS cloud (LocalStack: S3 + Secrets Manager). */}
      <div className="card" style={{ borderColor: allGreen ? 'var(--success)' : 'var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 600 }}>
            {allGreen ? '✅ ' : ''}Security score: <span style={{ color: allGreen ? 'var(--success)' : 'var(--text-muted)' }}>{score}</span>
          </div>
          {g9Gate && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              AWS deploy: <StatusBadge status={g9Gate.status} />
            </span>
          )}
          <button
            className="primary"
            style={{ marginLeft: 'auto', opacity: allGreen ? 1 : 0.5 }}
            onClick={handleDeployAws}
            disabled={!allGreen || aws.loading || g9Gate?.status === 'success'}
            title={allGreen ? 'Publish the release to AWS (LocalStack): S3 + Secrets Manager' : 'Pass all gates (10/10) to unlock'}
          >
            {aws.loading ? 'Deploying…' : (g9Gate?.status === 'success' ? '✓ Deployed to LocalStack' : '🚀 Deploy to LocalStack (AWS)')}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          {allGreen
            ? 'All gates passed. Promote the release to the emulated AWS cloud — pushes the release artifact to S3 (ECR substitute) and the app secret to Secrets Manager.'
            : 'Complete all security gates to unlock the AWS (LocalStack) deploy.'}
        </div>
        {aws.msg   && <div style={{ fontSize: 13, color: 'var(--success)', marginTop: 6 }}>{aws.msg}</div>}
        {aws.error && <div className="error-msg" style={{ fontSize: 13, marginTop: 6 }}>{aws.error}</div>}
      </div>

      {ai_report && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>AI Security Report</div>
            <StatusBadge status={ai_report.risk_level || 'unknown'} />
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12 }}>
              Recommendation: <strong style={{ color: ai_report.recommendation === 'DEPLOY' ? 'var(--success)' : 'var(--danger)' }}>
                {ai_report.recommendation}
              </strong>
            </span>
          </div>
          <div style={{
            background: '#0a0d14',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '16px 20px',
            lineHeight: 1.7,
          }}>
            <ReactMarkdown>{ai_report.content_md || '*No report content*'}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
