export function truncateId(value, visible = 14) {
  if (!value) return '—';
  return value.length <= visible ? value : `${value.slice(0, visible)}...`;
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(value) {
  if (!value) return 'just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'just now';
  const diff = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function getStageMeta(stage, daysUntil = null) {
  if (stage === 3 || (daysUntil !== null && daysUntil <= 3)) {
    return { label: 'Stage 3', tone: 'danger' };
  }
  if (stage === 2 || (daysUntil !== null && daysUntil <= 5)) {
    return { label: 'Stage 2', tone: 'warning' };
  }
  if (stage === 1 || (daysUntil !== null && daysUntil <= 7)) {
    return { label: 'Stage 1', tone: 'success' };
  }
  return { label: 'No stage', tone: 'muted' };
}

export function clampNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function formatNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('en-IN') : '—';
}
