//! Mirrors `apps/api/src/routes/auth.ts`. The email-code sign-in path and
//! GitHub/Google OAuth are both fully ported; the SMTP client in
//! `mailer.ts` is not (mail always takes the console-echo path, which is
//! what local dev uses today anyway since `SMTP_URL` is rarely set) — see
//! `docs/rust-api-migration-plan.md`.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::CookieJar;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{end_session, public_user, resolve_user, start_session, upsert_user, AuthUser};
use crate::config::{is_email_allowed, normalize_email};
use crate::crypto::{generate_login_code, safe_equal};
use crate::db::{integrations, login_codes, now_ms};
use crate::error::{AppError, AppResult};
use crate::ids::{id, new_integration_id};
use crate::logger;
use crate::state::SharedState;
use crate::{github, google};

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/auth/config", get(auth_config))
        .route("/api/auth/login", post(login))
        .route("/api/auth/verify", post(verify))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .route("/api/auth/sessions", get(sessions))
        .route("/api/auth/github/start", get(github_start))
        .route("/api/auth/github/callback", get(github_callback))
        .route("/api/auth/google/start", get(google_start))
        .route("/api/auth/google/callback", get(google_callback))
}

/// Public: what sign-in methods this install supports.
async fn auth_config(State(state): State<SharedState>) -> Json<Value> {
    let c = &state.config;
    Json(json!({
        "allowedDomains": c.allowed_email_domains,
        "emailSignIn": true,
        "githubSignIn": c.github.client_id.is_some() && c.github.client_secret.is_some(),
        "googleSignIn": google::configured(c),
        "devEcho": c.auth_dev_echo,
        "mailDelivery": "console",
    }))
}

#[derive(Deserialize)]
struct LoginBody {
    email: Option<String>,
    intent: Option<String>,
}

/// Simple in-memory throttle for code requests, keyed by email — mirrors
/// `routes/auth.ts`'s module-level `requestTimes` map.
fn throttle_table() -> &'static Mutex<HashMap<String, Vec<i64>>> {
    static TABLE: std::sync::OnceLock<Mutex<HashMap<String, Vec<i64>>>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

const MAX_REQUESTS_PER_WINDOW: usize = 5;
const WINDOW_MS: i64 = 10 * 60 * 1000;

fn throttle(email: &str) -> AppResult<()> {
    let now = now_ms();
    let mut table = throttle_table().lock().unwrap();
    let entry = table.entry(email.to_string()).or_default();
    entry.retain(|t| now - t < WINDOW_MS);
    if entry.len() >= MAX_REQUESTS_PER_WINDOW {
        return Err(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many sign-in attempts. Try again later.",
        ));
    }
    entry.push(now);
    Ok(())
}

/// Step 1 — request a one-time code. `intent` only decides which message
/// the caller gets when the account does or does not already exist; both
/// paths issue the same code (see the long comment in `routes/auth.ts`).
async fn login(State(state): State<SharedState>, Json(body): Json<LoginBody>) -> AppResult<Json<Value>> {
    let email = normalize_email(body.email.as_deref().unwrap_or(""));
    let intent = if body.intent.as_deref() == Some("signup") { "signup" } else { "login" };

    if email.is_empty() || !email.contains('@') {
        return Err(AppError::bad_request("invalid_email", "A valid email address is required"));
    }
    if !is_email_allowed(&state.config, &email) {
        let domains = state.config.allowed_email_domains.iter().map(|d| format!("@{d}")).collect::<Vec<_>>().join(" and ");
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "domain_not_allowed",
            format!("Sign-in is restricted to {domains} addresses"),
        ));
    }

    let existing = {
        let conn = state.db.lock();
        crate::db::users::by_email(&conn, &email)?
    };
    if intent == "login" && existing.is_none() {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "account_not_found",
            format!("No account yet for {email}. Switch to Sign up to create one."),
        ));
    }
    if intent == "signup" && existing.is_some() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "account_exists",
            format!("{email} already has an account. Switch to Log in."),
        ));
    }

    throttle(&email)?;

    let code = generate_login_code();
    {
        let conn = state.db.lock();
        login_codes::create(&conn, &id("code", 20), &email, &state.crypto.hash_code(&code), now_ms() + state.config.login_code_ttl_ms)?;
    }

    let log = logger::scoped("mail");
    let subject = format!("{code} is your Avail Deploy sign-in code");
    log.info(format!("[mail:console] to={email} subject={subject}"));
    let minutes = state.config.login_code_ttl_ms / 60_000;
    for line in [
        format!("Your Avail Deploy sign-in code is: {code}"),
        String::new(),
        format!("It expires in {minutes} minutes."),
        "If you did not request this, you can ignore this email.".to_string(),
    ] {
        log.info(format!("  {line}"));
    }
    let delivered = false; // SMTP client is Phase 2 — see module doc comment.

    Ok(Json(json!({
        "ok": true,
        "email": email,
        "intent": intent,
        "delivered": delivered,
        "expiresInMs": state.config.login_code_ttl_ms,
        "code": if !delivered && state.config.auth_dev_echo { Some(code) } else { None },
    })))
}

#[derive(Deserialize)]
struct VerifyBody {
    email: Option<String>,
    code: Option<String>,
    client: Option<String>,
}

/// Step 2 — exchange the code for a session.
async fn verify(
    State(state): State<SharedState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<VerifyBody>,
) -> AppResult<(CookieJar, Json<Value>)> {
    let email = normalize_email(body.email.as_deref().unwrap_or(""));
    let code = body.code.as_deref().unwrap_or("").trim().to_string();
    if email.is_empty() || code.is_empty() {
        return Err(AppError::bad_request("invalid_request", "Email and code are required"));
    }

    let record = {
        let conn = state.db.lock();
        login_codes::latest_for_email(&conn, &email)?
    };
    let Some(record) = record else {
        return Err(AppError::bad_request("code_not_found", "Request a new sign-in code"));
    };
    if record.expires_at < now_ms() {
        return Err(AppError::bad_request("code_expired", "That code has expired"));
    }
    if record.attempts >= 5 {
        return Err(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
            "Too many attempts — request a new code",
        ));
    }
    if !safe_equal(&record.code_hash, &state.crypto.hash_code(&code)) {
        let conn = state.db.lock();
        login_codes::bump_attempts(&conn, &record.id)?;
        return Err(AppError::bad_request("invalid_code", "That code is not correct"));
    }

    {
        let conn = state.db.lock();
        login_codes::consume(&conn, &record.id)?;
    }
    let user = upsert_user(&state, &email, None, None)?;
    let user_agent = headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok());
    let (jar, session_id) = start_session(&state, jar, &user, user_agent)?;
    logger::scoped("auth").info(format!("{} signed in", user.email));

    // The CLI has no cookie jar, so it receives the bearer token directly.
    let token = if body.client.as_deref() == Some("cli") {
        Some(state.crypto.sign_token(&session_id))
    } else {
        None
    };

    Ok((jar, Json(json!({ "user": public_user(&user), "token": token }))))
}

async fn logout(State(state): State<SharedState>, jar: CookieJar) -> (CookieJar, Json<Value>) {
    let jar = end_session(&state, jar);
    (jar, Json(json!({ "ok": true })))
}

async fn me(State(state): State<SharedState>, headers: HeaderMap, jar: CookieJar) -> AppResult<Json<Value>> {
    let Some((user, _session_id)) = resolve_user(&state, &headers, &jar) else {
        return Err(AppError::unauthorized("Not signed in"));
    };
    let conn = state.db.lock();
    let list = integrations::for_user(&conn, &user.id)?
        .into_iter()
        .map(|i| {
            json!({
                "id": i.id,
                "provider": i.provider,
                "kind": i.kind,
                "login": i.login,
                "avatarUrl": i.avatar_url,
                "createdAt": i.created_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "user": public_user(&user), "integrations": list })))
}

async fn sessions(user: AuthUser) -> Json<Value> {
    Json(json!({ "sessions": Value::Array(vec![]), "currentSessionId": user.session_id }))
}

/// Short-lived signed state shared by every OAuth round trip.
fn oauth_state(state: &SharedState, intent: &str) -> String {
    let nonce = format!("{intent}:{}", now_ms());
    format!("{}.{}", URL_SAFE_NO_PAD.encode(&nonce), state.crypto.hmac(&nonce, "oauth"))
}

fn verify_oauth_state(state: &SharedState, raw: &str) -> Option<String> {
    let (payload, signature) = raw.split_once('.')?;
    let nonce_bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let nonce = String::from_utf8(nonce_bytes).ok()?;
    if !safe_equal(&state.crypto.hmac(&nonce, "oauth"), signature) {
        return None;
    }
    let (intent, issued_at) = nonce.split_once(':')?;
    let issued_at: i64 = issued_at.parse().ok()?;
    if now_ms() - issued_at > 10 * 60 * 1000 {
        return None;
    }
    Some(intent.to_string())
}

fn login_fail(state: &SharedState, message: &str) -> Redirect {
    Redirect::to(&format!("{}/login?error={}", state.config.dashboard_url, urlencoding::encode(message)))
}

#[derive(Deserialize)]
struct GithubStartQuery {
    intent: Option<String>,
}

/// `intent=signin` signs the user in (subject to the domain allow-list),
/// `intent=connect` attaches the GitHub account to the signed-in user.
async fn github_start(State(state): State<SharedState>, Query(q): Query<GithubStartQuery>) -> Response {
    if state.config.github.client_id.is_none() {
        return AppError::new(StatusCode::BAD_REQUEST, "oauth_unavailable", "GitHub OAuth is not configured").into_response();
    }
    let intent = if q.intent.as_deref() == Some("connect") { "connect" } else { "signin" };
    let redirect_uri = format!("{}/api/auth/github/callback", state.config.api_url);
    Redirect::to(&github::oauth_authorize_url(&state.config.github, &redirect_uri, &oauth_state(&state, intent))).into_response()
}

#[derive(Deserialize)]
struct OauthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

async fn github_callback(State(state): State<SharedState>, jar: CookieJar, headers: HeaderMap, Query(q): Query<OauthCallbackQuery>) -> Response {
    let redirect_uri = format!("{}/api/auth/github/callback", state.config.api_url);

    let (Some(code), Some(raw_state)) = (&q.code, &q.state) else {
        return login_fail(&state, "Missing OAuth response").into_response();
    };
    let Some(intent) = verify_oauth_state(&state, raw_state) else {
        return login_fail(&state, "OAuth state expired — try again").into_response();
    };

    let token = match github::exchange_oauth_code(&state.config.github, code, &redirect_uri).await {
        Ok(t) => t,
        Err(err) => return login_fail(&state, &err.message).into_response(),
    };
    let Ok(profile) = github::user(&state.config.github.api_url, &token).await else {
        return login_fail(&state, "Could not read the GitHub profile").into_response();
    };
    let email = match &profile.email {
        Some(e) => Some(e.clone()),
        None => github::primary_email(&state.config.github.api_url, &token).await,
    };

    if intent == "signin" {
        let Some(email) = email else {
            return login_fail(&state, "Your GitHub account has no verified email address").into_response();
        };
        if !is_email_allowed(&state.config, &email) {
            return login_fail(&state, &format!("{email} is not an @{} address", state.config.allowed_email_domains.first().cloned().unwrap_or_default())).into_response();
        }
        let user = match upsert_user(&state, &email, profile.name.as_deref(), Some(&profile.avatar_url)) {
            Ok(u) => u,
            Err(err) => return login_fail(&state, &err.message).into_response(),
        };
        let (jar, _) = match start_session(&state, jar, &user, headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok())) {
            Ok(v) => v,
            Err(err) => return login_fail(&state, &err.message).into_response(),
        };
        save_integration(&state, &user.id, &profile, &token);
        logger::scoped("auth").info(format!("{} signed in via GitHub", user.email));
        return (jar, Redirect::to(&format!("{}/", state.config.dashboard_url))).into_response();
    }

    let Some((user, _)) = resolve_user(&state, &headers, &jar) else {
        return login_fail(&state, "Sign in before connecting GitHub").into_response();
    };
    save_integration(&state, &user.id, &profile, &token);
    Redirect::to(&format!("{}/settings/git?connected=1", state.config.dashboard_url)).into_response()
}

fn save_integration(state: &SharedState, user_id: &str, profile: &github::GhUser, token: &str) {
    let conn = state.db.lock();
    if let Ok(existing) = integrations::for_user(&conn, user_id) {
        if let Some(dup) = existing.into_iter().find(|i| i.provider == "github" && i.login == profile.login) {
            let _ = integrations::delete(&conn, &dup.id);
        }
    }
    let _ = integrations::create(
        &conn,
        integrations::NewIntegration {
            id: &new_integration_id(),
            user_id,
            provider: "github",
            kind: "oauth",
            login: &profile.login,
            avatar_url: Some(&profile.avatar_url),
            token_enc: &state.crypto.encrypt(token, "git-token"),
            scopes: Some("repo,admin:repo_hook"),
            created_at: now_ms(),
        },
    );
}

/// Google is identity only — it grants no repository access.
async fn google_start(State(state): State<SharedState>) -> Response {
    if !google::configured(&state.config) {
        return AppError::new(StatusCode::BAD_REQUEST, "oauth_unavailable", "Google sign-in is not configured").into_response();
    }
    let redirect_uri = format!("{}/api/auth/google/callback", state.config.api_url);
    Redirect::to(&google::authorize_url(&state.config, &redirect_uri, &oauth_state(&state, "signin"))).into_response()
}

#[derive(Deserialize)]
struct GoogleCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn google_callback(State(state): State<SharedState>, jar: CookieJar, headers: HeaderMap, Query(q): Query<GoogleCallbackQuery>) -> Response {
    if let Some(error) = &q.error {
        return login_fail(&state, &format!("Google sign-in was cancelled ({error})")).into_response();
    }
    let (Some(code), Some(raw_state)) = (&q.code, &q.state) else {
        return login_fail(&state, "Missing OAuth response").into_response();
    };
    if verify_oauth_state(&state, raw_state).is_none() {
        return login_fail(&state, "OAuth state expired — try again").into_response();
    }

    let redirect_uri = format!("{}/api/auth/google/callback", state.config.api_url);
    let identity = match google::exchange_code(&state.config, code, &redirect_uri).await {
        Ok(i) => i,
        Err(err) => return login_fail(&state, &err.0).into_response(),
    };

    if !is_email_allowed(&state.config, &identity.email) {
        let domains = state.config.allowed_email_domains.iter().map(|d| format!("an @{d}")).collect::<Vec<_>>().join(" or ");
        return login_fail(&state, &format!("{} is not {domains} address", identity.email)).into_response();
    }

    let user = match upsert_user(&state, &identity.email, identity.name.as_deref(), identity.picture.as_deref()) {
        Ok(u) => u,
        Err(err) => return login_fail(&state, &err.message).into_response(),
    };
    let (jar, _) = match start_session(&state, jar, &user, headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok())) {
        Ok(v) => v,
        Err(err) => return login_fail(&state, &err.message).into_response(),
    };
    logger::scoped("auth").info(format!("{} signed in via Google", user.email));
    (jar, Redirect::to(&format!("{}/", state.config.dashboard_url))).into_response()
}
