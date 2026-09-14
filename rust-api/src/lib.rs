//! Shared library: everything both `avail-api` (`src/main.rs`) and
//! `avail-worker` (`src/bin/worker.rs`) depend on. The two binaries are
//! kept separate on purpose — see docs/rust-api-migration-plan.md — but
//! they share the same database/config/crypto layer, so it lives once here
//! rather than being duplicated per binary.

pub mod auth;
pub mod builder;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod frameworks;
pub mod github;
pub mod google;
pub mod ids;
pub mod logger;
pub mod routes;
pub mod services;
pub mod state;
