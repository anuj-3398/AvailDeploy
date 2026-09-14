import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type WorkspaceRequestLog } from '../api.ts';
import { EmptyState, Spinner } from '../components/ui.tsx';

const POLL_MS = 2000;
const MAX_ROWS = 500;

function statusClass(status: number): string {
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'redirect';
  return 'ok';
}

/** `SEP 11 14:13:19.27` — matching the compact format of a request log. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const month = d.toLocaleString('en', { month: 'short' }).toUpperCase();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const centis = pad(Math.floor(d.getMilliseconds() / 10));
  return `${month} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${centis}`;
}

const KIND_GLYPH: Record<string, string> = {
  function: 'ƒ',
  server: '⧉',
  static: '▤',
  redirect: '↪',
  error: '!',
};

/** The `/logs` tab of the home shell: proxy request logs across every project. */
export function AllLogs() {
  const [logs, setLogs] = useState<WorkspaceRequestLog[] | null>(null);
  const [live, setLive] = useState(true);
  const [search, setSearch] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [total, setTotal] = useState(0);
  const highestId = useRef(0);

  /** Full reload — used on mount and whenever a filter changes. */
  const reload = useCallback(async () => {
    const { logs: rows, total: count } = await api.allLogs({
      limit: 200,
      q: search.trim() || undefined,
      status: errorsOnly ? 'error' : undefined,
    });
    setLogs(rows);
    setTotal(count);
    highestId.current = rows.length ? Math.max(...rows.map((r) => r.id)) : 0;
  }, [search, errorsOnly]);

  useEffect(() => {
    setLogs(null);
    void reload();
  }, [reload]);

  /**
   * The proxy writes logs from a separate process, so tailing is a poll for
   * anything newer than the highest id already shown rather than a subscription.
   */
  useEffect(() => {
    if (!live) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const { logs: fresh, total: count } = await api.allLogs({
          sinceId: highestId.current,
          q: search.trim() || undefined,
          status: errorsOnly ? 'error' : undefined,
          limit: 200,
        });
        if (cancelled) return;
        setTotal(count);
        if (fresh.length) {
          highestId.current = Math.max(highestId.current, ...fresh.map((r) => r.id));
          setLogs((current) => [...fresh, ...(current ?? [])].slice(0, MAX_ROWS));
        }
      } catch {
        /* transient: the next tick retries */
      }
    };

    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, search, errorsOnly]);

  return (
    <>
      <div className="page-title">
        <h1>Logs</h1>
        <div className="spacer" />
        <span className="small faint">{total} requests stored</span>
      </div>

      <div className="log-toolbar">
        <div className="log-search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            placeholder="Search project, path, host or message…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <label className="switch small">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          Errors only
        </label>

        <button
          className={`btn sm${live ? ' accent' : ''}`}
          onClick={() => setLive((v) => !v)}
          title={live ? 'Streaming new requests' : 'Paused'}
        >
          <span className={`live-dot${live ? ' on' : ''}`} aria-hidden />
          {live ? 'Live' : 'Paused'}
        </button>

        <button className="btn sm" onClick={() => void reload()} title="Refresh">
          ⟳
        </button>
      </div>

      <section className="panel">
        {logs === null ? (
          <div className="panel-body">
            <Spinner label="Loading logs…" />
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            title="No requests yet"
            description={
              search || errorsOnly
                ? 'Nothing matches the current filter.'
                : 'Visit one of your deployments and requests will appear here.'
            }
          />
        ) : (
          <div className="log-table wide">
            {/* Header cells carry the same classes as the row cells so the
                responsive rules hide a column and its label together. */}
            <div className="log-head">
              <span className="log-project">Project</span>
              <span className="log-time">Time</span>
              <span className="log-status">Status</span>
              <span className="log-host">Host</span>
              <span className="log-request">Request</span>
              <span className="log-message">Messages</span>
            </div>
            {logs.map((row) => (
              <Link
                key={row.id}
                className="log-row"
                to={`/projects/${row.projectSlug}/logs`}
              >
                <span className="log-project ellipsis" title={row.projectName}>
                  {row.projectName}
                </span>
                <span className="log-time mono">{formatTime(row.ts)}</span>
                <span className="log-status mono">
                  <span className="log-method">{row.method}</span>
                  <span className={`code ${statusClass(row.status)}`}>{row.status}</span>
                </span>
                <span className="log-host mono ellipsis" title={row.host}>
                  {row.host}
                </span>
                <span className="log-request mono ellipsis" title={row.path}>
                  <span className="kind-glyph" title={row.kind}>
                    {KIND_GLYPH[row.kind] ?? '·'}
                  </span>
                  {row.path}
                </span>
                <span className="log-message faint ellipsis" title={row.message ?? ''}>
                  {row.message ?? ''}
                  <span className="log-duration">{row.durationMs}ms</span>
                </span>
              </Link>
            ))}
            <div className="log-end faint small">
              {live ? 'Streaming…' : 'Paused'} · showing {logs.length} most recent
            </div>
          </div>
        )}
      </section>
    </>
  );
}
