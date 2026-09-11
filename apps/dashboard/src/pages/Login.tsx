import React, { useEffect, useState } from 'react';
import { api, ApiError, type User } from '../api.ts';
import { Alert } from '../components/ui.tsx';

type Step = 'email' | 'code';

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

export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<{
    allowedDomains: string[];
    githubSignIn: boolean;
    googleSignIn: boolean;
    mailDelivery: string;
  } | null>(null);

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

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.requestCode(email.trim());
      setStep('code');
      setNotice(
        result.code
          ? `Email delivery is not configured, so here is your code: ${result.code}`
          : `We sent a 6-digit code to ${email.trim()}.`
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not request a code'
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = await api.verifyCode(email.trim(), code.trim());
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>
          <span style={{ marginRight: 8 }}>▲</span>Avail Deploy
        </h1>
        <p className="sub">
          Sign in with your {domains.map((d) => `@${d}`).join(' or ')} address
        </p>

        <Alert kind="error">{error}</Alert>

        {step === 'email' ? (
          <form onSubmit={requestCode}>
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                className="input"
                type="email"
                autoFocus
                required
                autoComplete="email"
                placeholder={`you@${domains[0]}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              disabled={busy || !email}
            >
              {busy ? 'Sending…' : 'Continue with Email'}
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
              }}
            >
              Use a different email
            </button>
          </form>
        )}

        {config?.googleSignIn || config?.githubSignIn ? (
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
