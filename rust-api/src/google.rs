//! Mirrors `apps/api/src/lib/google.ts`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;

use crate::config::Config;
use crate::db::now_ms;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

#[derive(Debug)]
pub struct GoogleError(pub String);

impl std::fmt::Display for GoogleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for GoogleError {}

/// The subset of Google's ID token claims this platform relies on.
pub struct GoogleIdentity {
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    iss: Option<String>,
    aud: Option<String>,
    email: Option<String>,
    #[serde(default)]
    email_verified: Value,
    name: Option<String>,
    picture: Option<String>,
    exp: Option<i64>,
}

fn decode_jwt_payload(token: &str) -> Result<IdTokenClaims, GoogleError> {
    let payload = token.split('.').nth(1).ok_or_else(|| GoogleError("Malformed ID token".into()))?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| GoogleError("Malformed ID token".into()))?;
    serde_json::from_slice(&bytes).map_err(|_| GoogleError("ID token payload is not valid JSON".into()))
}

pub fn configured(cfg: &Config) -> bool {
    cfg.google.client_id.is_some() && cfg.google.client_secret.is_some()
}

/// Google's consent screen URL. When exactly one domain is allow-listed we
/// pass it as the `hd` hint, so Workspace users land on their work account
/// instead of picking from every Google account they're signed into.
pub fn authorize_url(cfg: &Config, redirect_uri: &str, state: &str) -> String {
    let client_id = cfg.google.client_id.as_deref().unwrap_or("");
    let mut url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&access_type=online&prompt=select_account",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode("openid email profile"),
        urlencoding::encode(state),
    );
    if cfg.allowed_email_domains.len() == 1 {
        url.push_str(&format!("&hd={}", urlencoding::encode(&cfg.allowed_email_domains[0])));
    }
    url
}

/// Exchanges the callback code for the caller's identity. The ID token is
/// fetched over a direct TLS connection to Google's token endpoint rather
/// than through the browser, so OIDC Core §3.1.3.7 allows TLS server
/// validation in place of verifying the token signature — the claims
/// themselves are still checked below.
pub async fn exchange_code(cfg: &Config, code: &str, redirect_uri: &str) -> Result<GoogleIdentity, GoogleError> {
    if !configured(cfg) {
        return Err(GoogleError("Google sign-in is not configured".into()));
    }
    let client_id = cfg.google.client_id.clone().unwrap();
    let client_secret = cfg.google.client_secret.clone().unwrap();

    let client = reqwest::Client::new();
    let form = [
        ("code", code),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    let response = client
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| GoogleError(e.to_string()))?;

    let status_ok = response.status().is_success();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let id_token = body.get("id_token").and_then(|t| t.as_str());

    if !status_ok || id_token.is_none() {
        let desc = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|d| d.as_str())
            .unwrap_or("Google rejected the sign-in");
        return Err(GoogleError(desc.to_string()));
    }

    let claims = decode_jwt_payload(id_token.unwrap())?;

    let valid_issuer = matches!(claims.iss.as_deref(), Some("https://accounts.google.com") | Some("accounts.google.com"));
    if !valid_issuer {
        return Err(GoogleError("ID token came from an unexpected issuer".into()));
    }
    if claims.aud.as_deref() != Some(client_id.as_str()) {
        return Err(GoogleError("ID token was issued for a different application".into()));
    }
    if claims.exp.map(|e| e * 1000 < now_ms()).unwrap_or(true) {
        return Err(GoogleError("ID token has expired".into()));
    }
    let Some(email) = claims.email else {
        return Err(GoogleError("Google did not return an email address".into()));
    };
    // An unverified address proves nothing about who is signing in.
    let verified = matches!(&claims.email_verified, Value::Bool(true)) || claims.email_verified.as_str() == Some("true");
    if !verified {
        return Err(GoogleError(format!("{email} is not a verified Google address")));
    }

    Ok(GoogleIdentity { email, name: claims.name, picture: claims.picture })
}
