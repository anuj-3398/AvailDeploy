//! Mirrors `apps/api/src/lib/google.ts`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;

use crate::config::{Config, GoogleConfig};
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
    configured_for(&cfg.google)
}

fn configured_for(google: &GoogleConfig) -> bool {
    google.client_id.is_some() && google.client_secret.is_some()
}

/// Google's consent screen URL. When exactly one domain is allow-listed we
/// pass it as the `hd` hint, so Workspace users land on their work account
/// instead of picking from every Google account they're signed into.
pub fn authorize_url(cfg: &Config, redirect_uri: &str, state: &str) -> String {
    authorize_url_for(&cfg.google, &cfg.allowed_email_domains, redirect_uri, state)
}

fn authorize_url_for(google: &GoogleConfig, allowed_email_domains: &[String], redirect_uri: &str, state: &str) -> String {
    let client_id = google.client_id.as_deref().unwrap_or("");
    let mut url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&access_type=online&prompt=select_account",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode("openid email profile"),
        urlencoding::encode(state),
    );
    if allowed_email_domains.len() == 1 {
        url.push_str(&format!("&hd={}", urlencoding::encode(&allowed_email_domains[0])));
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

    // See github.rs's client() for why this needs an explicit timeout:
    // a hung connection to Google otherwise blocks this request forever.
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|e| GoogleError(e.to_string()))?;
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

/// Ported from the deleted `apps/api`'s `tests/unit.test.mjs` ("google
/// sign-in" describe block) when `apps/api` was removed in favor of this
/// crate — see docs/rust-api-migration-plan.md.
#[cfg(test)]
mod tests {
    use super::*;

    fn google(client_id: Option<&str>, client_secret: Option<&str>) -> GoogleConfig {
        GoogleConfig { client_id: client_id.map(String::from), client_secret: client_secret.map(String::from) }
    }

    const REDIRECT_URI: &str = "http://localhost:3001/api/auth/google/callback";

    #[test]
    fn configured_only_when_both_credentials_are_present() {
        assert!(configured_for(&google(Some("id"), Some("secret"))));
        assert!(!configured_for(&google(None, Some("secret"))));
        assert!(!configured_for(&google(Some("id"), None)));
        assert!(!configured_for(&google(None, None)));
    }

    #[test]
    fn builds_a_standards_compliant_authorization_url() {
        let google = google(Some("test-client-id.apps.googleusercontent.com"), Some("test-client-secret"));
        let raw = authorize_url_for(&google, &[], REDIRECT_URI, "signed-state");
        let url = reqwest::Url::parse(&raw).unwrap();
        let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());

        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        assert_eq!(url.path(), "/o/oauth2/v2/auth");
        assert_eq!(get("response_type"), Some("code".to_string()));
        assert_eq!(get("scope"), Some("openid email profile".to_string()));
        assert_eq!(get("redirect_uri"), Some(REDIRECT_URI.to_string()));
        assert_eq!(get("state"), Some("signed-state".to_string()));
        assert_eq!(get("client_id"), Some("test-client-id.apps.googleusercontent.com".to_string()));
    }

    #[test]
    fn hints_the_allow_listed_workspace_domain_to_the_account_chooser() {
        let google = google(Some("id"), Some("secret"));
        let domains = vec!["availproject.org".to_string()];
        let url = reqwest::Url::parse(&authorize_url_for(&google, &domains, REDIRECT_URI, "state")).unwrap();
        assert_eq!(url.query_pairs().find(|(k, _)| k == "hd").map(|(_, v)| v.into_owned()), Some("availproject.org".to_string()));
    }

    #[test]
    fn omits_the_hd_hint_when_the_domain_is_not_unambiguous() {
        let google = google(Some("id"), Some("secret"));
        for domains in [vec![], vec!["a.org".to_string(), "b.org".to_string()]] {
            let url = reqwest::Url::parse(&authorize_url_for(&google, &domains, REDIRECT_URI, "state")).unwrap();
            assert!(url.query_pairs().find(|(k, _)| k == "hd").is_none());
        }
    }

    #[test]
    fn sends_users_through_the_account_chooser_rather_than_silently_reusing_one() {
        let google = google(Some("id"), Some("secret"));
        let url = reqwest::Url::parse(&authorize_url_for(&google, &[], REDIRECT_URI, "state")).unwrap();
        assert_eq!(url.query_pairs().find(|(k, _)| k == "prompt").map(|(_, v)| v.into_owned()), Some("select_account".to_string()));
    }
}
