import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type AppNotification } from '../api.ts';
import { TimeAgo } from './ui.tsx';

const POLL_MS = 25_000;

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2.2c-2 0-3.3 1.5-3.3 3.6v2c0 .5-.2 1-.6 1.4L3 10.3c-.4.4-.1 1.1.5 1.1h9c.6 0 .9-.7.5-1.1l-1.1-1.1c-.4-.4-.6-.9-.6-1.4v-2c0-2.1-1.3-3.6-3.3-3.6Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.5 13.2a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Where clicking a notification (that isn't a pending transfer request)
 * should take you — `projectId` doubles as a valid `:key` for project
 * routes, same as a slug, so no extra lookup is needed. */
function targetPath(n: AppNotification): string | null {
  if (n.projectId && n.deploymentId) return `/projects/${n.projectId}/deployments/${n.deploymentId}`;
  if (n.projectId) return `/projects/${n.projectId}`;
  return null;
}

export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const { notifications: rows, unreadCount: count } = await api.notifications();
      setNotifications(rows);
      setUnreadCount(count);
    } catch {
      /* transient — keep whatever was last loaded rather than blanking it */
    } finally {
      setLoaded(true);
    }
  }

  // Keeps the badge current even while the panel is closed.
  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const onMouseDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function markReadLocally(id: string) {
    setNotifications((rows) => rows.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
  }

  async function markRead(id: string) {
    markReadLocally(id);
    try {
      await api.markNotificationRead(id);
    } catch {
      /* best effort — the badge will settle on the next poll either way */
    }
  }

  async function markAllRead() {
    setNotifications((rows) => rows.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await api.markAllNotificationsRead();
    } catch {
      /* best effort */
    }
  }

  function openNotification(n: AppNotification) {
    if (!n.read) void markRead(n.id);
    const path = targetPath(n);
    if (path) {
      setOpen(false);
      navigate(path);
    }
  }

  async function respondToTransfer(n: AppNotification, accept: boolean) {
    if (!n.transferId) return;
    setBusyId(n.id);
    try {
      if (accept) {
        await api.acceptTransfer(n.transferId);
      } else {
        await api.declineTransfer(n.transferId);
      }
      // Resolve it locally too, not just "read" — the Accept/Decline
      // buttons are gated on transferStatus, and marking only `read` here
      // (without this) is exactly what left a stale, unclickable pair
      // behind before.
      setNotifications((rows) =>
        rows.map((row) =>
          row.id === n.id ? { ...row, read: true, transferStatus: accept ? 'accepted' : 'declined' } : row
        )
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // Most likely it was already resolved (e.g. cancelled in the
      // meantime) — a reload clears the stale Accept/Decline pair.
      void load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="notif-bell" ref={boxRef}>
      <button
        type="button"
        className="notif-bell-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
      >
        <BellIcon />
        {unreadCount > 0 ? <span className="notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span> : null}
      </button>

      {open ? (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-panel-head">
            <h3>Notifications</h3>
            <div className="spacer" />
            {unreadCount > 0 ? (
              <button type="button" className="small link" onClick={markAllRead}>
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="notif-list">
            {!loaded ? (
              <div className="notif-empty">Loading…</div>
            ) : notifications.length === 0 ? (
              <div className="notif-empty">No notifications yet.</div>
            ) : (
              notifications.map((n) => {
                const actionable = n.type === 'transfer_requested' && n.transferStatus === 'pending';
                return (
                  <div key={n.id} className={`notif-item${n.read ? '' : ' unread'}`}>
                    {n.read ? <span style={{ width: 7, flex: 'none' }} /> : <span className="notif-dot" aria-hidden />}
                    <div
                      className="notif-item-body"
                      onClick={() => !actionable && openNotification(n)}
                      style={{ cursor: actionable ? 'default' : 'pointer' }}
                    >
                      <div className="notif-item-title">{n.title}</div>
                      {n.body ? <div className="notif-item-detail">{n.body}</div> : null}
                      <div className="small faint" style={{ marginTop: 4 }}>
                        <TimeAgo value={n.createdAt} />
                      </div>
                      {actionable ? (
                        <div className="notif-item-actions">
                          <button
                            type="button"
                            className="btn sm primary"
                            disabled={busyId === n.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              void respondToTransfer(n, true);
                            }}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            disabled={busyId === n.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              void respondToTransfer(n, false);
                            }}
                          >
                            Decline
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
