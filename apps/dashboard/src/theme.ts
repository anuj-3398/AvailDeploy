/**
 * Theme preference: 'system' follows the OS (no override — see the
 * `prefers-color-scheme` block in styles.css), 'light'/'dark' force one via
 * `data-theme` on <html>. index.html applies the stored choice inline,
 * before first paint, so there is no flash of the wrong theme; this module
 * is what the account menu reads from and writes through at runtime.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'avail:theme';

export function getStoredTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function setTheme(theme: ThemeChoice): void {
  applyTheme(theme);
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable — the choice just won't survive a reload */
  }
}
