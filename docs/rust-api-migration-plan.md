# Control-plane API → Rust: migration plan

Scope, agreed with the user: **only `apps/api` moves to Rust.** `apps/proxy`,
`apps/builder`, `apps/cli`, and `packages/*` stay Node/TypeScript exactly as
they are. The dashboard is a separate, later effort (migrating it from its
current Vite + React SPA to Next.js) and is not touched by this plan.

The new code lives at **`rust-api/`**, outside the npm workspace globs
(`apps/*`, `packages/*` in the root `package.json`) so it cannot affect
`npm install` or any existing script. Nothing under `apps/api` is deleted or
edited by this plan — the Node API keeps running exactly as today until a
deliberate, separate cutover step (see “Rollout”) once the Rust one is proven
equivalent.

## Why this needs a process boundary, not just a language swap

`apps/api` does not only serve HTTP — its `services/queue.ts` calls straight
into `@avail/builder`'s `runBuild()` **in the same process**, and streams
build output to the dashboard through an **in-process event bus**
(`lib/bus.ts`, `bus.onLog` / `bus.onAnyDeployment`). Neither of those crosses
a process boundary for free. Since `@avail/builder` stays Node, the Rust API
cannot call it directly.

**Resolution: split what is currently "apps/api" into two processes that
coordinate through the SQLite database, which is already multi-process-safe**
(`PRAGMA journal_mode = WAL`, `busy_timeout = 5000` — the proxy already writes
`request_logs` rows concurrently with the API reading them today).

- **`rust-api`** (new) — HTTP surface: auth, projects, env vars, domains,
  webhook intake, deployment metadata (list/get/promote/cancel/delete), and
  every SSE endpoint. Inserts deployment rows in `QUEUED` state; never runs a
  build itself.
- **`apps/worker`** (new, Node — extracted from `apps/api/src/services/{queue,poller,logs}.ts`,
  unchanged otherwise) — polls `deployments` for `QUEUED` rows (same query
  `deployments.queued()` already uses for crash recovery today), runs them
  through the existing `@avail/builder`, and writes state/log rows back to
  the same SQLite file. No HTTP surface of its own is required for
  correctness; a small one is worth adding later purely to avoid the poll
  latency (see “Nice-to-have” below).

This means the two SSE endpoints change *implementation* (poll the DB instead
of subscribing to an in-process emitter) but not *contract* — the dashboard
sees the same event names and payloads either way, so it needs zero changes
for this phase.

| Today (in-process) | After the split |
| --- | --- |
| `bus.onLog(id, cb)` pushes new `build_logs` rows as the builder writes them | SSE handler polls `build_logs WHERE deployment_id = ? AND seq > ?` every ~300ms and pushes new rows |
| `bus.onAnyDeployment(cb)` pushes on every state change | SSE handler polls `deployments` (all rows changed since last tick, tracked in memory) every ~500ms |
| `queue.status` / `poller.status` read in-process state | `apps/worker` exposes a tiny `GET /status` on a private port; `rust-api` proxies it for `/api/system/status` |

Latency added: at most one poll interval (hundreds of ms) — imperceptible for
a dev tool, and it removes the only reason the two could not be different
languages.

## Byte-for-byte parity requirements

These are the pieces where "close enough" breaks something real (an existing
encrypted `token_enc` / `value_enc` column becomes unreadable, an existing
session cookie stops verifying, a GitHub webhook signature check fails):

- **AES-256-GCM secrets** (`packages/shared/src/crypto.ts` `encrypt`/`decrypt`):
  key = `scrypt(AVAIL_SECRET, "avail:" + purpose, N=16384, r=8, p=1, dklen=32)`,
  payload = `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`, 12-byte random
  IV. The Rust `scrypt` crate must be given those exact cost parameters
  (`Params::new(14, 8, 1, 32)`) — its defaults differ.
- **Signed tokens** (session cookie value, oauth `state`): `value + "." + hex(hmac_sha256(value, key("sign" or "session" or "oauth")))`.
  Cookie itself is not double-signed by a cookie library on either side — the
  app signs the value by hand, `@fastify/cookie` (Node) / the cookie jar
  (Rust) only parses/writes the raw string.
- **IDs** (`packages/shared/src/ids.ts`): `<prefix>_<n chars>` where each
  char is `ALPHABET[random_byte % 36]`, `ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"`.
  Default size 20 (28 for sessions). Not cryptographically uniform (256 % 36
  ≠ 0) — replicate the exact algorithm, not a "better" one, so existing rows'
  ids stay in the same shape as new ones.
- **Login codes**: 6-digit, `hmac_sha256(code, key("login-code"))` stored as
  the hash; compare with a constant-time equality check.
- **GitHub webhook signature**: `sha256=` + hex hmac-sha256 of the *raw*
  request body (not the parsed/re-serialized JSON) using the project's
  `webhook_secret`. Rust must read the raw bytes before any JSON extraction.
- **Cookie flags**: name `avail_session` (configurable), `HttpOnly`,
  `SameSite=Lax`, `Secure` only when `DEPLOYMENT_SCHEME=https`, `Path=/`,
  `Max-Age` = `SESSION_TTL_DAYS` (default 30) in seconds.
- **SQLite schema**: `rust-api` runs the *identical* `CREATE TABLE IF NOT
  EXISTS` / index statements from `packages/db/src/schema.ts` on boot, so
  either process can create the file first with no drift. New migrations
  must be added to both `schema.ts`'s `MIGRATIONS` and the Rust equivalent
  in lockstep for as long as both exist.
- **`.env` loading**: same two-file (`\.env`, then `.env.local`, first value
  wins) loader as `config.ts`, so a value set in one is honored by both
  processes without duplicating configuration.

## Crate choices

| Concern | Crate |
| --- | --- |
| HTTP server / router | `axum` 0.7 (+ `tokio` "full") |
| SQLite | `rusqlite` (`bundled` feature — statically linked, no system SQLite dependency, same "no external DB server" property `node:sqlite` gives today) |
| Serialization | `serde`, `serde_json` |
| AES-256-GCM | `aes-gcm` |
| Key derivation | `scrypt` (explicit `Params::new(14, 8, 1, 32)`) |
| HMAC-SHA256 | `hmac`, `sha2` |
| Constant-time compare | `subtle` |
| Random bytes | `rand` (`OsRng`) |
| base64url | `base64` (`URL_SAFE_NO_PAD` engine) |
| Cookies | `axum-extra` (`CookieJar`) — no signing feature used, matching today |
| CORS | `tower-http` (`cors`) |
| Outbound HTTP (GitHub/Google OAuth, phase 2) | `reqwest` (`json`, `rustls-tls`) |
| Logging | small hand-rolled module mirroring `packages/shared/src/logger.ts`'s `HH:MM:SS.mmm LEVEL [scope]` format, so combined `npm run dev`-style output still reads the same |

`Connection` is wrapped in `Arc<Mutex<Connection>>` — SQLite access is
serialized within the process either way (matching `node:sqlite`'s
synchronous, single-threaded access pattern), and WAL mode is what makes the
*other* process (the worker, or Node's proxy) safe to write concurrently.

## Endpoint inventory and phasing

**Phase 1 — this session.** Foundation + the email-code auth path, which is
enough to sign in and hit authenticated endpoints end-to-end:

- `config`, `crypto`, `ids` modules (parity-critical, listed above)
- `db` module: schema bootstrap + every table's query functions (`users`,
  `sessions`, `login_codes`, `git_integrations`, `projects`, `env_vars`,
  `deployments`, `build_logs`, `aliases`, `repo_watch`, `events`,
  `request_logs`, `webhook_deliveries`) — ported in full even though not
  every route that uses them exists yet, since it's mechanical, low-risk, and
  everything else depends on it being right.
- `auth` module: `upsert_user`, `start_session` / `end_session`,
  `resolve_user`, the `require_auth` extractor, `public_user` shape.
- Routes: `GET /api/health`, `GET /api/system/info`, `GET /api/frameworks`
  (frameworks list ported as a static Rust table — `@avail/frameworks` is
  small and has no build-executor dependency), `GET /api/auth/config`,
  `POST /api/auth/login`, `POST /api/auth/verify`, `POST /api/auth/logout`,
  `GET /api/auth/me`, `GET /api/auth/sessions`.
- Mailer: console-echo path only (the actual SMTP client in
  `apps/api/src/lib/mailer.ts` is a hand-rolled implementation of AUTH
  LOGIN/PLAIN over raw sockets; porting it is Phase 2 — most local dev
  never sets `SMTP_URL`, so this does not block using Phase 1 end-to-end).

**Phase 2 — done.**

- GitHub + Google OAuth (`lib/github.ts`, `lib/google.ts`) — outbound HTTP via
  `reqwest`, same endpoints and scopes. Ported as `src/github.rs` / `src/google.rs`.
- `routes/git.ts` (integrations list/connect/disconnect, repo listing) →
  `routes/git.rs`.
- `routes/projects.ts` (project CRUD, domains, webhook info/registration) —
  the largest file (557 lines); many sub-flows (framework auto-detect on
  create, webhook registration against the GitHub API) → `routes/projects.rs`.
- `routes/env.ts` (env var CRUD + reveal + bulk import) → `routes/env.rs`.
- `routes/deployments.ts` + `routes/webhooks.ts` (deployment CRUD, promote,
  cancel, delete, the two SSE endpoints, GitHub webhook intake) →
  `routes/deployments.rs` + `routes/webhooks.rs`, unblocked by the
  `apps/worker` extraction below.
- SMTP mailer port — **not done**, still the one Phase 1 gap (see Status).

**`apps/worker` extraction — done.** `apps/api/src/services/{queue.ts,poller.ts,logs.ts}`
and `lib/{bus.ts,github.ts}` were *copied* (not moved — `apps/api` stays
untouched and fully functional) into a new `apps/worker` app. The one real
code change: `queue.ts` gained a 1-second poll for `QUEUED` rows inserted by
any process, not just its own `enqueue()` calls, plus a check for a
`cancelRequested` flag on the deployment's `meta` JSON so `rust-api`'s
`cancel` endpoint has a way to reach a build running in a different process.
See the Status section for the real build this was proven against.

**Nice-to-have, not required for correctness (Phase 3).** A tiny internal
HTTP surface on `apps/worker` (`POST /enqueue`, `GET /status`) that
`rust-api` calls after inserting a `QUEUED` row and for `/api/system/status`,
so builds start immediately instead of on the next poll tick, and queue
status is live instead of DB-inferred. Superseded by Phase E below — once
`avail-worker` (Rust) is the running build process, `apps/worker` (Node) has
no further reason to gain features.

## Phase E — a pure-Rust builder: no Node process anywhere in the build path

**Done.** `apps/worker` (Node) still exists and still works, but it is no
longer the only way to build: `rust-api` gained a whole second binary,
`avail-worker`, that reimplements `apps/builder` and `packages/frameworks`
in Rust so a build can run with **zero Node process orchestrating it** —
the only Node.js involved is the *target project's own* toolchain running
inside the WSL sandbox (`npm install` / `next build`), exactly as it would
be on a real deployment target; nothing about Avail's own platform code is
Node anymore.

- `rust-api` was restructured from a single binary crate into a library
  (`avail_api`, `src/lib.rs`) plus two binaries that both depend on it:
  `avail-api` (`src/main.rs`, the HTTP API — unchanged behavior) and
  `avail-worker` (`src/bin/worker.rs`, new).
- `src/builder/` — a ground-up Rust port of `apps/builder/src/*.ts`:
  - `executor.rs` — spawns `wsl.exe`/`bash`, streams stdout/stderr,
    timeout + cross-process cancellation, `taskkill /t /f` on Windows.
  - `git.rs` — the same shell-script-based fetch (`git fetch --depth 1` +
    checkout) as `git.ts`'s `fetchSource`, including URL redaction in logs.
  - `detect.rs` — the framework-detection algorithm (`every`/`some`/
    `matchPackage`/`matchContent`/`supersedes`), reading the **same**
    `packages/frameworks/src/frameworks.json` Node reads — one source of
    truth, not a duplicated copy.
  - `settings.rs` — the project → `avail.json`/`vercel.json` → framework
    preset precedence merge, `avail.json`/`vercel.json` round-tripped
    losslessly (unknown fields kept via a flattened map) into the manifest.
  - `functions.rs` — serverless-function discovery under `api/`, same
    static-before-dynamic / catch-all-last sort as `functions.ts`.
  - `mod.rs` — orchestrates all of the above into one build: clone → resolve
    settings → install → build → discover functions → snapshot-publish
    (hard-link `cp -al`) → write `manifest.json`. Mirrors
    `apps/builder/src/index.ts`'s `runBuild` phase-for-phase.
- `src/bin/worker.rs` — `avail-worker`: the same polling loop as `apps/worker`
  (`deployments::queued()` every 1s, one build per project, a semaphore for
  global concurrency, the `cancelRequested`-in-`meta` cross-process cancel
  flag), calling `builder::run_build` directly in-process instead of
  shelling out to anything Node.
- **Real end-to-end integration test** (2026-09-11), `avail-api` +
  `avail-worker` running together, `apps/worker`/Node not started at all:
  1. `cargo check` / `cargo test` clean (12/12 tests) after the lib/bin split.
  2. Started `avail-api` (port 3011) and `avail-worker` from their built
     `target/debug` binaries.
  3. Signed in for real (email-code dev-echo flow) and called
     `POST /api/projects/prj_.../deploy` on `avail-api` for the local-path
     test project (`D:\Vercel_Test\autobot`) — inserted a `QUEUED` row.
  4. `avail-worker` picked it up off the database within 1s (no IPC) and ran
     an **actual WSL build**: `git fetch`/checkout, `npm install`, a real
     `next build` (Turbopack) — to `READY` in 18.4s.
  5. It was promoted to production and its aliases (`deployment`, `branch`,
     `production`) were reassigned correctly; the previous production
     deployment was correctly demoted (`is_current_production: 0`).
  6. `manifest.json` was written with the right shape (framework, serve
     mode, start command, env, node version) — same as Node's builder would
     produce.
- **Not yet done**: `apps/proxy` (routing/static/runtime-process management)
  is still pure Node — it isn't part of the *build* path this phase targeted,
  but it is part of the *running platform*, so "Node is not needed" is true
  of building a deployment, not yet of serving one. Porting it would be a
  separate, later phase; not started, not yet requested.
- `apps/worker` (Node) is not deleted — it still works and is still what
  `npm run dev -w @avail/worker` starts. It is superseded in the sense that
  `avail-worker` does the same job without Node, but removing it is a
  decision for the user to make, not assumed here.

## Testing & rollout

1. **Nothing existing changes in this phase.** `apps/api` is untouched;
   `npm run typecheck`, `npm test`, and `npm run dev` continue to exercise
   exactly the code they did before `rust-api/` existed. Verified after every
   step of this plan, not just at the end.
2. **Parity tests, not just "it compiles."** `rust-api`'s crypto module ships
   Rust-side round-trip tests, plus one test vector encrypted by the *actual*
   Node `encrypt()` (fixed secret, fixed purpose, fixed plaintext) that the
   Rust `decrypt()` must reproduce exactly — catching a scrypt-parameter or
   base64 alphabet mismatch immediately instead of at first real use.
3. **Run side-by-side, different port.** `rust-api` defaults to a port
   distinct from the Node API (`RUST_API_PORT`, default `3011`) so it can be
   started and hit with `curl`/integration tests without touching the port
   the dashboard is configured to talk to. It reads the *same* `.env` and the
   *same* `AVAIL_DB_FILE`, so it is exercising real data, not a fixture.
4. **Cutover is a separate, later decision** — swap `scripts/dev.mjs`'s `api`
   entry from the Node process to the Rust binary (and `apps/worker` for the
   builder side) only once Phase 2 is complete and the dashboard has been
   smoke-tested end-to-end against `rust-api` on its real port. Until then
   both exist; the Node one is what actually serves the running app.

## Build note: which toolchain

This host has no MSVC linker (`link.exe`) installed — only the MSVC Rust
target was, which needs one. `rustup` already has `stable-x86_64-pc-windows-gnu`
installed too, which links with MinGW instead and works out of the box.
Until/unless VS Build Tools get installed, build and run with:

```bash
cd rust-api
rustup run stable-x86_64-pc-windows-gnu cargo test
rustup run stable-x86_64-pc-windows-gnu cargo run   # RUST_API_PORT=3011 by default
```

(`cargo check`/`build`/`run` all work the same way — prefix with `rustup run
stable-x86_64-pc-windows-gnu`, or `rustup override set stable-x86_64-pc-windows-gnu`
once from inside `rust-api/` to stop needing the prefix.) This is a local
toolchain fact, not a code dependency — nothing in `rust-api/` assumes GNU
specifically, and it will build with the MSVC target too once a linker is
available for it.

## `isBuilding` is intentionally not identical to Node's

`GET /api/deployments/:id`'s `isBuilding` used to mean "this process has a
live `AbortController` for it" (`queue.isRunning()`) — meaningless now that
building happens in a different process. `rust-api` reports
`!TERMINAL_STATES.includes(state)` instead — true for `QUEUED` too, not just
while a build is actively running. That is arguably more useful to the
dashboard (a spinner while queued, not just while building) and is the only
thing knowable from the database alone without polling `apps/worker`, which
Phase 3's optional status endpoint would fix if the distinction ever matters.

## Status

- [x] Plan (this document)
- [x] `rust-api` scaffold, `config`/`crypto`/`ids` modules + parity tests —
      `cargo test`: 10/10 passing, including a decrypt cross-check against a
      payload produced by the *real* Node `encrypt()`
- [x] `db` module (all 13 tables, matching `packages/db/src/index.ts` function
      for function)
- [x] `auth` module
- [x] Auth routes — email-code flow **and** GitHub/Google OAuth (`src/github.rs`,
      `src/google.rs`, `reqwest`-based, same scopes/endpoints/claim checks as
      the Node originals)
- [x] `routes/git.rs`, `routes/env.rs`, `routes/projects.rs`, `routes/deployments.rs`,
      `routes/webhooks.rs` — the full HTTP surface of `apps/api` is now ported,
      including both SSE endpoints (DB-polling, see above) and the GitHub
      webhook intake (raw-body HMAC verification, push/pull_request handling)
- [x] `apps/worker` — a new, independent Node app holding what used to be
      `apps/api/src/services/{queue,poller,logs}.ts` plus `lib/{bus,github}.ts`
      (copied, not moved — `apps/api` is untouched), with two additions to
      `queue.ts`: a 1s poll for `QUEUED` rows inserted by *any* process (not
      just this one's own `enqueue()`), and a `cancelRequested` flag in
      `meta` JSON that a build's `AbortController` is checked against, since
      `rust-api`'s `cancel` endpoint can no longer reach into this process's
      memory directly. Not started by `npm run dev` — opt-in via
      `npm run dev -w @avail/worker`, specifically so it can never run
      alongside the Node API's *own* in-process queue and double-build the
      same `QUEUED` row.
- [x] **Real end-to-end integration test**, `rust-api` + `apps/worker` running
      together against the live `~/.avail-deploy/avail.db`, Node API not
      involved at all:
      1. Signed in for real (email-code flow, rate limiter confirmed working
         by tripping it).
      2. `POST /api/projects/autobot2/deploy` on `rust-api` — created a
         `QUEUED` deployment, having first fetched the real commit off GitHub
         through the project's stored (decrypted) token.
      3. `apps/worker`, a wholly separate process, picked the row up off the
         database with no IPC and ran an **actual WSL build** — real `git
         clone`, `npm install`, `next build` — to completion (`build_duration_ms:
         29486`).
      4. It landed `READY`, got promoted to production, and its aliases were
         reassigned — all via the copied, unmodified `assignAliases`/`promote`
         logic.
      5. `rust-api`'s `GET /api/projects/autobot2` and `GET /api/deployments/:id`
         reflected all of it correctly (`productionDeployment` pointing at the
         new build, `isCurrentProduction: true`, updated domain list).
      6. Env var CRUD exercised too: added one through `rust-api`
         (AES-256-GCM encrypted), listed it masked, revealed it decrypted
         correctly, deleted it.
- [x] Confirmed nothing existing broke: `npm run typecheck` clean (now also
      covering `apps/worker/src`), `npm test` 40/40, `git status` shows zero
      changes under `apps/api`, `apps/proxy`, `apps/builder`, `apps/dashboard`,
      or `packages/` — `apps/worker` is a brand-new workspace app (so
      `package-lock.json` and root `tsconfig.json`'s `include` list changed,
      additively, to wire it in) and `rust-api/` stays outside the npm
      workspace entirely
- [ ] SMTP mailer port (console-echo path still used unconditionally; low
      priority — most local dev never sets `SMTP_URL`)
- [ ] Phase 3 nice-to-have: a status endpoint for live queue/poller info
      instead of the DB-inferred approximation `rust-api` uses today
      (applies equally to `apps/worker` and `avail-worker`)
- [x] **Phase E — `avail-worker`, a pure-Rust builder.** `src/builder/`
      (executor/git/detect/settings/functions/mod) ports all of
      `apps/builder` + `packages/frameworks`'s detection algorithm to Rust;
      `src/bin/worker.rs` replaces `apps/worker`'s polling loop. Verified
      with a real WSL `next build` end-to-end (see Phase E section above) —
      no Node process involved in orchestrating it. `rust-api` restructured
      into `avail_api` (lib) + `avail-api`/`avail-worker` (bins) to share
      code between the two binaries.
- [ ] `apps/proxy` port — not started. Needed for "no Node anywhere in the
      running platform"; not needed for "no Node in the build path" (done).
- [ ] Cutover (swap `scripts/dev.mjs` to the Rust API + a Rust worker) — not
      done; the Node API and Node `apps/worker` are still what actually
      serve/build the running app day to day. `avail-api`/`avail-worker`
      are proven correct but must be started manually to use them.
