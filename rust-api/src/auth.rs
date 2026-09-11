//! Mirrors `apps/api/src/lib/auth.ts`.

use axum::async_trait;
use axum::extract::FromRequestParts;
use axum::http::{header, request::Parts, StatusCode};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde_json::{json, Value};

use crate::config::{is_email_allowed, normalize_email};
use crate::db::types::User;
use crate::db::{now_ms, sessions, users};
use crate::error::AppError;
use crate::ids::{new_session_id, new_user_id};
use crate::state::SharedState;

/// Finds or creates the user for `email`, rejecting addresses outside the
/// allow-listed domains. The first user to sign in owns the workspace.
pub fn upsert_user(
    state: &SharedState,
    email: &str,
    name: Option<&str>,
    avatar_url: Option<&str>,
) -> Result<User, AppError> {
    let normalized = normalize_email(email);
    if !is_email_allowed(&state.config, &normalized) {
        let domains = state
            .config
            .allowed_email_domains
            .iter()
            .map(|d| format!("@{d}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "domain_not_allowed",
            format!("Only {domains} email addresses can sign in"),
        ));
    }

    let conn = state.db.lock();
    if let Some(existing) = users::by_email(&conn, &normalized)? {
        let name_changed = matches!((name, &existing.name), (Some(n), Some(e)) if n != e)
            || matches!((name, &existing.name), (Some(_), None));
        let avatar_changed = matches!((avatar_url, &existing.avatar_url), (Some(a), Some(e)) if a != e)
            || matches!((avatar_url, &existing.avatar_url), (Some(_), None));
        if name_changed || avatar_changed {
            users::update_profile(
                &conn,
                &existing.id,
                name.or(existing.name.as_deref()),
                avatar_url.or(existing.avatar_url.as_deref()),
            )?;
        }
        users::touch_login(&conn, &existing.id)?;
        return Ok(users::by_id(&conn, &existing.id)?.expect("just touched"));
    }

    let is_first_user = users::count(&conn)? == 0;
    let default_name = normalized.split('@').next().unwrap_or(&normalized).to_string();
    let created = users::create(
        &conn,
        users::NewUser {
            id: &new_user_id(),
            email: &normalized,
            name: Some(name.unwrap_or(&default_name)),
            avatar_url,
            role: if is_first_user { "owner" } else { "member" },
        },
    )?;
    users::touch_login(&conn, &created.id)?;
    Ok(created)
}

/// Creates a session row and returns the cookie jar with the signed session
/// cookie added, plus the raw session id (the CLI needs the *signed* form —
/// see `routes::auth`).
pub fn start_session(
    state: &SharedState,
    jar: CookieJar,
    user: &User,
    user_agent: Option<&str>,
) -> Result<(CookieJar, String), AppError> {
    let id = new_session_id();
    let expires_at = now_ms() + state.config.session_ttl_ms;
    {
        let conn = state.db.lock();
        sessions::create(&conn, &id, &user.id, expires_at, user_agent)?;
    }

    let signed = state.crypto.sign_token(&id);
    let max_age = time::Duration::seconds(state.config.session_ttl_ms / 1000);
    let cookie = Cookie::build((state.config.cookie_name.clone(), signed))
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.deployment_scheme == "https")
        .path("/")
        .max_age(max_age)
        .build();

    Ok((jar.add(cookie), id))
}

pub fn end_session(state: &SharedState, jar: CookieJar) -> CookieJar {
    if let Some(cookie) = jar.get(&state.config.cookie_name) {
        if let Some(session_id) = state.crypto.verify_token(cookie.value()) {
            let conn = state.db.lock();
            let _ = sessions::delete(&conn, &session_id);
        }
    }
    let removal = Cookie::build(state.config.cookie_name.clone()).path("/").build();
    jar.remove(removal)
}

/// Resolves the signed-in user from the session cookie or a bearer token.
/// Returns the user and the session id (the latter matters for
/// `/api/auth/sessions`).
pub fn resolve_user(state: &SharedState, headers: &header::HeaderMap, jar: &CookieJar) -> Option<(User, String)> {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    let raw = bearer.or_else(|| jar.get(&state.config.cookie_name).map(|c| c.value().to_string()))?;
    let session_id = state.crypto.verify_token(&raw)?;

    let conn = state.db.lock();
    let session = sessions::by_id(&conn, &session_id).ok().flatten()?;
    if session.expires_at < now_ms() {
        let _ = sessions::delete(&conn, &session.id);
        return None;
    }
    let user = users::by_id(&conn, &session.user_id).ok().flatten()?;
    Some((user, session.id))
}

pub fn public_user(user: &User) -> Value {
    json!({
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "avatarUrl": user.avatar_url,
        "role": user.role,
        "createdAt": user.created_at,
    })
}

/// Axum extractor equivalent of the `requireAuth` Fastify preHandler:
/// `AuthUser` as a handler parameter rejects the request with 401 before the
/// handler body runs at all if there is no valid session.
pub struct AuthUser {
    pub user: User,
    pub session_id: String,
}

#[async_trait]
impl FromRequestParts<SharedState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &SharedState) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        match resolve_user(state, &parts.headers, &jar) {
            Some((user, session_id)) => Ok(AuthUser { user, session_id }),
            None => Err(AppError::unauthorized("Authentication required")),
        }
    }
}
