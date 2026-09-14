use std::sync::Arc;

use crate::config::Config;
use crate::crypto::Crypto;
use crate::db::Db;

pub struct AppState {
    pub db: Db,
    pub crypto: Crypto,
    pub config: Config,
}

pub type SharedState = Arc<AppState>;
