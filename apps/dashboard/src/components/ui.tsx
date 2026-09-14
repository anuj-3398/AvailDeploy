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
  home: 'M2.3 8 8 3l5.7 5M4.5 6.4V13h7V6.4',
  mine: 'M5.5 7a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0ZM3 13.2c.9-2.4 2.9-3.7 5-3.7s4.1 1.3 5 3.7',
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

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8S4 3 8 3s6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 2l12 12M6.5 6.6a2 2 0 0 0 2.9 2.9M4.2 4.3C2.6 5.3 1.5 8 1.5 8s2.5 5 6.5 5c1.2 0 2.2-.4 3.1-1M9.9 3.3C9.3 3.1 8.7 3 8 3c-.4 0-.8 0-1.2.1M11.8 4.9c1.4 1 2.7 3.1 2.7 3.1s-.5 1-1.4 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A password `<input>` with a show/hide eye toggle inside the field, same
 * idea as `CopyField`'s copy button. Uses the same `.input` styling as every
 * other text field — only the wrapper and the toggle button are new.
 */
export function PasswordField({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  required,
  autoFocus,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  autoFocus?: boolean;
  /** Extra class(es) appended to the input's own `input`, e.g. `mono`. */
  className?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input
        id={id}
        className={className ? `input ${className}` : 'input'}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="password-toggle"
        tabIndex={-1}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        <EyeIcon open={visible} />
      </button>
    </div>
  );
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
