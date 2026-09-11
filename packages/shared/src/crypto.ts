import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.ts';

const KEY_CACHE = new Map<string, Buffer>();

function keyFor(purpose: string): Buffer {
  let key = KEY_CACHE.get(purpose);
  if (!key) {
    key = scryptSync(config.secret, `avail:${purpose}`, 32);
    KEY_CACHE.set(purpose, key);
  }
  return key;
}

/**
 * Encrypts a secret with AES-256-GCM. Returns
 * `v1.<iv>.<tag>.<ciphertext>` (all base64url).
 */
export function encrypt(plaintext: string, purpose = 'secret'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

/** Reverses {@link encrypt}. Throws if the payload was tampered with. */
export function decrypt(payload: string, purpose = 'secret'): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(purpose),
    Buffer.from(ivB64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Best-effort decrypt: returns null instead of throwing. */
export function tryDecrypt(payload: string, purpose = 'secret'): string | null {
  try {
    return decrypt(payload, purpose);
  } catch {
    return null;
  }
}

export function hmac(data: string, purpose = 'sign'): string {
  return createHmac('sha256', keyFor(purpose)).update(data).digest('hex');
}

/** Constant-time string comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Signs a session id so a stolen cookie cannot be forged offline. */
export function signToken(value: string): string {
  return `${value}.${hmac(value, 'session')}`;
}

/** Verifies and unwraps a token produced by {@link signToken}. */
export function verifyToken(token: string): string | null {
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;
  const value = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  return safeEqual(hmac(value, 'session'), sig) ? value : null;
}

/** Verifies a GitHub `X-Hub-Signature-256` header against the raw body. */
export function verifyGithubSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string
): boolean {
  if (!header) return false;
  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, header);
}

/** 6-digit numeric one-time login code. */
export function generateLoginCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function hashCode(code: string): string {
  return hmac(code, 'login-code');
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
