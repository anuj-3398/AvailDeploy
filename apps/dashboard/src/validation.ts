const MIN_PASSWORD_LEN = 8;

/**
 * Standard complexity rule: at least 8 characters, one uppercase letter,
 * one lowercase letter, and one special (non-alphanumeric) character.
 * Mirrors the server's `validate_password` in rust-api/src/routes/auth.rs —
 * this is feedback only, the server still enforces it for real.
 */
export function passwordError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LEN) {
    return `Password must be at least ${MIN_PASSWORD_LEN} characters`;
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must include at least one uppercase letter';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must include at least one lowercase letter';
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return 'Password must include at least one special character';
  }
  return null;
}

export const PASSWORD_HINT =
  'At least 8 characters, with an uppercase letter, a lowercase letter, and a special character.';
