import React, { useEffect, useState } from 'react';
import { api, ApiError, type User } from '../api.ts';
import { Alert } from '../components/ui.tsx';

type Step = 'email' | 'code';

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

        {config?.githubSignIn ? (
          <>
            <div className="divider">or</div>
            <a
              className="btn"
              style={{ width: '100%' }}
              href="/api/auth/github/start?intent=signin"
            >
              Continue with GitHub
            </a>
          </>
        ) : null}

        <p className="small faint" style={{ marginTop: 20, textAlign: 'center' }}>
          Access is limited to the {domains.join(', ')} domain.
        </p>
      </div>
    </div>
  );
}
