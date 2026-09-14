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
use axum::routing::{delete as delete_method, get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::CookieJar;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{end_session, public_user, resolve_user, start_session, upsert_user, AuthUser};
use crate::config::{is_email_allowed, normalize_email};
use crate::crypto::{generate_login_code, hash_password, safe_equal, verify_password};
use crate::db::{integrations, login_codes, now_ms, projects, users};
use crate::error::{AppError, AppResult};
use crate::ids::{id, new_integration_id};
use crate::logger;
use crate::state::SharedState;
use crate::{github, google};

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/auth/config", get(auth_config))
        .route("/api/auth/login", post(login))
        .route("/api/auth/login/password", post(login_with_password))
        .route("/api/auth/verify", post(verify))
        .route("/api/auth/password", post(set_password))
        .route("/api/auth/password/reset/verify", post(reset_password_verify))
        .route("/api/auth/password/reset/confirm", post(reset_password_confirm))
        .route("/api/auth/account", delete_method(delete_account))
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
    /// "Forgot my password" escape hatch — an account with a password set
    /// normally skips the emailed code entirely (see below), but this
    /// forces one anyway so a lost password doesn't lock the account out.
    #[serde(rename = "forceCode")]
    force_code: Option<bool>,
}

/// Simple in-memory throttle for code requests, keyed by email — mirrors
/// `routes/auth.ts`'s module-level `requestTimes` map.
fn throttle_table() -> &'static Mutex<HashMap<String, Vec<i64>>> {
    static TABLE: std::sync::OnceLock<Mutex<HashMap<String, Vec<i64>>>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

const MAX_REQUESTS_PER_WINDOW: usize = 5;
const WINDOW_MS: i64 = 10 * 60 * 1000;

const MIN_PASSWORD_LEN: usize = 8;

/// Standard complexity rule: at least 8 characters, one uppercase letter,
/// one lowercase letter, and one special (non-alphanumeric) character.
/// Mirrored client-side in `apps/dashboard/src/validation.ts` for instant
/// feedback — this is the real gate, that copy is just UX.
fn validate_password(password: &str) -> AppResult<()> {
    let weak = |message: &str| Err(AppError::bad_request("weak_password", message));
    if password.chars().count() < MIN_PASSWORD_LEN {
        return weak(&format!("Password must be at least {MIN_PASSWORD_LEN} characters"));
    }
    if !password.chars().any(|c| c.is_ascii_uppercase()) {
        return weak("Password must include at least one uppercase letter");
    }
    if !password.chars().any(|c| c.is_ascii_lowercase()) {
        return weak("Password must include at least one lowercase letter");
    }
    if !password.chars().any(|c| !c.is_ascii_alphanumeric()) {
        return weak("Password must include at least one special character");
    }
    Ok(())
}

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

    // A password-holding account signs in with that instead — no code to
    // request or wait on, so skip straight to the password step.
    if let Some(user) = &existing {
        if intent == "login" && user.password_hash.is_some() && !body.force_code.unwrap_or(false) {
            return Ok(Json(json!({
                "ok": true,
                "email": email,
                "intent": intent,
                "method": "password",
                "delivered": false,
                "expiresInMs": Value::Null,
                "code": Value::Null,
            })));
        }
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
        "method": "code",
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
    /// Optional — set a password in the same step as verifying the code
    /// (signup's "create a password" field), so the account can sign in
    /// with it next time instead of requesting a new code. Ignored if the
    /// account already has a password — resetting a *forgotten* one is a
    /// separate, dedicated flow (`/api/auth/password/reset/*` below), not
    /// this endpoint.
    password: Option<String>,
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
    let mut user = upsert_user(&state, &email, None, None)?;

    if let Some(password) = body.password.as_deref().filter(|p| !p.is_empty()) {
        if user.password_hash.is_none() {
            validate_password(password)?;
            let hash = hash_password(password);
            {
                let conn = state.db.lock();
                users::set_password(&conn, &user.id, Some(&hash))?;
            }
            user.password_hash = Some(hash);
        }
    }

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

#[derive(Deserialize)]
struct PasswordLoginBody {
    email: Option<String>,
    password: Option<String>,
    client: Option<String>,
}

/// Alternative to the `login` + `verify` pair, for accounts that have set a
/// password — no code involved at all. Shares `login`'s per-email throttle
/// so this can't be used to brute-force a password any faster than a code.
async fn login_with_password(
    State(state): State<SharedState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<PasswordLoginBody>,
) -> AppResult<(CookieJar, Json<Value>)> {
    let email = normalize_email(body.email.as_deref().unwrap_or(""));
    let password = body.password.as_deref().unwrap_or("");
    if email.is_empty() || password.is_empty() {
        return Err(AppError::bad_request("invalid_request", "Email and password are required"));
    }

    throttle(&email)?;

    // Same message whether the account doesn't exist or the password is
    // wrong — telling them apart would let this endpoint be used to find
    // out which addresses have accounts.
    let invalid = || AppError::bad_request("invalid_credentials", "Incorrect email or password");
    let user = { let conn = state.db.lock(); users::by_email(&conn, &email)? };
    let user = user.ok_or_else(invalid)?;
    let hash = user.password_hash.as_deref().ok_or_else(invalid)?;
    if !verify_password(password, hash) {
        return Err(invalid());
    }

    let user = {
        let conn = state.db.lock();
        users::touch_login(&conn, &user.id)?;
        users::by_id(&conn, &user.id)?.expect("just touched")
    };
    let user_agent = headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok());
    let (jar, session_id) = start_session(&state, jar, &user, user_agent)?;
    logger::scoped("auth").info(format!("{} signed in with a password", user.email));

    let token = if body.client.as_deref() == Some("cli") {
        Some(state.crypto.sign_token(&session_id))
    } else {
        None
    };

    Ok((jar, Json(json!({ "user": public_user(&user), "token": token }))))
}

#[derive(Deserialize)]
struct SetPasswordBody {
    #[serde(rename = "currentPassword")]
    current_password: Option<String>,
    #[serde(rename = "newPassword")]
    new_password: Option<String>,
}

/// Settings → set or change the signed-in user's password. Requires the
/// current password only if one is already set — an account that has never
/// had one (signed up via code or OAuth) can add one with no extra proof,
/// same as any other "add a sign-in method" action while already
/// authenticated.
async fn set_password(user: AuthUser, State(state): State<SharedState>, Json(body): Json<SetPasswordBody>) -> AppResult<Json<Value>> {
    let new_password = body.new_password.as_deref().unwrap_or("");
    validate_password(new_password)?;

    let conn = state.db.lock();
    let current = users::by_id(&conn, &user.user.id)?.ok_or_else(|| AppError::unauthorized("Not signed in"))?;
    if let Some(existing_hash) = &current.password_hash {
        let supplied = body.current_password.as_deref().unwrap_or("");
        if !verify_password(supplied, existing_hash) {
            return Err(AppError::bad_request("invalid_password", "Current password is not correct"));
        }
    }

    let hash = hash_password(new_password);
    users::set_password(&conn, &user.user.id, Some(&hash))?;
    drop(conn);

    logger::scoped("auth").info(format!(
        "{} {} their password",
        current.email,
        if current.password_hash.is_some() { "changed" } else { "set" }
    ));
    Ok(Json(json!({ "ok": true })))
}

/// Short-lived signed proof that a password-reset code was just verified
/// for this email — same idea as `oauth_state`, just bridging the gap
/// between "the code checked out" and "here's the new password" now that
/// those are two separate screens instead of one combined step. Stateless
/// (HMAC-signed, not a DB row) and single-purpose: the `"password-reset"`
/// derived key isn't used for anything else, so this token is worthless
/// for any other endpoint even if intercepted.
fn password_reset_token(state: &SharedState, email: &str) -> String {
    password_reset_token_raw(&state.crypto, email, now_ms())
}

/// Pure counterpart to `password_reset_token`, taking `issued_at` explicitly
/// instead of always stamping "now" — lets tests mint a token that's
/// already however old they need, without waiting on the wall clock.
fn password_reset_token_raw(crypto: &crate::crypto::Crypto, email: &str, issued_at: i64) -> String {
    let nonce = format!("{email}:{issued_at}");
    format!("{}.{}", URL_SAFE_NO_PAD.encode(&nonce), crypto.hmac(&nonce, "password-reset"))
}

fn verify_password_reset_token(state: &SharedState, raw: &str, email: &str) -> bool {
    verify_password_reset_token_at(&state.crypto, raw, email, now_ms())
}

/// The actual check, parameterized on "now" so the 5-minute boundary can be
/// pinned exactly in tests without waiting on the wall clock or standing up
/// a full `SharedState` (db + config) just to reach `state.crypto`.
fn verify_password_reset_token_at(crypto: &crate::crypto::Crypto, raw: &str, email: &str, now: i64) -> bool {
    let Some((payload, signature)) = raw.split_once('.') else { return false };
    let Ok(nonce_bytes) = URL_SAFE_NO_PAD.decode(payload) else { return false };
    let Ok(nonce) = String::from_utf8(nonce_bytes) else { return false };
    if !safe_equal(&crypto.hmac(&nonce, "password-reset"), signature) {
        return false;
    }
    let Some((nonce_email, issued_at)) = nonce.split_once(':') else { return false };
    let Ok(issued_at) = issued_at.parse::<i64>() else { return false };
    // Shorter than the OAuth state window (10 min) on purpose: this token
    // is stateless and not single-use (nothing marks it spent after a
    // successful reset), so a shorter window is the cheapest way to shrink
    // how long a leaked token — browser history, a shared machine, a proxy
    // log — would stay valid to replay.
    nonce_email == email && now - issued_at <= 5 * 60 * 1000
}

#[derive(Deserialize)]
struct ResetPasswordVerifyBody {
    email: Option<String>,
    code: Option<String>,
}

/// Forgot-password step 2 of 3: checks the emailed code (requested via the
/// ordinary `/api/auth/login` with `forceCode`, same as any other code) and
/// hands back a short-lived token proving that — but does **not** start a
/// session or touch the password yet. Deliberately separate from `verify`:
/// this flow ends by dropping the user back at the sign-in screen to log in
/// fresh with their new password, not by signing them in here.
async fn reset_password_verify(State(state): State<SharedState>, Json(body): Json<ResetPasswordVerifyBody>) -> AppResult<Json<Value>> {
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
        return Err(AppError::bad_request("code_not_found", "Request a new code"));
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

    let conn = state.db.lock();
    login_codes::consume(&conn, &record.id)?;
    // Forgetting a password only makes sense for an account that has one —
    // this flow never creates an account (signup already owns that).
    if users::by_email(&conn, &email)?.is_none() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "account_not_found", "No account for that email"));
    }

    Ok(Json(json!({ "ok": true, "token": password_reset_token(&state, &email) })))
}

#[derive(Deserialize)]
struct ResetPasswordConfirmBody {
    email: Option<String>,
    token: Option<String>,
    #[serde(rename = "newPassword")]
    new_password: Option<String>,
}

/// Forgot-password step 3 of 3: spends the token `reset_password_verify`
/// issued to actually set the new password. No session is created — the
/// dashboard sends the user back to the sign-in screen after this succeeds,
/// same as changing a password anywhere else means using it fresh next
/// time, not being carried in on the change itself.
async fn reset_password_confirm(State(state): State<SharedState>, Json(body): Json<ResetPasswordConfirmBody>) -> AppResult<Json<Value>> {
    let email = normalize_email(body.email.as_deref().unwrap_or(""));
    let token = body.token.as_deref().unwrap_or("");
    if !verify_password_reset_token(&state, token, &email) {
        return Err(AppError::bad_request("invalid_token", "That reset attempt has expired — start over"));
    }

    let new_password = body.new_password.as_deref().unwrap_or("");
    validate_password(new_password)?;

    let conn = state.db.lock();
    let user = users::by_email(&conn, &email)?.ok_or_else(|| AppError::not_found("Account not found"))?;
    let hash = hash_password(new_password);
    users::set_password(&conn, &user.id, Some(&hash))?;

    logger::scoped("auth").info(format!("{} reset their password", user.email));
    Ok(Json(json!({ "ok": true })))
}

/// Settings → delete the signed-in user's own account. Refuses while they
/// still own any project — same reasoning as `require_admin_or_creator`
/// gating project deletion: deleting the account out from under a project
/// would leave it ownerless, so the account has to go last, not first.
/// Sessions and connected Git accounts cascade automatically — see the doc
/// comment on `users::delete`.
async fn delete_account(user: AuthUser, State(state): State<SharedState>, jar: CookieJar) -> AppResult<(CookieJar, Json<Value>)> {
    let conn = state.db.lock();
    let owned = projects::by_creator(&conn, &user.user.id)?;
    if !owned.is_empty() {
        let names = owned.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
        return Err(AppError::bad_request(
            "projects_remain",
            format!(
                "Delete your project{} first: {names}",
                if owned.len() == 1 { "" } else { "s" }
            ),
        ));
    }

    users::delete(&conn, &user.user.id)?;
    drop(conn);
    logger::scoped("auth").info(format!("{} deleted their account", user.user.email));

    let jar = end_session(&state, jar);
    Ok((jar, Json(json!({ "ok": true }))))
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
        // A conflicting GitHub login isn't fatal here — the account still
        // signed in fine by email, it just doesn't walk away with the Git
        // attachment. They can retry "Connect with GitHub OAuth" from
        // Settings and see exactly why it's refused there.
        match save_integration(&state, &user.id, &profile, &token) {
            Ok(()) => logger::scoped("auth").info(format!("{} signed in via GitHub", user.email)),
            Err(msg) => logger::scoped("auth").info(format!("{} signed in via GitHub, but not attached: {msg}", user.email)),
        }
        return (jar, Redirect::to(&format!("{}/", state.config.dashboard_url))).into_response();
    }

    let Some((user, _)) = resolve_user(&state, &headers, &jar) else {
        return login_fail(&state, "Sign in before connecting GitHub").into_response();
    };
    if let Err(msg) = save_integration(&state, &user.id, &profile, &token) {
        return Redirect::to(&format!("{}/settings/git?error={}", state.config.dashboard_url, urlencoding::encode(&msg))).into_response();
    }
    Redirect::to(&format!("{}/settings/git?connected=1", state.config.dashboard_url)).into_response()
}

/// Attaches a GitHub account to `user_id`. Errs (without touching the DB)
/// if that exact GitHub login is already connected to a *different*
/// workspace member — one GitHub account can't back two dashboard
/// accounts at once. Re-attaching the same login to the same user (a
/// fresh token, most commonly) replaces the old row instead of tripping
/// that check.
fn save_integration(state: &SharedState, user_id: &str, profile: &github::GhUser, token: &str) -> Result<(), String> {
    let conn = state.db.lock();
    let mine = integrations::for_user(&conn, user_id).unwrap_or_default();
    if let Some(dup) = mine.into_iter().find(|i| i.provider == "github" && i.login == profile.login) {
        let _ = integrations::delete(&conn, &dup.id);
    } else if let Ok(Some(other)) = integrations::by_login(&conn, "github", &profile.login) {
        if other.user_id != user_id {
            let owner = users::by_id(&conn, &other.user_id).ok().flatten().map(|u| u.email).unwrap_or_else(|| "another workspace member".to_string());
            return Err(format!("{} is already connected to {owner}'s account", profile.login));
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
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::{password_reset_token_raw, validate_password, verify_password_reset_token_at};
    use crate::crypto::Crypto;

    #[test]
    fn accepts_a_password_meeting_every_rule() {
        assert!(validate_password("Correct1!").is_ok());
    }

    #[test]
    fn rejects_too_short() {
        let err = validate_password("Sh0rt!").unwrap_err();
        assert!(err.message.contains("at least 8 characters"), "{}", err.message);
    }

    #[test]
    fn rejects_missing_uppercase() {
        let err = validate_password("lowercase1!").unwrap_err();
        assert!(err.message.contains("uppercase"), "{}", err.message);
    }

    #[test]
    fn rejects_missing_lowercase() {
        let err = validate_password("UPPERCASE1!").unwrap_err();
        assert!(err.message.contains("lowercase"), "{}", err.message);
    }

    #[test]
    fn rejects_missing_special_character() {
        let err = validate_password("Password123").unwrap_err();
        assert!(err.message.contains("special character"), "{}", err.message);
    }

    const FIVE_MIN_MS: i64 = 5 * 60 * 1000;

    #[test]
    fn accepts_a_password_reset_token_issued_right_now() {
        let crypto = Crypto::new("test-secret");
        let now = 1_700_000_000_000i64;
        let token = password_reset_token_raw(&crypto, "user@example.com", now);
        assert!(verify_password_reset_token_at(&crypto, &token, "user@example.com", now));
    }

    #[test]
    fn accepts_a_password_reset_token_exactly_at_the_five_minute_boundary() {
        let crypto = Crypto::new("test-secret");
        let now = 1_700_000_000_000i64;
        let token = password_reset_token_raw(&crypto, "user@example.com", now - FIVE_MIN_MS);
        assert!(verify_password_reset_token_at(&crypto, &token, "user@example.com", now));
    }

    #[test]
    fn rejects_a_password_reset_token_one_second_past_five_minutes() {
        let crypto = Crypto::new("test-secret");
        let now = 1_700_000_000_000i64;
        let token = password_reset_token_raw(&crypto, "user@example.com", now - FIVE_MIN_MS - 1000);
        assert!(!verify_password_reset_token_at(&crypto, &token, "user@example.com", now));
    }

    /// Regression guard for the 10 -> 5 minute shortening: an 8-minute-old
    /// token passed under the old window and must now be rejected.
    #[test]
    fn rejects_a_password_reset_token_that_the_old_ten_minute_window_would_have_accepted() {
        let crypto = Crypto::new("test-secret");
        let now = 1_700_000_000_000i64;
        let token = password_reset_token_raw(&crypto, "user@example.com", now - 8 * 60 * 1000);
        assert!(!verify_password_reset_token_at(&crypto, &token, "user@example.com", now));
    }

    #[test]
    fn rejects_a_password_reset_token_issued_for_a_different_email() {
        let crypto = Crypto::new("test-secret");
        let now = 1_700_000_000_000i64;
        let token = password_reset_token_raw(&crypto, "user@example.com", now);
        assert!(!verify_password_reset_token_at(&crypto, &token, "someone-else@example.com", now));
    }

    #[test]
    fn rejects_a_tampered_password_reset_token() {
        let crypto = Crypto::new("test-secret");
        let now = 1_700_000_000_000i64;
        let mut token = password_reset_token_raw(&crypto, "user@example.com", now);
        token.push('x');
        assert!(!verify_password_reset_token_at(&crypto, &token, "user@example.com", now));
    }

    #[test]
    fn rejects_a_password_reset_token_signed_under_a_different_secret() {
        let crypto_a = Crypto::new("test-secret-a");
        let crypto_b = Crypto::new("test-secret-b");
        let now = 1_700_000_000_000i64;
        let token = password_reset_token_raw(&crypto_a, "user@example.com", now);
        assert!(!verify_password_reset_token_at(&crypto_b, &token, "user@example.com", now));
    }
}
