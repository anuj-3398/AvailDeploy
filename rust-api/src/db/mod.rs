//! Mirrors `packages/db/src/index.ts`. Same schema (see `schema.rs`), same
//! table-scoped query modules, same function names translated to snake_case
//! (`users.byId` -> `users::by_id`) so the two are easy to compare side by
//! side while both exist.

mod schema;
pub mod types;

pub mod aliases;
pub mod build_logs;
pub mod comments;
pub mod deployments;
pub mod env_vars;
pub mod events;
pub mod integrations;
pub mod login_codes;
pub mod notifications;
pub mod projects;
pub mod repo_watch;
pub mod request_logs;
pub mod sessions;
pub mod transfers;
pub mod users;
pub mod webhook_deliveries;

use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// Epoch milliseconds — the same unit every `created_at`/`updated_at`/etc
/// column stores, matching JS's `Date.now()`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after 1970")
        .as_millis() as i64
}

/// A SQLite connection shared across the process. `rusqlite::Connection` is
/// `!Sync`, and `node:sqlite`'s `DatabaseSync` is synchronous and
/// single-threaded from JS's point of view anyway — a mutex around one
/// connection matches that access pattern. WAL mode (set in `schema.rs`) is
/// what makes *other processes* (the Node API today, the future worker, the
/// proxy) safe to read/write the same file concurrently.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        // Set before anything else: SCHEMA's own `PRAGMA busy_timeout` is
        // three statements into that batch, so without this, the first two
        // (switching to WAL, enabling foreign keys — both need a moment's
        // lock) run with SQLite's default zero-wait busy handler. Multiple
        // processes (avail-api, avail-worker, apps/proxy) can all open this
        // same file within the same instant at boot, and one loses that
        // race with an immediate "database is locked" instead of a brief
        // wait — this closes that window before SCHEMA ever runs.
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        conn.execute_batch(schema::SCHEMA)?;
        for migration in schema::MIGRATIONS {
            if let Err(err) = conn.execute_batch(migration) {
                let msg = err.to_string().to_lowercase();
                if !msg.contains("duplicate column") && !msg.contains("already exists") {
                    return Err(err);
                }
            }
        }
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().expect("db mutex poisoned")
    }
}
