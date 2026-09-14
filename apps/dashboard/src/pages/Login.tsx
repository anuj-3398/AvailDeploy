import React, { useEffect, useState } from 'react';
import { api, ApiError, type User } from '../api.ts';
import { Alert, Logo, PasswordField } from '../components/ui.tsx';
import { PASSWORD_HINT, passwordError } from '../validation.ts';

type Step =
  | 'email'
  | 'code'
  | 'password'
  | 'reset-email'
  | 'reset-code'
  | 'reset-password';

/** Google's brand mark, inlined so the page makes no third-party requests. */
function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84a10.13 10.13 0 0 1-4.4 6.65v5.52h7.11c4.16-3.83 6.57-9.47 6.57-16.18Z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7A21.99 21.99 0 0 0 24 46Z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18a13.2 13.2 0 0 1 0-8.36v-5.7H4.34a22 22 0 0 0 0 19.76l7.35-5.7Z"
      />
      <path
        fill="#EA4335"
        d="M24 9.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 3.18 29.93 1 24 1 15.4 1 7.96 5.93 4.34 13.12l7.35 5.7C13.42 13.62 18.27 9.75 24 9.75Z"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}

/**
 * Mirrors the server's `isEmailAllowed` so the domain is checked as the user
 * types instead of only when the form is submitted. The server still enforces
 * it — this is feedback, not a gate.
 */
function domainAllowed(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return domains.includes(email.slice(at + 1).toLowerCase().trim());
}

export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<{
    allowedDomains: string[];
    githubSignIn: boolean;
    googleSignIn: boolean;
    mailDelivery: string;
  } | null>(null);

  // Forgot-password is its own little wizard, deliberately separate from
  // the ordinary code step: it always asks for the email again (rather than
  // silently reusing whatever's already in `email`), then a code-only
  // screen, then a dedicated new-password screen, then drops back to the
  // sign-in screen instead of signing in directly — see each handler below.
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');

  useEffect(() => {
    api
      .authConfig()
      .then(setConfig)
      .catch(() => setConfig(null));

    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    if (oauthError) setError(oauthError);
  }, []);

  const domains = config?.allowedDomains ?? ['availproject.org'];
  const typed = email.trim();
  // Only complain once they have typed something that looks like an address.
  const domainReady = typed.includes('@') && typed.split('@')[1]?.length > 0;
  const domainOk = domainAllowed(typed, domains);
  const showDomainError = domainReady && !domainOk;

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.requestCode(typed, mode);
      if (result.method === 'password') {
        // This account has a password set — no code was sent at all.
        setStep('password');
      } else {
        setStep('code');
        setNotice(
          result.code
            ? `Email delivery is not configured, so here is your code: ${result.code}`
            : `We sent a 6-digit code to ${typed}.`
        );
      }
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      setError(apiError ? apiError.message : 'Could not request a code');
      // The account either exists or it does not — offer the other tab.
      if (apiError?.code === 'account_not_found') setMode('signup');
      if (apiError?.code === 'account_exists') setMode('login');
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (mode === 'signup' && newPassword) {
      const passwordIssue = passwordError(newPassword);
      if (passwordIssue) {
        setError(passwordIssue);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }
    }
    setBusy(true);
    try {
      const { user } = await api.verifyCode(
        email.trim(),
        code.trim(),
        mode === 'signup' && newPassword ? newPassword : undefined
      );
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPassword(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = await api.loginWithPassword(email.trim(), password);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------------------------- forgot password --- */

  function startForgotPassword() {
    setError('');
    setNotice('');
    setPassword('');
    // Every field in this wizard starts blank, including the email — it's
    // asked again for real, not quietly carried over from the password
    // step, so a shared computer doesn't leave the previous field re-filled.
    setResetEmail('');
    setResetCode('');
    setResetToken('');
    setResetNewPassword('');
    setResetConfirmPassword('');
    setStep('reset-email');
  }

  async function sendResetCode(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.requestCode(resetEmail.trim(), 'login', true);
      setStep('reset-code');
      setNotice(
        result.code
          ? `Email delivery is not configured, so here is your code: ${result.code}`
          : `We sent a 6-digit code to ${resetEmail.trim()}.`
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code');
    } finally {
      setBusy(false);
    }
  }

  async function verifyResetCode(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token } = await api.verifyPasswordResetCode(resetEmail.trim(), resetCode.trim());
      setResetToken(token);
      setNotice('');
      setResetNewPassword('');
      setResetConfirmPassword('');
      setStep('reset-password');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code is not correct');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPasswordReset(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const passwordIssue = passwordError(resetNewPassword);
    if (passwordIssue) {
      setError(passwordIssue);
      return;
    }
    if (resetNewPassword !== resetConfirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.confirmPasswordReset(resetEmail.trim(), resetToken, resetNewPassword);
      const resetFor = resetEmail.trim();
      setStep('email');
      setMode('login');
      setEmail(resetFor);
      setResetEmail('');
      setResetCode('');
      setResetToken('');
      setResetNewPassword('');
      setResetConfirmPassword('');
      setNotice('Password updated — sign in with your new password.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset your password');
    } finally {
      setBusy(false);
    }
  }

  const isResetStep = step === 'reset-email' || step === 'reset-code' || step === 'reset-password';

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>
          <Logo size={24} />
          Avail Deploy
        </h1>
        <p className="sub">
          {isResetStep
            ? 'Reset your password'
            : mode === 'login'
              ? 'Log in with'
              : 'Create an account with'}
          {isResetStep ? null : (
            <>
              {' '}
              your {domains.map((d) => `@${d}`).join(' or ')} address
            </>
          )}
        </p>

        {step === 'email' ? (
          <div className="segmented" role="tablist">
            <button
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : ''}
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              Log in
            </button>
            <button
              role="tab"
              aria-selected={mode === 'signup'}
              className={mode === 'signup' ? 'active' : ''}
              onClick={() => {
                setMode('signup');
                setError('');
              }}
            >
              Sign up
            </button>
          </div>
        ) : null}

        <Alert kind="error">{error}</Alert>

        {step === 'email' ? (
          <form onSubmit={requestCode}>
            <Alert kind="success">{notice}</Alert>
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                className={`input${showDomainError ? ' invalid' : ''}`}
                type="email"
                autoFocus
                required
                autoComplete="email"
                aria-invalid={showDomainError}
                aria-describedby="domain-hint"
                placeholder={`you@${domains[0]}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <span
                id="domain-hint"
                className={showDomainError ? 'hint invalid' : 'hint'}
              >
                {showDomainError
                  ? `Only ${domains.map((d) => `@${d}`).join(' or ')} addresses are allowed`
                  : mode === 'signup'
                    ? 'Anyone on the domain can create an account.'
                    : ' '}
              </span>
            </div>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              disabled={busy || !typed || !domainOk}
            >
              {busy
                ? 'Sending…'
                : mode === 'signup'
                  ? 'Sign up with Email'
                  : 'Continue with Email'}
            </button>
          </form>
        ) : step === 'password' ? (
          <form onSubmit={signInWithPassword}>
            <div className="field">
              <label htmlFor="password">Password</label>
              <PasswordField
                id="password"
                autoFocus
                required
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
              />
            </div>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              disabled={busy || !password}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              style={{ width: '100%', marginTop: 10 }}
              onClick={startForgotPassword}
              disabled={busy}
            >
              Forgot password?
            </button>
            <button
              type="button"
              className="btn ghost sm"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => {
                setStep('email');
                setPassword('');
              }}
            >
              Use a different email
            </button>
          </form>
        ) : step === 'reset-email' ? (
          <form onSubmit={sendResetCode}>
            <div className="field">
              <label htmlFor="reset-email">Email address</label>
              <input
                id="reset-email"
                className="input"
                type="email"
                autoFocus
                required
                autoComplete="email"
                placeholder={`you@${domains[0]}`}
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
              />
              <span className="hint">We'll send a 6-digit code to this address.</span>
            </div>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              disabled={busy || !resetEmail.trim()}
            >
              {busy ? 'Sending…' : 'Send OTP'}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => {
                setStep('email');
                setResetEmail('');
              }}
            >
              Back to sign in
            </button>
          </form>
        ) : step === 'reset-code' ? (
          <form onSubmit={verifyResetCode}>
            <Alert kind="info">{notice}</Alert>
            <div className="field">
              <label htmlFor="reset-code">Verification code</label>
              <input
                id="reset-code"
                className="input code-input"
                inputMode="numeric"
                autoFocus
                required
                maxLength={6}
                placeholder="000000"
                value={resetCode}
                onChange={(e) =>
                  setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
              />
            </div>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              disabled={busy || resetCode.length !== 6}
            >
              {busy ? 'Verifying…' : 'Verify code'}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => {
                setStep('reset-email');
                setResetCode('');
                setNotice('');
              }}
            >
              Use a different email
            </button>
          </form>
        ) : step === 'reset-password' ? (
          <form onSubmit={confirmPasswordReset}>
            <div className="field">
              <label htmlFor="reset-new-password">New password</label>
              <PasswordField
                id="reset-new-password"
                autoFocus
                required
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={resetNewPassword}
                onChange={setResetNewPassword}
              />
              <span className="hint">{PASSWORD_HINT}</span>
            </div>
            <div className="field">
              <label htmlFor="reset-confirm-password">Confirm password</label>
              <PasswordField
                id="reset-confirm-password"
                required
                autoComplete="new-password"
                value={resetConfirmPassword}
                onChange={setResetConfirmPassword}
              />
            </div>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              disabled={busy || !resetNewPassword || !resetConfirmPassword}
            >
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <Alert kind="info">{notice}</Alert>
            <div className="field">
              <label htmlFor="code">Verification code</label>
              <input
                id="code"
                className="input code-input"
                inputMode="numeric"
                autoFocus
                required
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
              />
            </div>
            {mode === 'signup' ? (
              <>
                <div className="field">
                  <label htmlFor="new-password">
                    Password{' '}
                    <span className="small faint">
                      (optional — sign in without a code next time)
                    </span>
                  </label>
                  <PasswordField
                    id="new-password"
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={newPassword}
                    onChange={setNewPassword}
                  />
                  <span className="hint">{PASSWORD_HINT}</span>
                </div>
                {newPassword ? (
                  <div className="field">
                    <label htmlFor="confirm-password">Confirm password</label>
                    <PasswordField
                      id="confirm-password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={setConfirmPassword}
                    />
                  </div>
                ) : null}
              </>
            ) : null}
            <button
              className="btn primary"
              style={{ width: '100%' }}
              disabled={busy || code.length !== 6}
            >
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => {
                setStep('email');
                setCode('');
                setNotice('');
                setNewPassword('');
                setConfirmPassword('');
              }}
            >
              Use a different email
            </button>
          </form>
        )}

        {!isResetStep && (config?.googleSignIn || config?.githubSignIn) ? (
          <>
            <div className="divider">or</div>
            <div className="provider-buttons">
              {config?.googleSignIn ? (
                <a className="btn" href="/api/auth/google/start">
                  <GoogleMark />
                  Continue with Google
                </a>
              ) : null}
              {config?.githubSignIn ? (
                <a className="btn" href="/api/auth/github/start?intent=signin">
                  <GitHubMark />
                  Continue with GitHub
                </a>
              ) : null}
            </div>
          </>
        ) : null}

        <p className="small faint" style={{ marginTop: 20, textAlign: 'center' }}>
          Access is limited to the {domains.join(', ')} domain.
        </p>
      </div>
    </div>
  );
}
