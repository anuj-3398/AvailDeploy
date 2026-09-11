# Avail Deploy

An in-house deployment platform — a Vercel clone built from scratch. Connect a
Git repository, and every push is built, deployed and served: pushes to the
production branch go live, every other branch and pull request gets its own
preview URL.

Sign-in is restricted to a single email domain (`@availproject.org` by default);
any address on that domain is allowed in.

```
┌──────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Dashboard   │─────▶│   Control plane  │─────▶│  Build executor  │
│  React SPA   │ HTTP │  Fastify + SQLite│ spawn│   WSL or local   │
│   :3000      │◀ SSE │      :3001       │      │  git → install → │
└──────────────┘      └────────┬─────────┘      │      build       │
                               │                └────────┬─────────┘
                      GitHub   │  webhooks              artifacts
                      polling  │  + OAuth/PAT               │
                               ▼                            ▼
                      ┌────────────────────────────────────────────┐
                      │            Deployment proxy :3002          │
                      │  host → alias → deployment                 │
                      │  static files · serverless fns · SSR procs │
                      └────────────────────────────────────────────┘
```

---

## What it does

| Vercel feature | Avail Deploy |
| --- | --- |
| Git integration | GitHub OAuth app **or** personal access token; webhooks (`push`, `pull_request`) with HMAC verification, plus polling for hosts without a public URL — including plain local directories |
| Framework detection | 74 presets ported from the Vercel CLI, with the same `every`/`some`/`supersedes` algorithm |
| Builds | Install → build in an isolated workspace, live-streamed logs, build cache, cancellation, concurrency limit |
| Production deploys | Pushes to the production branch publish to `<project>.avail.localhost` |
| Preview deploys | Every other branch and every PR gets `<project>-<hash>.avail.localhost` plus a stable `<project>-git-<branch>` alias |
| Instant rollback | Promote any READY deployment — an alias swap, no rebuild |
| Serverless functions | `api/*.js|ts` become routed functions with `[param]` and `[...catchAll]` segments, Node and Web handler signatures |
| SSR frameworks | Next.js, Nuxt, SvelteKit, Remix, Nest… run as supervised server processes, booted on first request and reaped when idle |
| Environment variables | AES-256-GCM encrypted, scoped to production/preview/development and optionally to one branch |
| Domains | System domains per deployment/branch/project, plus custom domains |
| `vercel.json` | `avail.json` (or `vercel.json`) for redirects, rewrites, headers, cleanUrls, functions |
| Commit status | Build state reported back to GitHub commits; preview URL posted on the PR |
| CLI | `avail login / deploy / logs / env / rollback` |

---

## Requirements

- **Node.js 22+** on the host (uses the built-in `node:sqlite` — no native modules)
- **A POSIX build environment**: WSL on Windows (default), or the local shell on
  macOS/Linux. It needs `git`, `bash`, `tar` and Node.

Check everything at once:

```bash
npm run doctor
```

---

## Getting started

```bash
npm install
cp .env.example .env   # then set AVAIL_SECRET
npm run dev
```

| Service | URL |
| --- | --- |
| Dashboard | http://localhost:3000 |
| Control plane API | http://localhost:3001 |
| Deployment proxy | http://localhost:3002 |

Open the dashboard and sign in with any `@availproject.org` address. Without
SMTP configured the one-time code is shown directly in the UI and printed to the
API log, so local setup needs no mail server.

The first user to sign in becomes the workspace **owner**; everyone else on the
domain joins as a **member**.

### Deploy something

1. **Git → Personal access token** — paste a GitHub token with `repo` and
   `admin:repo_hook`, or use OAuth if you configured `GITHUB_CLIENT_ID`.
2. **Add New** — pick a repository (or paste a git URL or a local path).
3. The first production deployment starts immediately; logs stream live.
4. **Git → Create webhook on GitHub** so later pushes deploy on their own. If
   this host is not reachable from GitHub, leave it off — the platform polls
   every 60s instead.

Push to a branch and you get a preview; push to `main` and production updates.

### What triggers a deployment

| Event | GitHub repo + webhook | Polling (GitHub or a local path) |
| --- | --- | --- |
| Commit on the production branch | immediate, production | within the poll interval, production |
| Commit on any other branch | immediate, preview | within the poll interval, preview |
| Branch created | immediate, preview | within the poll interval, preview |
| Pull request opened / updated | immediate, preview + a comment on the PR | picked up as a branch (no PR link) |
| Branch deleted | ignored | ignored |

Polling watches whatever git can see: a GitHub repository through the API, or a
local directory through `git for-each-ref`. It reads committed refs, so an
edit only deploys once you commit it — uncommitted working-tree changes are
never deployed.

Branch heads are recorded when a project is imported, so the first poll of an
existing repository does not deploy every branch at once. Set `autoDeploy` off
per project to disable this entirely, or `previewDeploys` off to keep only the
production branch automatic.

---

## How it works

### Build isolation

Builds run **outside the platform repository** — by default in
`~/.avail-deploy`. This matters: Node and npm resolve modules by walking up the
directory tree, so a build nested inside this repo would silently inherit the
platform's own `node_modules` and npm workspace instead of installing its own
dependencies. `npm run doctor` fails loudly if `AVAIL_DATA_DIR` is misplaced.

Each deployment gets an immutable directory:

```
<workspace>/
├── projects/<projectId>/src/      # long-lived checkout, reused every build
└── deployments/<deploymentId>/
    ├── manifest.json              # what the proxy needs to serve this build
    └── src/                       # hard-linked snapshot of the workspace
```

Install runs with `NODE_ENV=development` (package managers drop
`devDependencies` otherwise, and build tooling lives there); the build itself
runs with `NODE_ENV=production`. Both get Vercel-compatible system variables —
`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_COMMIT_SHA`… — alongside the
`AVAIL_*` equivalents, so unmodified Vercel projects build as-is.

### The build executor

Build commands never run in the platform's process. They are rendered into a
shell script and executed through one of two executors:

- **`wsl`** (default on Windows): `wsl.exe -d Ubuntu -- bash <script>`, with
  Windows paths translated to `/mnt/<drive>/…`. Builds get a real Linux
  toolchain, as they would on Vercel.
- **`local`** (default elsewhere): `bash <script>`.

Writing a script file instead of passing a long `-c` string keeps quoting sane
across the Windows → `wsl.exe` → bash boundary. `nvm` and `corepack` are picked
up automatically when present.

### Serving

The proxy maps `Host` → alias → deployment on every request:

| Domain | Points at |
| --- | --- |
| `<project>.avail.localhost:3002` | current production deployment |
| `<project>-git-<branch>.avail.localhost:3002` | latest deployment of that branch |
| `<project>-<hash>.avail.localhost:3002` | one specific deployment, forever |
| `localhost:3002/_d/<deploymentId>/…` | the same, without wildcard DNS |

`*.localhost` resolves to 127.0.0.1 in every modern browser, so previews work
with no DNS or hosts-file setup.

From there:

- **Static deployments** are served from disk with ETags, range requests,
  immutable caching for fingerprinted assets, clean URLs, `404.html`, and SPA
  fallback when there is no 404 page.
- **Serverless functions** are hosted by a per-deployment Node process that
  loads handlers lazily. Both signatures work:

  ```js
  // api/hello.js — Node style
  export default function handler(req, res) {
    res.status(200).json({ hello: req.query.name });
  }

  // api/hello.js — Web style
  export default async function handler(request) {
    return Response.json({ ok: true });
  }
  ```

- **Server deployments** (Next.js and friends) boot the framework's own server
  on a private port; the proxy forwards to it. The process starts on the first
  request and is reaped after 15 idle minutes.

### `avail.json`

Optional, read from the project root (`vercel.json` works too):

```json
{
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "cleanUrls": true,
  "redirects": [{ "source": "/old/:id", "destination": "/new/:id", "permanent": true }],
  "rewrites": [{ "source": "/docs/:path*", "destination": "/documentation/:path*" }],
  "headers": [
    { "source": "/(.*)", "headers": [{ "key": "x-frame-options", "value": "DENY" }] }
  ],
  "functions": { "api/report.ts": { "maxDuration": 120 } }
}
```

Precedence: project settings in the dashboard → `avail.json` → framework preset.

---

## CLI

```bash
npm link            # or: node --experimental-strip-types apps/cli/src/cli.ts

avail login                    # email code, same domain rules
avail deploy            # preview deployment of the current repo
avail deploy --prod            # production deployment
avail logs <deploymentId>      # stream build logs
avail env add API_URL=https://api.internal preview
avail rollback <deploymentId>  # repoint production, no rebuild
```

`avail deploy` on a repository with a GitHub remote links it to that repository;
otherwise the local path is cloned directly, which works when the CLI runs on
the same machine as the platform.

---

## Security notes

- Sign-in is gated on the email **domain**; there is no open registration.
- Sessions are server-side rows referenced by an HMAC-signed cookie.
- Environment variables and git tokens are encrypted at rest with AES-256-GCM,
  keyed by `AVAIL_SECRET` with a per-purpose derived key. Variable values are
  never returned in list responses — revealing one is a separate request.
- Webhook payloads are verified with a per-project HMAC secret.
- Set `AVAIL_SECRET` before anyone else uses the install, and turn off
  `AUTH_DEV_ECHO` once SMTP works. Rotating `AVAIL_SECRET` invalidates every
  session, stored token and encrypted variable.
- Build commands come from the repository and run with the platform user's
  privileges. Treat connected repositories as trusted code.

---

## Layout

```
apps/
  api/         control plane — auth, projects, deployments, webhooks, SSE
  builder/     git fetch, framework resolution, install/build, output collection
  proxy/       host routing, static serving, function + server runtimes
  dashboard/   React SPA
  cli/         avail command line client
packages/
  shared/      config, types, crypto, ids, logging
  db/          SQLite schema and typed queries (node:sqlite)
  frameworks/  74 framework presets + detection
scripts/       dev runner, environment doctor
tests/         unit tests (node:test)
```

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | API + proxy + dashboard, prefixed output |
| `npm start` | API + proxy + built dashboard |
| `npm run dev:api` / `dev:proxy` / `dev:dashboard` | one service |
| `npm test` | unit tests |
| `npm run typecheck` | TypeScript across every workspace |
| `npm run doctor` | environment check |
| `npm run build` | build the dashboard |

---

## Configuration

Every option lives in `.env` — see [.env.example](.env.example). The ones worth
knowing:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOWED_EMAIL_DOMAINS` | `availproject.org` | Who may sign in |
| `AVAIL_SECRET` | insecure default | Signing + encryption key |
| `AVAIL_DATA_DIR` | `~/.avail-deploy` | Database and platform metadata |
| `AVAIL_WORKSPACE_DIR` | WSL-native, auto-detected | Where builds run and artifacts live |
| `BUILD_EXECUTOR` | `wsl` on Windows | `wsl` or `local` |
| `DEPLOYMENT_DOMAIN` | `avail.localhost` | Wildcard base for deployment URLs |
| `BUILD_CONCURRENCY` | `2` | Parallel builds |
| `GITHUB_POLL_INTERVAL_SECONDS` | `60` | Fallback when webhooks cannot reach this host |
| `SMTP_URL` | unset | Real delivery for sign-in codes |

## Build performance

Three things dominate build time on a self-hosted builder, and all three are
handled automatically.

**1. The workspace filesystem.** On Windows the build runs inside WSL. A
workspace on a `/mnt/<drive>` mount crosses the 9p bridge for every file, and
`npm install` writes tens of thousands of small files — so the filesystem
boundary, not the compiler, sets the pace. The workspace is therefore
auto-detected to the WSL-native filesystem
(`\\wsl.localhost\<distro>\home\<user>\.avail-deploy`), while SQLite stays on
the Windows disk where file locking behaves. Override with
`AVAIL_WORKSPACE_DIR`, or opt out with `WSL_NATIVE_WORKSPACE=false`.

**2. Workspace reuse.** Each project keeps one long-lived checkout under
`projects/<projectId>`. Builds `git fetch` into it rather than cloning fresh,
so `node_modules` and the framework cache (`.next/cache`, …) survive between
builds and installs become incremental. Builds of one project are serialized
so they never share that directory concurrently.

**3. Publishing artifacts.** Deployments are snapshotted with hard links
(`cp -al`), not copied or tarred. A 325 MB `node_modules` snapshot costs
directory entries instead of minutes of I/O, and keeping twenty deployments
costs close to nothing. `.next/cache` is excluded, since later builds mutate
it in place.

Measured on a real Next.js 16 project (325 MB of dependencies, 10,406 files):

| Phase | Before | After (cold) | After (warm) |
| --- | ---: | ---: | ---: |
| `npm install` | 239.5s | 28.2s | 2.1s |
| `next build` | 91.9s | 12.9s | 6.3s |
| Publish artifacts | 142.0s (tar) | 2.1s (hard link) | 1.7s |
| **Total** | **475.8s** | **45.3s** | **12.2s** |
| First request (SSR cold boot) | 23.6s | 2.3s | 2.3s |

"Cold" is a fresh workspace; "warm" is a rebuild that reuses it.

---

## Known limits

- One workspace per install — no teams or per-project permissions yet.
- Build isolation is process-level, not container-level. Repository build
  scripts run as the platform user.
- No edge middleware, image optimization, ISR or analytics.
- Custom domains are matched on the `Host` header; TLS termination is left to
  whatever fronts the proxy.
