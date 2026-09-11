import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** URL-safe lowercase id with a Vercel-style prefix (e.g. `dpl_a1b2c3`). */
export function id(prefix: string, size = 20): string {
  const bytes = randomBytes(size);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export const newDeploymentId = () => id('dpl');
export const newProjectId = () => id('prj');
export const newUserId = () => id('usr');
export const newSessionId = () => id('sess', 28);
export const newEnvId = () => id('env');
export const newAliasId = () => id('alias');
export const newIntegrationId = () => id('git');
export const uuid = randomUUID;

/** `My Cool App` -> `my-cool-app`; safe to use as a hostname label. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'project';
}

/** Short random suffix used inside deployment hostnames. */
export function shortHash(size = 9): string {
  return id('', size);
}
