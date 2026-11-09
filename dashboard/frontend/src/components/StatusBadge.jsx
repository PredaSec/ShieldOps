import React from 'react';

const MAP = {
  success:   'badge-success',
  passed:    'badge-success',
  failed:    'badge-failed',
  running:   'badge-running',
  pending:   'badge-pending',
  approved:  'badge-success',
  rejected:  'badge-failed',
  cancelled: 'badge-pending',
  skipped:   'badge-pending',
  critical:  'badge-critical',
  high:      'badge-high',
  medium:    'badge-medium',
  low:       'badge-low',
};

export default function StatusBadge({ status }) {
  const cls = MAP[(status || '').toLowerCase()] || 'badge-pending';
  return <span className={`badge ${cls}`}>{status || 'unknown'}</span>;
}
