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
│  React SPA   │ HTTP │  Rust + SQLite   │ spawn│   WSL or local   │
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
| Serverless functions | `api/*.js|ts` become routed functions with `[param]` and `[...catchAll]` segments, Node and Web handler signatures — each function gets **its own process**, so one crashing handler can't take a sibling function down with it |
| SSR frameworks | Next.js, Nuxt, SvelteKit, Remix, Nest… run as supervised server processes, booted on first request and reaped when idle |
| Environment variables | AES-256-GCM encrypted, scoped to production/preview/development and optionally to one branch |
| Domains | System domains per deployment/branch/project, plus custom domains |
| `vercel.json` | `avail.json` (or `vercel.json`) for redirects, rewrites, headers, cleanUrls, functions |
| Ignored Build Step | An optional per-project command; exit `0` skips the build (deployment lands `SKIPPED`), any other code builds normally |
| Commit status & PR comments | `pending`→`success`/`failure` status checks on the commit, plus a "Deploy Preview ready" comment on the pull request |
| Preview comments | A comment thread on each deployment, in the dashboard — anyone signed in can post, only the author can delete their own |
| Access control | First user to sign in becomes the **owner**; everyone else joins as a **member**. Deleting a project or one of its custom domains needs the owner, or whoever created that project — never someone else's |
| HTTPS | The proxy also terminates TLS on a second port with a self-signed cert for `*.avail.localhost` (local-only — see [Known limits](#known-limits)) |
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
| Deployment proxy (HTTPS, self-signed) | https://localhost:3443 |

Open the dashboard and sign in with any `@availproject.org` address. Without
SMTP configured the one-time code is shown directly in the UI and printed to the
API log, so local setup needs no mail server.

### Sign-in methods

Three methods, all gated on the same email domain allow-list:

| Method | Setup | Notes |
| --- | --- | --- |
| **Email code** | none | Always available. A 6-digit code, hashed at rest, valid 10 minutes, 5 attempts. Delivered by SMTP when `SMTP_URL` is set, otherwise shown in the UI. |
| **Google** | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Identity only. OIDC authorization-code flow; the ID token's `iss`, `aud`, `exp` and `email_verified` claims are all checked. |
| **GitHub** | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | Also attaches the account for repository access, so one click both signs in and connects Git. |

A provider's button only appears once its credentials are configured, and its
`/start` endpoint returns `400 oauth_unavailable` otherwise — so an
unconfigured provider can never dead-end a user at a broken consent screen.

The login page offers **Log in** and **Sign up**. Both issue the same one-time
code; the choice only decides which message you get when the account does or
does not already exist — logging in without an account, or signing up with one,
switches you to the other tab and explains why. Since anyone on an allow-listed
domain may sign up regardless, saying which case applies leaks nothing they
could not learn by trying.

The domain is checked **as you type**, against the allow-list the page already
received from `/api/auth/config` — so it costs no request per keystroke, and a
disallowed address is rejected before anything is submitted. That is feedback
only; `isEmailAllowed` still enforces the same rule on the server, and the unit
tests assert the two agree (including that both parse on the *last* `@`, so
`a@availproject.org@evil.com` is rejected by each).

Whichever method is used, the address must be on an allow-listed domain. An
outside Google or GitHub account is bounced back to the login page with the
reason; there is no open registration, and the first user to sign in becomes
the workspace owner.

**Google setup:** create an OAuth 2.0 Client ID of type *Web application* in the
[Google Cloud console](https://console.cloud.google.com/apis/credentials) and
add `http://localhost:3001/api/auth/google/callback` as an authorised redirect
URI. When exactly one domain is allow-listed it is passed as Google's `hd`
hint, so Workspace users land on their work account instead of an account
chooser full of personal ones.

**GitHub setup:** create an OAuth App at
[github.com/settings/applications/new](https://github.com/settings/applications/new)
with homepage URL `http://localhost:3000` and authorization callback URL
`http://localhost:3001/api/auth/github/callback`, then set `GITHUB_CLIENT_ID`
and `GITHUB_CLIENT_SECRET`. Unlike Google, GitHub is identity **and**
repository access in one step: signing in with GitHub attaches that same
account for cloning private repos, registering webhooks and reporting build
status — no separate connect step. Someone who signed up with email or
Google instead gets a **Connect with GitHub OAuth** button on
**Settings → Git** to add it afterward, using the exact same OAuth flow
(`intent=connect` instead of `intent=signin` — the only difference is
whether it also starts a session or just attaches to the one you already
have).

The first user to sign in becomes the workspace **owner**; everyone else on the
domain joins as a **member**. Both can create, build, and edit projects the
same way — the owner/member split only gates the destructive, hard-to-undo
actions: deleting a project and removing a custom domain. Either needs the
owner, or specifically whoever created that project (`created_by`) — a
member can always clean up a project they made themselves, but can't touch
one someone else on the workspace created. Everything else (env vars,
webhooks, redeploys, comments) is unrestricted between the two.

### Deploy something

1. **Settings → Git → Connect with GitHub OAuth** (if `GITHUB_CLIENT_ID` is
   configured — see [Sign-in methods](#sign-in-methods) above), or paste a
   personal access token with `repo` and `admin:repo_hook` scopes if it
   isn't. Signing in with GitHub in the first place skips this step entirely.
2. **Add New** — pick a repository (or paste a git URL or a local path).
3. The first production deployment starts immediately; logs stream live.
4. **Git → Create webhook on GitHub** so later pushes deploy on their own. If
   this host is not reachable from GitHub, leave it off — the platform polls
   every 60s instead.

Push to a branch and you get a preview; push to `main` and production updates.

### Dashboard layout

The dashboard has two shells that share the same sidebar shape:

- **Workspace home** (`/`, opened by clicking the **Avail Deploy** logo or the
  project switcher's **All Projects** entry) — **All Projects**, **Deployments**,
  **Logs**, **Environment Variables**, **Domains** and **Settings**, each
  showing that resource across *every* project (env vars and domains are
  read-only here; add or remove them from a project's own Settings tab).
- **A project's own shell** (`/projects/:slug`, opened from the switcher or a
  project card) — the same six tabs, scoped to just that one project, with the
  usual editing (build settings, env vars, domains, git integration).

A deployment's own page also has a **Comments** section — a lightweight
thread for leaving notes on that specific build ("approving this preview",
"why did this fail"). Anyone signed in can post; only the author can delete
their own comment.

For the full walkthrough — creating, navigating and deleting projects,
deployments, environment variables and domains, each with a screen preview —
open the dashboard's own **Docs** page: click the avatar in the top-right
corner and choose **Docs**, or go straight to `/docs`. It is built from the
app's own UI components, so it never drifts out of sync with what you
actually see.

### What triggers a deployment

| Event | GitHub repo + webhook | Polling (GitHub or a local path) |
| --- | --- | --- |
| Commit on the production branch | immediate, production | within the poll interval, production |
| Commit on any other branch | immediate, preview | within the poll interval, preview |
| Branch created | immediate, preview | within the poll interval, preview |
| Pull request opened / updated | immediate, preview + a comment on the PR | picked up as a branch (no PR link) |
| Branch deleted | ignored | ignored |

Every GitHub-connected build reports back onto the commit as it progresses —
a `pending` status while building, `success`/`failure` once it finishes —
and a preview deployment built for a pull request gets a "Deploy Preview
ready" comment on that PR once it's live. Both use whichever GitHub account
is connected under **Settings → Git**; a project with no GitHub connection
(a local path, for instance) still builds, it just has nothing to report to.

A project can also define an **Ignored Build Step** — a shell command run
right after checkout. If it exits `0` the build stops there and the
deployment lands `SKIPPED` (no install, no build, nothing published); any
other exit code builds normally. Useful for a monorepo where most commits
don't touch a given project — e.g. `git diff --quiet HEAD^ HEAD -- packages/app`.

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
with no DNS or hosts-file setup. The proxy listens on both plain HTTP
(`:3002`) and HTTPS (`:3443`, `PROXY_HTTPS_PORT`) — the HTTPS cert is a
self-signed one for `*.avail.localhost`, generated on first boot
(`~/.avail-deploy/certs/`) and reused after that; browsers will show the
expected "not trusted" warning for it (see [Known limits](#known-limits)).

From there:

- **Static deployments** are served from disk with ETags, range requests,
  immutable caching for fingerprinted assets, clean URLs, `404.html`, and SPA
  fallback when there is no 404 page.
- **Serverless functions** get **their own process each** — `acquire`d and
  booted the first time that specific route is hit, keyed by
  `<deploymentId>:fn:<route>` rather than by deployment alone, so one
  function crashing or leaking memory can't take a sibling function in the
  same deployment down with it (each is reaped independently when idle, and
  rebooted on its own the next time it's hit). Both handler signatures work:

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
  builder/     git fetch, framework resolution, install/build, output collection
                (used by apps/proxy's runtime; the control plane builds via avail-worker instead)
  proxy/       host routing, static serving, function + server runtimes
  dashboard/   React SPA
  cli/         avail command line client
packages/
  shared/      config, types, crypto, ids, logging
  db/          SQLite schema and typed queries (node:sqlite) — read by apps/proxy
  frameworks/  74 framework presets + detection
scripts/       dev runner, environment doctor
tests/         unit tests (node:test)
rust-api/      the control-plane API and build runner (avail-api, avail-worker bins) — see below
```

### The Rust backend (`rust-api/`)

The control plane — auth (email-code sign-in and GitHub/Google OAuth),
projects, env vars, domains, deployments, webhook intake, both SSE streams,
and the entire build pipeline (git fetch, framework detection, install/build,
output collection) — is Rust. The control plane used to be a Node app
(`apps/api`) with its own build runner (`apps/worker`); both were removed
once `rust-api` reached full parity and real end-to-end builds were verified
with no Node process involved. `apps/proxy` (routing, static serving,
long-lived runtime process management) is the one piece still Node — it
reads deployments/aliases straight from the shared SQLite database, so it
works unmodified regardless of which backend wrote them, and still uses
`apps/builder`'s process-spawn primitives (`run`/`kill`/`execPath`) to manage
already-built server-mode deployments.

`rust-api` ships **two** binaries from one `cargo build`:

- `avail-api` — the HTTP API, on `RUST_API_PORT` (default `3011`, or `3001`
  when started via `npm run dev`/`npm start` to match `apps/proxy` and the
  dashboard's zero-config expectations).
- `avail-worker` — the build runner. A build is coordinated purely through
  the shared SQLite database (already WAL-mode multi-process-safe):
  `avail-api` inserts a `QUEUED` deployment row, `avail-worker` polls for it
  and runs the real build — no IPC either way. The only Node.js involved in
  a build is the *deployed project's own* toolchain inside the WSL sandbox
  (`npm install`, `next build`), same as any real deployment target.

Encryption, signed cookies, id generation and webhook signatures are
byte-for-byte compatible with the removed Node implementation (parity-tested
against real Node-produced values, before it was removed).

See [`docs/rust-api-migration-plan.md`](docs/rust-api-migration-plan.md) for
the full migration history, the parity requirements, the process-boundary
design, and what's still open (the SMTP mailer has no Rust port yet — see
`.env`'s `AUTH_DEV_ECHO` — and `apps/proxy` itself is still pure Node).

`npm run dev` / `npm start` build the Rust binaries (`cargo build --bins` in
`rust-api/`, using the GNU toolchain override on Windows — see the plan
doc's toolchain note) and start them alongside `apps/proxy` and the
dashboard together, in one command — `scripts/dev.mjs`.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Rust API + Rust build worker + proxy + dashboard, prefixed output |
| `npm start` | same, release build, built dashboard |
| `npm run dev:proxy` / `dev:dashboard` | one Node service |
| `node scripts/dev.mjs --only api,worker` | just the Rust binaries |
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
| `PROXY_HTTPS_PORT` | `3443` | The proxy's self-signed TLS listener |
| `BUILD_CONCURRENCY` | `2` | Parallel builds |
| `GITHUB_POLL_INTERVAL_SECONDS` | `60` | Fallback when webhooks cannot reach this host |
| `GOOGLE_CLIENT_ID` / `_SECRET` | unset | Enables "Continue with Google" |
| `GITHUB_CLIENT_ID` / `_SECRET` | unset | Enables "Continue with GitHub" |
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

- One workspace per install. Role (owner/member) is workspace-wide, not
  per-project — the only per-project carve-out is that a project's own
  creator can delete it. No teams, no invite step (anyone on the allowed
  email domain can sign up and gets full member access immediately), and
  no finer-grained per-project permissions than that.
- Build isolation is process-level, not container-level. Repository build
  scripts run as the platform user. Serverless functions are one process per
  function (crash-isolated from each other), not one sandboxed invocation
  per request the way a real Lambda-style platform works.
- No edge middleware, image optimization, ISR, or analytics/speed insights.
- Custom domains are matched on the `Host` header. The proxy's own HTTPS
  listener uses a **self-signed** certificate — real publicly-trusted TLS
  (ACME/Let's Encrypt) needs a public domain and DNS this install doesn't
  have; production TLS for a custom domain is left to whatever fronts the
  proxy.
- No repository poller in `avail-worker` beyond webhooks — `/api/system/poll`
  and the "Check repositories now" button are documented stubs (`501`).
