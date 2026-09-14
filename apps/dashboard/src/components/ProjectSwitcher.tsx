import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '../api.ts';
import { NavIcon, navIcons } from './ui.tsx';

/**
 * Project picker in the top bar: a searchable list, the current project
 * ticked, and a shortcut to import a new one.
 */
export function ProjectSwitcher({
  projects,
  current,
}: {
  projects: Project[];
  current: Project | null;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.slug.includes(needle) ||
        (p.repo?.fullName ?? '').toLowerCase().includes(needle)
    );
  }, [projects, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    // Focus after the menu paints so typing goes straight into the filter.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function choose(project: Project) {
    setOpen(false);
    navigate(`/projects/${project.slug}`);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    }
    if (event.key === 'Enter' && matches[highlight]) {
      event.preventDefault();
      choose(matches[highlight]);
    }
  }

  return (
    <div className="switcher" ref={boxRef}>
      <button
        className="switcher-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? (
          <span className="switcher-mark small" aria-hidden>
            {current.name[0]?.toUpperCase()}
          </span>
        ) : null}
        <span className="switcher-name">{current?.name ?? 'All Projects'}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden fill="none">
          <path
            d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div className="switcher-menu" role="listbox">
          <div className="switcher-search">
            <input
              ref={inputRef}
              value={query}
              placeholder="Find Project…"
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
            />
            <kbd>Esc</kbd>
          </div>

          <div className="switcher-list">
            {matches.length === 0 ? (
              <div className="switcher-empty">No projects match “{query}”</div>
            ) : (
              matches.map((project, index) => (
                <button
                  key={project.id}
                  role="option"
                  aria-selected={project.id === current?.id}
                  className={`switcher-item${index === highlight ? ' highlight' : ''}`}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(project)}
                >
                  <span className="switcher-mark small" aria-hidden>
                    {project.name[0]?.toUpperCase()}
                  </span>
                  <span className="switcher-item-name">{project.name}</span>
                  {project.id === current?.id ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none">
                      <path
                        d="m3.5 8.5 3 3 6-7"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </button>
              ))
            )}
          </div>

          <button
            className="switcher-create"
            onClick={() => {
              setOpen(false);
              navigate('/');
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            All Projects
          </button>
          <button
            className="switcher-create"
            onClick={() => {
              setOpen(false);
              navigate('/myprojects');
            }}
          >
            <NavIcon path={navIcons.mine} />
            My Projects
          </button>
          <button
            className="switcher-create"
            onClick={() => {
              setOpen(false);
              navigate('/new');
            }}
          >
            <span aria-hidden>+</span> Create Project
          </button>
        </div>
      ) : null}
    </div>
  );
}
