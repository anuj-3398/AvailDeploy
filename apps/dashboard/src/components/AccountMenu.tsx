import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../api.ts';
import { getStoredTheme, setTheme, type ThemeChoice } from '../theme.ts';

const THEME_ICON: Record<ThemeChoice, string> = {
  system: 'M2 3h12v8H2V3ZM6 14h4M8 11v3',
  light:
    'M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8 1.3v1.7M8 13v1.7M2.6 2.6l1.2 1.2M12.2 12.2l1.2 1.2M1.3 8h1.7M13 8h1.7M2.6 13.4l1.2-1.2M12.2 3.8l1.2-1.2',
  dark: 'M13.2 9.3A5.5 5.5 0 1 1 6.8 2.9a4.4 4.4 0 0 0 6.4 6.4Z',
};

const HOME_ICON = 'M2.3 8 8 3l5.7 5M4.5 6.4V13h7V6.4';

const DOCS_ICON =
  'M2 3.6c1.8-.9 3.6-.9 6 0v9c-2.4-.9-4.2-.9-6 0v-9ZM14 3.6c-1.8-.9-3.6-.9-6 0v9c2.4-.9 4.2-.9 6 0v-9Z';

const SIGNOUT_ICON = 'M6 3H3.5A1.5 1.5 0 0 0 2 4.5v7A1.5 1.5 0 0 0 3.5 13H6M10.5 11 14 8l-3.5-3M6 8h8';

const HOME_PAGE_URL = 'https://www.availproject.org/';

function Icon({ path }: { path: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
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

const THEME_OPTIONS: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'Match system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/**
 * The account button in the top-right corner: just an avatar until clicked,
 * then a dropdown with theme, the marketing home page, docs and sign-out —
 * in place of the email + "Sign out" button that used to sit in the open.
 */
export function AccountMenu({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setThemeChoice] = useState<ThemeChoice>(getStoredTheme);
  const boxRef = useRef<HTMLDivElement>(null);

  const initials = (user.name ?? user.email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  useEffect(() => {
    if (!open) return;
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

  function choose(next: ThemeChoice) {
    setTheme(next);
    setThemeChoice(next);
  }

  return (
    <div className="account-menu" ref={boxRef}>
      <button
        className="avatar avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.name ?? user.email}
        onClick={() => setOpen((v) => !v)}
      >
        {initials}
      </button>

      {open ? (
        <div className="account-dropdown" role="menu">
          <div className="account-header">
            <strong className="ellipsis">{user.name ?? user.email}</strong>
            {user.name ? (
              <span className="small faint ellipsis">{user.email}</span>
            ) : null}
            <span
              className="small faint"
              title={
                user.role === 'owner'
                  ? 'Owner — can delete any project and remove any domain'
                  : "Member — can delete projects and domains you created yourself, not anyone else's"
              }
            >
              {user.role === 'owner' ? '★ Owner' : 'Member'} of this workspace
            </span>
          </div>

          <div className="account-row static">
            <span>Theme</span>
            <div className="view-toggle" role="group" aria-label="Theme">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={theme === option.id ? 'active' : ''}
                  title={option.label}
                  aria-pressed={theme === option.id}
                  onClick={() => choose(option.id)}
                >
                  <Icon path={THEME_ICON[option.id]} />
                </button>
              ))}
            </div>
          </div>

          <a
            className="account-row"
            href={HOME_PAGE_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            <Icon path={HOME_ICON} />
            Home Page
          </a>

          <Link
            className="account-row"
            to="/docs"
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            <Icon path={DOCS_ICON} />
            Docs
          </Link>

          <button
            className="account-row danger"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon path={SIGNOUT_ICON} />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
