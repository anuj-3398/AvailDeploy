import React, { useEffect, useState } from 'react';
import type { Deployment, DeploymentState } from '../api.ts';

const STATE_CLASS: Record<DeploymentState, string> = {
  QUEUED: 'queued',
  INITIALIZING: 'building',
  BUILDING: 'building',
  UPLOADING: 'building',
  READY: 'ready',
  ERROR: 'error',
  CANCELED: 'queued',
};

const STATE_LABEL: Record<DeploymentState, string> = {
  QUEUED: 'Queued',
  INITIALIZING: 'Initializing',
  BUILDING: 'Building',
  UPLOADING: 'Finalizing',
  READY: 'Ready',
  ERROR: 'Error',
  CANCELED: 'Canceled',
};

export function StatusBadge({ state }: { state: DeploymentState }) {
  return (
    <span className={`badge ${STATE_CLASS[state]}`}>
      <span className="dot" />
      {STATE_LABEL[state]}
    </span>
  );
}

export function TargetBadge({ deployment }: { deployment: Deployment }) {
  if (deployment.isCurrentProduction) {
    return <span className="badge production">Production</span>;
  }
  return (
    <span className="badge">
      {deployment.target === 'production' ? 'Production' : 'Preview'}
    </span>
  );
}

const UNITS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.35, 'week'],
  [12, 'month'],
];

/** `3m ago`, `2h ago`, … refreshed on a timer. */
export function TimeAgo({ value }: { value: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!value) return <span className="faint">—</span>;

  let delta = (Date.now() - value) / 1000;
  if (delta < 45) return <span title={new Date(value).toLocaleString()}>just now</span>;

  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [size, nextUnit] of UNITS) {
    if (Math.abs(delta) < size) break;
    delta /= size;
    unit = nextUnit;
  }
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return (
    <span title={new Date(value).toLocaleString()}>
      {formatter.format(-Math.round(delta), unit)}
    </span>
  );
}

export function Duration({ ms }: { ms: number | null }) {
  if (!ms) return <span className="faint">—</span>;
  if (ms < 1000) return <span>{ms}ms</span>;
  const seconds = ms / 1000;
  if (seconds < 60) return <span>{seconds.toFixed(1)}s</span>;
  return (
    <span>
      {Math.floor(seconds / 60)}m {Math.round(seconds % 60)}s
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row">
      <span className="spinner" />
      {label ? <span className="muted small">{label}</span> : null}
    </span>
  );
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success';
  children: React.ReactNode;
}) {
  if (!children) return null;
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <input className="input" readOnly value={value} />
      <button
        className="btn sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable */
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {description ? <p className="small">{description}</p> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

/** Compact git metadata line shown on deployment rows. */
export function CommitLine({ deployment }: { deployment: Deployment }) {
  const message = deployment.commit?.message ?? '(no commit message)';
  return (
    <div className="stack">
      <div className="ellipsis">{message}</div>
      <div className="small faint ellipsis">
        {deployment.branch ? <>⎇ {deployment.branch}</> : 'no branch'}
        {deployment.commit ? ` · ${deployment.commit.shortSha}` : ''}
        {deployment.prNumber ? ` · PR #${deployment.prNumber}` : ''}
        {deployment.source ? ` · ${deployment.source}` : ''}
      </div>
    </div>
  );
}
