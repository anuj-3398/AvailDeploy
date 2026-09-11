/**
 * A self-signed certificate for `*.avail.localhost`, generated on first
 * boot and reused after that. This is deliberately not the real thing:
 * real Vercel provisions a publicly-trusted cert per domain via ACME
 * (Let's Encrypt), which needs a public domain and DNS we don't have on a
 * local dev box. What's provable here instead is that the proxy can
 * actually terminate TLS at all — the browser will show a "not trusted"
 * warning for this cert (it's self-signed, that's expected), but the
 * connection underneath it is genuinely encrypted.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';

const log = createLogger('tls');

export interface TlsCert {
  key: Buffer;
  cert: Buffer;
}

/**
 * Returns the proxy's TLS cert/key, generating a fresh self-signed one
 * with `openssl` if none exists yet. Returns `null` (never throws) if
 * `openssl` isn't on `PATH` — the proxy still runs, just HTTP-only, same as
 * before this existed.
 */
export function ensureSelfSignedCert(): TlsCert | null {
  const dir = config.certsDir;
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }

  mkdirSync(dir, { recursive: true });
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '3650',
        '-subj',
        `/CN=${config.deploymentDomain}`,
        '-addext',
        `subjectAltName=DNS:*.${config.deploymentDomain},DNS:${config.deploymentDomain},DNS:localhost,DNS:*.localhost`,
      ],
      { stdio: 'pipe' }
    );
  } catch (err) {
    log.warn(
      `Could not generate a self-signed certificate (is openssl installed?) — the proxy will stay HTTP-only: ${
        (err as Error).message
      }`
    );
    return null;
  }

  log.info(`Generated a self-signed certificate for *.${config.deploymentDomain} at ${dir}`);
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}
