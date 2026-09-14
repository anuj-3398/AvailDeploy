//! Thin entry point — every module lives in `src/lib.rs` (as `avail_api`)
//! so `src/bin/worker.rs` can share the same config/db/crypto layer without
//! duplicating it. See docs/rust-api-migration-plan.md.

use std::sync::Arc;

use axum::http::{header, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

use avail_api::state::{self, AppState};
use avail_api::{config, crypto, db, logger, routes};

#[tokio::main]
async fn main() {
    let log = logger::scoped("api");
    let cfg = config::load();

    let db = db::Db::open(&cfg.db_file).expect("open sqlite database");

    // Bound separately from `config.api_port` (which mirrors the Node API's
    // port for URL composition) so this can run side by side with the real
    // Node API during Phase 1/2 — see docs/rust-api-migration-plan.md.
    let bind_port: u16 = std::env::var("RUST_API_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3011);

    let dashboard_url = cfg.dashboard_url.clone();
    let api_url = cfg.api_url.clone();
    let dashboard_port = cfg.dashboard_port;
    let allowed_origins = vec![
        dashboard_url,
        api_url,
        format!("http://localhost:{dashboard_port}"),
        format!("http://127.0.0.1:{dashboard_port}"),
    ];

    let cors = CorsLayer::new()
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::PUT, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin
                .to_str()
                .map(|o| allowed_origins.iter().any(|a| a == o))
                .unwrap_or(false)
        }));

    let state: state::SharedState = Arc::new(AppState { db, crypto: crypto::Crypto::new(cfg.secret.clone()), config: cfg });

    let app = axum::Router::new()
        .merge(routes::system::router())
        .merge(routes::auth::router())
        .merge(routes::git::router())
        .merge(routes::env::router())
        .merge(routes::projects::router())
        .merge(routes::notifications::router())
        .merge(routes::deployments::router())
        .merge(routes::webhooks::router())
        .layer(cors)
        .with_state(state.clone());

    let addr = format!("{}:{}", state.config.host, bind_port);
    log.info(format!("API listening on http://{addr}"));
    log.info(format!(
        "Sign-in restricted to: {}",
        state.config.allowed_email_domains.iter().map(|d| format!("@{d}")).collect::<Vec<_>>().join(", ")
    ));
    log.info(format!("Database: {}", state.config.db_file.display()));
    log.info(
        "Deployments queue as rows; avail-worker (this crate's other binary) owns actually \
         building them — see docs/rust-api-migration-plan.md.",
    );

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind listener");
    axum::serve(listener, app).await.expect("serve");
}
