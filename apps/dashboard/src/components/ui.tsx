import React, { useEffect, useState } from 'react';
import type { Deployment, DeploymentState } from '../api.ts';

/**
 * The Avail mark, served from `apps/dashboard/public/avail-logo.png`.
 * Replacing that one file changes the logo in the top bar, the login card and
 * the browser tab — nothing here needs to change.
 */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <img
      className="logo"
      src="/avail-logo.png"
      width={size}
      height={size}
      alt=""
      aria-hidden
    />
  );
}

const STATE_CLASS: Record<DeploymentState, string> = {
  QUEUED: 'queued',
  INITIALIZING: 'building',
  BUILDING: 'building',
  UPLOADING: 'building',
  READY: 'ready',
  ERROR: 'error',
  CANCELED: 'queued',
  SKIPPED: 'queued',
};

const STATE_LABEL: Record<DeploymentState, string> = {
  QUEUED: 'Queued',
  INITIALIZING: 'Initializing',
  BUILDING: 'Building',
  UPLOADING: 'Finalizing',
  READY: 'Ready',
  ERROR: 'Error',
  CANCELED: 'Canceled',
  SKIPPED: 'Skipped',
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

/** Icon paths shared by the project sidebar and the home sidebar. */
export const navIcons = {
  overview: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z',
  deployments: 'M8 1.8 14 5v6l-6 3.2L2 11V5z',
  logs: 'M3 3.5h10M3 8h10M3 12.5h6',
  env: 'M4.5 5.5 2 8l2.5 2.5M11.5 5.5 14 8l-2.5 2.5M9.5 3.5l-3 9',
  domains: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Zm0 0c1.8 1.6 2.7 3.7 2.7 6.2S9.8 12.6 8 14.2m0-12.4C6.2 3.4 5.3 5.5 5.3 8s.9 4.6 2.7 6.2M2.2 6.4h11.6M2.2 9.6h11.6',
  settings:
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.4-2a5.4 5.4 0 0 0-.1-.9l1.3-1-1.3-2.2-1.5.5a5.3 5.3 0 0 0-1.5-.9L10 1.8H7.4L7.1 3.4c-.5.2-1 .5-1.5.9l-1.5-.5-1.3 2.2 1.3 1a5.4 5.4 0 0 0 0 1.8l-1.3 1 1.3 2.2 1.5-.5c.5.4 1 .7 1.5.9l.3 1.6H10l.3-1.6c.5-.2 1-.5 1.5-.9l1.5.5 1.3-2.2-1.3-1c0-.3.1-.6.1-.9Z',
};

/** One glyph in a sidebar nav item — an outlined icon on a 16x16 grid. */
export function NavIcon({ path }: { path: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
