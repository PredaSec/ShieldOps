import React, { useState, useRef, useEffect } from 'react';
import { awsValidate, awsDeploy, awsJobStatus } from '../api/client.js';

/**
 * AWS Deployment Console — Plan 5.4
 *
 * Security guarantees (enforced here, complemented by backend):
 *  - Credential values are held ONLY in React component state (memory).
 *  - They are NEVER written to localStorage, sessionStorage, cookies, or any DOM attribute.
 *  - All credential inputs use type="password" so values are not exposed in the DOM as text.
 *  - Deploy button is disabled until ALL preflight checks pass (allPassed === true from backend).
 *  - A confirmation dialog is shown before deploy.
 *  - Short-lived/session credentials are recommended in help text.
 */

const INITIAL_CREDS = {
  accessKeyId:     '',
  secretAccessKey: '',
  sessionToken:    '',
  region:          'us-east-1',
  environment:     'production',
  ecrRepo:         '',
  eksCluster:      '',
};

function ChecklistItem({ check }) {
  const icon = check.passed ? '✓' : '✗';
  return (
    <div className="checklist-item">
      <span className={`check-icon ${check.passed ? 'pass' : 'fail'}`}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 13 }}>{check.name.replace(/_/g, ' ')}</div>
        {check.detail && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{check.detail}</div>}
      </div>
      <span className={`badge ${check.passed ? 'badge-success' : 'badge-failed'}`}>
        {check.passed ? 'PASS' : 'FAIL'}
      </span>
    </div>
  );
}

export default function AwsDeployPage() {
  // Credentials in component state ONLY — never persisted anywhere
  const [creds,        setCreds]        = useState(INITIAL_CREDS);
  const [validating,   setValidating]   = useState(false);
  const [preflight,    setPreflight]    = useState(null);   // { checks, allPassed }
  const [preflightErr, setPreflightErr] = useState(null);
  const [deploying,    setDeploying]    = useState(false);
  const [jobId,        setJobId]        = useState(null);
  const [jobStatus,    setJobStatus]    = useState(null);   // 'running' | 'succeeded' | 'failed'
  const [logs,         setLogs]         = useState([]);
  const [appUrl,       setAppUrl]       = useState(null);
  const [deployErr,    setDeployErr]    = useState(null);
  const logRef     = useRef(null);
  const esRef      = useRef(null);

  // Derived: Deploy enabled only when all preflight checks pass
  const deployEnabled = preflight?.allPassed === true && !deploying && jobStatus !== 'running';

  // Auto-scroll log console
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Clean up SSE on unmount
  useEffect(() => () => { if (esRef.current) esRef.current.close(); }, []);

  function updateCred(field, value) {
    // Defensive: never let credential values be empty strings that look like they might have leaked
    setCreds(prev => ({ ...prev, [field]: value }));
    // Reset preflight when creds change — forces re-validation
    if (['accessKeyId', 'secretAccessKey', 'sessionToken'].includes(field)) {
      setPreflight(null);
    }
  }

  async function handleValidate(e) {
    e.preventDefault();
    setValidating(true);
    setPreflight(null);
    setPreflightErr(null);
    try {
      const result = await awsValidate(creds);
      setPreflight(result);
    } catch (err) {
      setPreflightErr(err.response?.data?.error || err.message);
    } finally {
      setValidating(false);
    }
  }

  async function handleDeploy() {
    if (!deployEnabled) return;
    if (!window.confirm(
      `Deploy to ${creds.environment} (${creds.region})?\n\nThis will push the image to ECR and run helm upgrade on the EKS cluster.\n\nProceed?`
    )) return;

    setDeploying(true);
    setDeployErr(null);
    setLogs([]);
    setJobStatus('running');
    setAppUrl(null);

    try {
      const res = await awsDeploy(creds);
      setJobId(res.jobId);
      streamLogs(res.jobId);
    } catch (err) {
      setDeployErr(err.response?.data?.error || err.message);
      setJobStatus('failed');
      setDeploying(false);
    }
  }

  function streamLogs(jobId) {
    // Use SSE for live log streaming
    const token  = sessionStorage.getItem('auth_token');
    const url    = `/api/aws/deploy/${jobId}`;

    // Attach auth token via header isn't possible with EventSource — use polling fallback
    // (EventSource doesn't support custom headers)
    esRef.current = null;

    // Poll every second
    const pollInterval = setInterval(async () => {
      try {
        const data = await awsJobStatus(jobId);
        setLogs(data.logs || []);
        if (data.status !== 'running') {
          clearInterval(pollInterval);
          setJobStatus(data.status);
          setAppUrl(data.appUrl);
          if (data.error) setDeployErr(data.error);
          setDeploying(false);
        }
      } catch {
        clearInterval(pollInterval);
        setJobStatus('failed');
        setDeploying(false);
      }
    }, 1000);
  }

  function handleClearCreds() {
    // Explicitly zero out the credential state
    setCreds(INITIAL_CREDS);
    setPreflight(null);
    setPreflightErr(null);
    setJobId(null);
    setJobStatus(null);
    setLogs([]);
    setAppUrl(null);
    setDeployErr(null);
  }

  return (
    <div className="page">
      <div className="page-title">AWS Deployment Console</div>

      <div className="info-msg" style={{ marginBottom: 16 }}>
        <strong>Security note:</strong> Use short-lived credentials (IAM role session tokens / AWS SSO) rather than long-lived access keys.
        Credentials are held in browser memory only and never stored to disk or sent to any service other than the ShieldOps backend.
        The backend never persists raw credentials to the database or logs.
      </div>

      <div className="grid-2">
        {/* Left: Credential form + preflight */}
        <div>
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 16 }}>Step 1 — AWS Credentials</div>
            <form onSubmit={handleValidate}>
              <div className="form-group">
                <label>Access Key ID <span style={{ color: 'var(--danger)' }}>*</span></label>
                <input
                  type="password"
                  autoComplete="off"
                  value={creds.accessKeyId}
                  onChange={e => updateCred('accessKeyId', e.target.value)}
                  placeholder="AKIA…"
                  required
                />
                <div className="hint">Must start with AKIA, ASIA, AROA, etc. (20 chars)</div>
              </div>
              <div className="form-group">
                <label>Secret Access Key <span style={{ color: 'var(--danger)' }}>*</span></label>
                <input
                  type="password"
                  autoComplete="off"
                  value={creds.secretAccessKey}
                  onChange={e => updateCred('secretAccessKey', e.target.value)}
                  placeholder="40-character secret"
                  required
                />
              </div>
              <div className="form-group">
                <label>Session Token <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>(optional — required for temporary/SSO creds)</span></label>
                <input
                  type="password"
                  autoComplete="off"
                  value={creds.sessionToken}
                  onChange={e => updateCred('sessionToken', e.target.value)}
                  placeholder="Paste session token from aws sts assume-role…"
                />
              </div>
              <div className="grid-2" style={{ gap: 10 }}>
                <div className="form-group">
                  <label>Region</label>
                  <select value={creds.region} onChange={e => updateCred('region', e.target.value)}>
                    {['us-east-1','us-east-2','us-west-1','us-west-2','eu-west-1','eu-west-2','eu-central-1','ap-southeast-1','ap-northeast-1'].map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Environment</label>
                  <select value={creds.environment} onChange={e => updateCred('environment', e.target.value)}>
                    <option value="production">production</option>
                    <option value="staging">staging</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>ECR Repository (optional)</label>
                <input
                  value={creds.ecrRepo}
                  onChange={e => updateCred('ecrRepo', e.target.value)}
                  placeholder="shieldops-backend"
                />
              </div>
              <div className="form-group">
                <label>EKS Cluster Name (optional)</label>
                <input
                  value={creds.eksCluster}
                  onChange={e => updateCred('eksCluster', e.target.value)}
                  placeholder="shieldops-cluster"
                />
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="primary" disabled={validating || !creds.accessKeyId || !creds.secretAccessKey}>
                  {validating ? <><span className="spinner" style={{ marginRight: 6 }} /> Validating…</> : 'Validate Credentials'}
                </button>
                <button type="button" className="secondary" onClick={handleClearCreds}>
                  Clear
                </button>
              </div>
            </form>
          </div>

          {/* Preflight checklist */}
          {preflightErr && <div className="error-msg">{preflightErr}</div>}

          {preflight && (
            <div className="card">
              <div style={{ fontWeight: 600, marginBottom: 12 }}>
                Preflight Results
                {preflight.allPassed
                  ? <span className="badge badge-success" style={{ marginLeft: 10 }}>ALL PASS</span>
                  : <span className="badge badge-failed"  style={{ marginLeft: 10 }}>ISSUES FOUND</span>
                }
              </div>
              {preflight.checks.map((c, i) => <ChecklistItem key={i} check={c} />)}

              <div style={{ marginTop: 16, padding: '10px 14px', background: '#0a0d14', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                {preflight.allPassed
                  ? 'All checks passed. You may proceed to deploy.'
                  : 'One or more checks failed. Fix the issues above and re-validate before deploying.'
                }
              </div>
            </div>
          )}
        </div>

        {/* Right: Deploy + log stream */}
        <div>
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Step 2 — Deploy</div>

            {!preflight && (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
                Complete Step 1 (validate credentials) before deploying.
              </div>
            )}

            {preflight && !preflight.allPassed && (
              <div className="error-msg" style={{ marginBottom: 12 }}>
                Deploy is disabled until all preflight checks pass.
              </div>
            )}

            <button
              className="success"
              style={{ width: '100%', padding: '12px', fontSize: 15 }}
              onClick={handleDeploy}
              disabled={!deployEnabled}
              title={deployEnabled ? 'Click to deploy' : 'Complete preflight validation first'}
            >
              {deploying
                ? <><span className="spinner" style={{ marginRight: 8 }} /> Deploying…</>
                : deployEnabled
                  ? 'Deploy to ' + creds.environment
                  : 'Deploy (disabled — validate first)'
              }
            </button>

            {deployErr && <div className="error-msg" style={{ marginTop: 10 }}>{deployErr}</div>}

            {jobStatus === 'succeeded' && appUrl && (
              <div className="success-msg" style={{ marginTop: 10 }}>
                Deploy succeeded! <a href={appUrl} target="_blank" rel="noreferrer">{appUrl}</a>
              </div>
            )}

            {jobId && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontWeight: 500, fontSize: 13 }}>Job Log</span>
                  {jobStatus === 'running'   && <span className="badge badge-running">running</span>}
                  {jobStatus === 'succeeded' && <span className="badge badge-success">succeeded</span>}
                  {jobStatus === 'failed'    && <span className="badge badge-failed">failed</span>}
                  <code style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{jobId.slice(0, 8)}…</code>
                </div>
                <div className="log-console" ref={logRef}>
                  {logs.length === 0 && <span style={{ color: '#4ade8060' }}>Waiting for log output…</span>}
                  {logs.map((line, i) => <div key={i}>{line}</div>)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
