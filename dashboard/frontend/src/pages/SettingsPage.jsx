import React, { useEffect, useState } from 'react';
import { fetchSettings, updateSetting } from '../api/client.js';

export default function SettingsPage() {
  const [settings,    setSettings]    = useState({});
  const [recipients,  setRecipients]  = useState('');
  const [saving,      setSaving]      = useState(false);
  const [msg,         setMsg]         = useState(null);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    fetchSettings()
      .then(data => {
        setSettings(data);
        const r = data.notification_recipients;
        if (Array.isArray(r)) setRecipients(r.join(', '));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function saveRecipients() {
    setSaving(true);
    setMsg(null);
    try {
      const list = recipients.split(',').map(s => s.trim()).filter(Boolean);
      await updateSetting('notification_recipients', list);
      setMsg({ type: 'success', text: 'Notification recipients saved.' });
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="page"><span className="spinner" /> Loading…</div>;

  return (
    <div className="page">
      <div className="page-title">Settings</div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Notification Recipients</div>
        <div className="form-group">
          <label>Email addresses (comma-separated)</label>
          <input
            value={recipients}
            onChange={e => setRecipients(e.target.value)}
            placeholder="ops@example.com, security@example.com"
          />
          <div className="hint">
            These addresses receive approve/reject notifications and back-to-dev alerts.
          </div>
        </div>
        {msg && <div className={msg.type === 'success' ? 'success-msg' : 'error-msg'}>{msg.text}</div>}
        <button className="primary" onClick={saveRecipients} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 14 }}>About</div>
        <table>
          <tbody>
            <tr><td style={{ color: 'var(--text-muted)', width: 180 }}>Version</td><td>1.0.0</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>AI Service</td><td>{import.meta.env.VITE_AI_SERVICE_URL || '(from backend env)'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>GitLab</td><td>{settings.links?.gitlab || 'http://localhost:8929'}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
