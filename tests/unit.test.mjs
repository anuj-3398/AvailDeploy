import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

process.env.AVAIL_SECRET ??= 'test-secret-for-unit-tests';
process.env.ALLOWED_EMAIL_DOMAINS ??= 'availproject.org';

const { isEmailAllowed, normalizeEmail } = await import(
  '../packages/shared/src/config.ts'
);
const crypto = await import('../packages/shared/src/crypto.ts');
const { slugify, id } = await import('../packages/shared/src/ids.ts');
const frameworks = await import('../packages/frameworks/src/index.ts');
const routing = await import('../apps/proxy/src/routing.ts');
const staticFiles = await import('../apps/proxy/src/static.ts');
const paths = await import('../apps/builder/src/paths.ts');
const { discoverFunctions } = await import('../apps/builder/src/functions.ts');
const { renderScript } = await import('../apps/builder/src/executor.ts');

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'avail-test-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ auth */

describe('email domain allow-list', () => {
  it('accepts any address on an allow-listed domain', () => {
    assert.equal(isEmailAllowed('anuj@availproject.org'), true);
    assert.equal(isEmailAllowed('someone.else+tag@availproject.org'), true);
    assert.equal(isEmailAllowed('ANUJ@AvailProject.ORG'), true);
  });

  it('rejects every other domain', () => {
    assert.equal(isEmailAllowed('anuj@gmail.com'), false);
    assert.equal(isEmailAllowed('anuj@notavailproject.org'), false);
    assert.equal(isEmailAllowed('anuj@availproject.org.evil.com'), false);
    assert.equal(isEmailAllowed('availproject.org'), false);
    assert.equal(isEmailAllowed(''), false);
  });

  it('normalizes case and whitespace', () => {
    assert.equal(normalizeEmail('  Anuj@Availproject.org '), 'anuj@availproject.org');
  });
});

/* ---------------------------------------------------------------- crypto */

describe('crypto', () => {
  it('round-trips encrypted values', () => {
    const secret = 'super-secret-value-☃';
    const sealed = crypto.encrypt(secret, 'env');
    assert.notEqual(sealed, secret);
    assert.equal(crypto.decrypt(sealed, 'env'), secret);
  });

  it('fails to decrypt with a different purpose', () => {
    const sealed = crypto.encrypt('value', 'env');
    assert.equal(crypto.tryDecrypt(sealed, 'git-token'), null);
  });

  it('detects tampering', () => {
    const sealed = crypto.encrypt('value', 'env');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.equal(crypto.tryDecrypt(parts.join('.'), 'env'), null);
  });

  it('verifies its own session tokens', () => {
    const token = crypto.signToken('sess_abc');
    assert.equal(crypto.verifyToken(token), 'sess_abc');
    assert.equal(crypto.verifyToken('sess_abc.bogus'), null);
    assert.equal(crypto.verifyToken('nosignature'), null);
  });

  it('verifies GitHub webhook signatures', () => {
    const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
    const secret = 'hook-secret';
    const signature =
      'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(crypto.verifyGithubSignature(body, signature, secret), true);
    assert.equal(crypto.verifyGithubSignature(body, signature, 'other'), false);
    assert.equal(crypto.verifyGithubSignature(body, undefined, secret), false);
  });

  it('generates six-digit login codes', () => {
    for (let i = 0; i < 50; i++) {
      assert.match(crypto.generateLoginCode(), /^\d{6}$/);
    }
  });
});

/* ------------------------------------------------------------------- ids */

describe('ids', () => {
  it('slugifies names into hostname labels', () => {
    assert.equal(slugify('My Cool App'), 'my-cool-app');
    assert.equal(slugify('feature/new-header'), 'feature-new-header');
    assert.equal(slugify('---'), 'project');
    assert.match(slugify('Ünïcode Ñame'), /^[a-z0-9-]+$/);
  });

  it('generates prefixed ids', () => {
    assert.match(id('dpl'), /^dpl_[a-z0-9]{20}$/);
    assert.notEqual(id('dpl'), id('dpl'));
  });
});

/* ------------------------------------------------------- framework detect */

describe('framework detection', () => {
  const write = (dir, file, contents) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  };

  it('detects Next.js from its dependency', () => {
    const dir = tempDir();
    write(dir, 'package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    const result = frameworks.detectFramework(dir);
    assert.equal(result?.slug, 'nextjs');
    assert.equal(result?.version, '15.0.0');
  });

  it('prefers SvelteKit over Vite when both match', () => {
    const dir = tempDir();
    write(
      dir,
      'package.json',
      JSON.stringify({
        devDependencies: { '@sveltejs/kit': '2.0.0', vite: '5.0.0' },
      })
    );
    // `sveltekit` is reserved for the 1.0.0-next prereleases; current
    // versions detect as `sveltekit-1`. Either way Vite must not win.
    const detected = frameworks.detectFramework(dir)?.slug;
    assert.equal(detected, 'sveltekit-1');
    assert.equal(frameworks.SERVER_FRAMEWORKS.has(detected), true);
  });

  it('returns null for a plain static site', () => {
    const dir = tempDir();
    write(dir, 'index.html', '<h1>hi</h1>');
    assert.equal(frameworks.detectFramework(dir), null);
  });

  it('knows which frameworks need a server process', () => {
    assert.equal(frameworks.SERVER_FRAMEWORKS.has('nextjs'), true);
    assert.equal(frameworks.SERVER_FRAMEWORKS.has('vite'), false);
  });

  it('infers the package manager from the lockfile', () => {
    const dir = tempDir();
    assert.equal(frameworks.detectPackageManager(dir), 'npm');
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.equal(frameworks.detectPackageManager(dir), 'pnpm');
  });

  it('installs dev dependencies by default', () => {
    assert.match(frameworks.defaultInstallCommand('npm'), /--include=dev/);
    assert.match(frameworks.defaultInstallCommand('pnpm'), /--prod=false/);
  });
});

/* --------------------------------------------------------------- routing */

describe('route patterns', () => {
  it('matches named parameters', () => {
    assert.deepEqual(routing.matchPattern('/blog/:slug', '/blog/hello')?.params, {
      slug: 'hello',
    });
    assert.equal(routing.matchPattern('/blog/:slug', '/blog/a/b'), null);
  });

  it('matches wildcards', () => {
    assert.deepEqual(
      routing.matchPattern('/docs/:path*', '/docs/a/b/c')?.params,
      { path: 'a/b/c' }
    );
  });

  it('applies redirects with parameters', () => {
    const redirect = routing.findRedirect(
      [{ source: '/old/:id', destination: '/new/:id', permanent: true }],
      '/old/42',
      '?x=1'
    );
    assert.equal(redirect?.location, '/new/42?x=1');
    assert.equal(redirect?.statusCode, 308);
  });

  it('uses 307 for temporary redirects', () => {
    const redirect = routing.findRedirect(
      [{ source: '/a', destination: '/b', permanent: false }],
      '/a',
      ''
    );
    assert.equal(redirect?.statusCode, 307);
  });

  it('collects headers from matching rules', () => {
    const headers = routing.extraHeaders(
      [
        { source: '/(.*)', headers: [{ key: 'x-one', value: '1' }] },
        { source: '/api/(.*)', headers: [{ key: 'x-two', value: '2' }] },
      ],
      '/api/users'
    );
    assert.deepEqual(headers, { 'x-one': '1', 'x-two': '2' });
  });

  it('matches file-system function routes', () => {
    assert.deepEqual(routing.matchFunctionRoute('/api/hello', '/api/hello'), {});
    assert.deepEqual(
      routing.matchFunctionRoute('/api/users/[id]', '/api/users/42'),
      { id: '42' }
    );
    assert.deepEqual(
      routing.matchFunctionRoute('/api/files/[...path]', '/api/files/a/b/c'),
      { path: 'a/b/c' }
    );
    assert.equal(routing.matchFunctionRoute('/api/users/[id]', '/api/users'), null);
  });
});

/* ---------------------------------------------------------- static files */

describe('static file resolution', () => {
  it('serves index.html for the root', () => {
    assert.deepEqual(staticFiles.resolveCandidates('/', false), ['index.html']);
  });

  it('tries extensionless HTML and directory indexes', () => {
    const candidates = staticFiles.resolveCandidates('/about', false);
    assert.deepEqual(candidates, ['about', 'about.html', 'about/index.html']);
  });

  it('does not append .html to files with an extension', () => {
    assert.deepEqual(staticFiles.resolveCandidates('/app.js', false), ['app.js']);
  });

  it('escapes HTML in error pages', () => {
    const page = staticFiles.errorPage(404, 'Not found', '<script>alert(1)</script>');
    assert.equal(page.includes('<script>alert(1)</script>'), false);
    assert.equal(page.includes('&lt;script&gt;'), true);
  });
});

/* -------------------------------------------------------------- builder */

describe('serverless function discovery', () => {
  it('maps the api directory to routes', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'api', 'users'), { recursive: true });
    writeFileSync(path.join(dir, 'api', 'hello.js'), 'export default () => {}');
    writeFileSync(path.join(dir, 'api', 'index.ts'), 'export default () => {}');
    writeFileSync(path.join(dir, 'api', 'users', '[id].js'), 'export default () => {}');
    writeFileSync(path.join(dir, 'api', '_helper.js'), 'export const x = 1');
    writeFileSync(path.join(dir, 'api', 'notes.md'), '# not a function');

    const routes = discoverFunctions(dir).map((f) => f.route);
    assert.equal(routes.includes('/api/hello'), true);
    assert.equal(routes.includes('/api'), true);
    assert.equal(routes.includes('/api/users/[id]'), true);
    assert.equal(routes.includes('/api/_helper'), false);
    assert.equal(routes.length, 3);
  });

  it('orders static routes before dynamic ones', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'api'), { recursive: true });
    writeFileSync(path.join(dir, 'api', '[slug].js'), '');
    writeFileSync(path.join(dir, 'api', 'health.js'), '');
    const routes = discoverFunctions(dir).map((f) => f.route);
    assert.equal(routes[0], '/api/health');
  });

  it('returns nothing when there is no api directory', () => {
    assert.deepEqual(discoverFunctions(tempDir()), []);
  });
});

describe('executor', () => {
  it('converts Windows paths for WSL', () => {
    assert.equal(
      paths.toWslPath('D:\\Projects\\my-app\\data'),
      '/mnt/d/Projects/my-app/data'
    );
    assert.equal(
      paths.toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\data'),
      '/home/me/data'
    );
  });

  it('quotes values safely for the shell', () => {
    assert.equal(paths.shQuote("it's"), `'it'\\''s'`);
    assert.equal(paths.shQuote('rm -rf /'), `'rm -rf /'`);
  });

  it('renders a build script with the environment applied', () => {
    const script = renderScript('npm run build', '/tmp/app', {
      API_KEY: "shh'quote",
      'BAD-NAME': 'ignored',
    });
    assert.match(script, /set -euo pipefail/);
    assert.match(script, /export API_KEY='shh'\\''quote'/);
    assert.equal(script.includes('BAD-NAME'), false);
    assert.match(script, /npm run build/);
  });
});

/* ------------------------------------------------- login-page validation */

describe('domain check shown while typing', () => {
  // The login page mirrors this to validate before submitting; the server
  // still enforces the same rule in isEmailAllowed.
  const domains = ['availproject.org'];
  const allowed = (email) => {
    const at = email.lastIndexOf('@');
    if (at === -1) return false;
    return domains.includes(email.slice(at + 1).toLowerCase().trim());
  };

  it('agrees with the server for allowed addresses', () => {
    for (const email of [
      'anuj@availproject.org',
      'first.last+tag@availproject.org',
      'ANUJ@AvailProject.ORG',
    ]) {
      assert.equal(allowed(email), true, email);
      assert.equal(isEmailAllowed(email), true, email);
    }
  });

  it('agrees with the server for rejected addresses', () => {
    for (const email of [
      'anuj@gmail.com',
      'anuj@notavailproject.org',
      'anuj@availproject.org.evil.com',
      'anuj@',
      'availproject.org',
      '',
    ]) {
      assert.equal(allowed(email), false, email);
      assert.equal(isEmailAllowed(email), false, email);
    }
  });

  it('uses the last @ so an address cannot smuggle a domain in the local part', () => {
    assert.equal(allowed('a@availproject.org@evil.com'), false);
    assert.equal(isEmailAllowed('a@availproject.org@evil.com'), false);
  });
});

describe('password complexity rule', () => {
  // Mirrors apps/dashboard/src/validation.ts's passwordError, which mirrors
  // the server's validate_password in rust-api/src/routes/auth.rs — the
  // server is the real gate, this and the dashboard copy are both feedback.
  const passwordError = (password) => {
    if (password.length < 8) return 'length';
    if (!/[A-Z]/.test(password)) return 'uppercase';
    if (!/[a-z]/.test(password)) return 'lowercase';
    if (!/[^A-Za-z0-9]/.test(password)) return 'special';
    return null;
  };

  it('accepts a password meeting every rule', () => {
    assert.equal(passwordError('Correct1!'), null);
  });

  it('rejects a password missing any one rule', () => {
    assert.equal(passwordError('sh0rt!'), 'length');
    assert.equal(passwordError('lowercase1!'), 'uppercase');
    assert.equal(passwordError('UPPERCASE1!'), 'lowercase');
    assert.equal(passwordError('Password123'), 'special');
  });
});
