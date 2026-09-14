import React, { useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Alert, PasswordField } from '../components/ui.tsx';
import { useAuth } from '../auth.ts';
import { PASSWORD_HINT, passwordError } from '../validation.ts';

export function AccountSettings() {
  const { user, refresh, signOut } = useAuth();
  const [formOpen, setFormOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  function closeForm() {
    setFormOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    const passwordIssue = passwordError(newPassword);
    if (passwordIssue) {
      setError(passwordIssue);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.setPassword(newPassword, user.hasPassword ? currentPassword : undefined);
      setNotice(user.hasPassword ? 'Password updated.' : 'Password created — you can now sign in with it.');
      closeForm();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the password');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    setDeleteError('');
    try {
      await api.deleteAccount();
    } catch (err) {
      setDeleting(false);
      setConfirmingDelete(false);
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete your account');
      return;
    }
    await signOut();
  }

  return (
    <>
      <div className="page-head">
        <div className="stack">
          <h1>Account Settings</h1>
          <span className="sub">{user.email}</span>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <div className="card">
        <div className="card-head">
          <h2>Password</h2>
        </div>
        {formOpen ? (
          <form onSubmit={save}>
            <div className="card-body">
              <p className="muted small">
                {user.hasPassword
                  ? 'Update the password used to sign in with your email address, in place of a one-time code.'
                  : 'Create a password so you can sign in with your email address instead of waiting on a one-time code each time.'}
              </p>
              {user.hasPassword ? (
                <div className="field">
                  <label htmlFor="current-password">Current password</label>
                  <PasswordField
                    id="current-password"
                    autoComplete="current-password"
                    autoFocus
                    required
                    value={currentPassword}
                    onChange={setCurrentPassword}
                  />
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="new-password">{user.hasPassword ? 'New password' : 'Password'}</label>
                <PasswordField
                  id="new-password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  autoFocus={!user.hasPassword}
                  required
                  value={newPassword}
                  onChange={setNewPassword}
                />
                <span className="hint">{PASSWORD_HINT}</span>
              </div>
              <div className="field">
                <label htmlFor="confirm-password">Confirm password</label>
                <PasswordField
                  id="confirm-password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                />
              </div>
            </div>
            <div className="card-foot">
              <button className="btn primary" disabled={busy || !newPassword || !confirmPassword}>
                {busy ? 'Saving…' : user.hasPassword ? 'Update Password' : 'Create Password'}
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="card-body">
              <p className="muted small">
                {user.hasPassword
                  ? 'You can sign in with your email address and this password, in place of a one-time code.'
                  : 'Create a password so you can sign in with your email address instead of waiting on a one-time code each time.'}
              </p>
            </div>
            <div className="card-foot">
              <button className="btn primary" onClick={() => setFormOpen(true)}>
                {user.hasPassword ? 'Update Password' : 'Create Password'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2 style={{ color: 'var(--danger)' }}>Delete account</h2>
        </div>
        <div className="card-body">
          <Alert kind="error">{deleteError}</Alert>
          <p className="muted small">
            Permanently deletes your account, signs you out everywhere, and
            disconnects any GitHub account you connected. This cannot be
            undone. You must delete every project you created first — a
            project with no other owner can't be left behind.
          </p>
        </div>
        <div className="card-foot">
          {confirmingDelete ? (
            <>
              <button className="btn danger" disabled={deleting} onClick={deleteAccount}>
                {deleting ? 'Deleting…' : 'Confirm Delete'}
              </button>
              <button className="btn ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn danger" onClick={() => setConfirmingDelete(true)}>
              Delete account
            </button>
          )}
        </div>
      </div>
    </>
  );
}
