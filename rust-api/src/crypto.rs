//! Mirrors `packages/shared/src/crypto.ts` byte-for-byte: same key
//! derivation, same encrypted-payload format, same signed-token format.
//! An existing `token_enc` / `value_enc` column written by the Node API, or
//! a session cookie it issued, must keep working against this module.
//!
//! See `docs/rust-api-migration-plan.md` for the exact parameters this
//! depends on (scrypt cost params, base64url, etc).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use rand::RngCore;
use scrypt::Params;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Mutex;
use subtle::ConstantTimeEq;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("malformed encrypted payload")]
    Malformed,
    #[error("payload failed authentication (wrong key or tampered)")]
    Tampered,
}

/// Node's `scryptSync` default cost parameters (N=2^14, r=8, p=1) — the
/// `scrypt` crate does not default to the same values, so these must be
/// passed explicitly or every derived key differs from Node's.
fn scrypt_params() -> Params {
    Params::new(14, 8, 1, 32).expect("N=16384,r=8,p=1,len=32 are valid scrypt params")
}

/// Holds the app secret and a cache of purpose -> derived key, exactly like
/// `crypto.ts`'s module-level `KEY_CACHE` (scrypt is deliberately slow, so
/// deriving a key per purpose once and reusing it matters).
pub struct Crypto {
    secret: String,
    key_cache: Mutex<HashMap<String, [u8; 32]>>,
}

impl Crypto {
    pub fn new(secret: impl Into<String>) -> Self {
        Self { secret: secret.into(), key_cache: Mutex::new(HashMap::new()) }
    }

    fn key_for(&self, purpose: &str) -> [u8; 32] {
        if let Some(key) = self.key_cache.lock().unwrap().get(purpose) {
            return *key;
        }
        let salt = format!("avail:{purpose}");
        let mut out = [0u8; 32];
        scrypt::scrypt(self.secret.as_bytes(), salt.as_bytes(), &scrypt_params(), &mut out)
            .expect("32-byte output is valid for these params");
        self.key_cache.lock().unwrap().insert(purpose.to_string(), out);
        out
    }

    /// Encrypts `plaintext` with AES-256-GCM. Returns
    /// `v1.<iv>.<tag>.<ciphertext>` (all base64url, no padding).
    pub fn encrypt(&self, plaintext: &str, purpose: &str) -> String {
        let key = self.key_for(purpose);
        let cipher = Aes256Gcm::new_from_slice(&key).expect("key is exactly 32 bytes");

        let mut iv = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut iv);

        // The crate appends the 16-byte auth tag to the ciphertext; split it
        // back out so the wire format matches Node's separate iv/tag/data.
        let mut sealed = cipher
            .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
            .expect("encryption with a fresh nonce cannot fail");
        let tag = sealed.split_off(sealed.len() - 16);

        format!(
            "v1.{}.{}.{}",
            URL_SAFE_NO_PAD.encode(iv),
            URL_SAFE_NO_PAD.encode(tag),
            URL_SAFE_NO_PAD.encode(sealed),
        )
    }

    /// Reverses [`Crypto::encrypt`]. Errs if the payload is malformed or was
    /// tampered with (or encrypted under a different secret/purpose).
    pub fn decrypt(&self, payload: &str, purpose: &str) -> Result<String, CryptoError> {
        let mut parts = payload.splitn(4, '.');
        let (Some(version), Some(iv_b64), Some(tag_b64), Some(data_b64)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(CryptoError::Malformed);
        };
        if version != "v1" {
            return Err(CryptoError::Malformed);
        }

        let iv = URL_SAFE_NO_PAD.decode(iv_b64).map_err(|_| CryptoError::Malformed)?;
        let tag = URL_SAFE_NO_PAD.decode(tag_b64).map_err(|_| CryptoError::Malformed)?;
        let mut sealed = URL_SAFE_NO_PAD.decode(data_b64).map_err(|_| CryptoError::Malformed)?;
        sealed.extend_from_slice(&tag);

        let key = self.key_for(purpose);
        let cipher = Aes256Gcm::new_from_slice(&key).expect("key is exactly 32 bytes");
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&iv), sealed.as_ref())
            .map_err(|_| CryptoError::Tampered)?;
        String::from_utf8(plaintext).map_err(|_| CryptoError::Malformed)
    }

    /// Best-effort decrypt: `None` instead of an error.
    pub fn try_decrypt(&self, payload: &str, purpose: &str) -> Option<String> {
        self.decrypt(payload, purpose).ok()
    }

    pub fn hmac(&self, data: &str, purpose: &str) -> String {
        let key = self.key_for(purpose);
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("any length key is valid for HMAC");
        mac.update(data.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Signs a session id so a stolen cookie cannot be forged offline.
    pub fn sign_token(&self, value: &str) -> String {
        format!("{value}.{}", self.hmac(value, "session"))
    }

    /// Verifies and unwraps a token produced by [`Crypto::sign_token`].
    pub fn verify_token(&self, token: &str) -> Option<String> {
        let idx = token.rfind('.')?;
        let (value, rest) = token.split_at(idx);
        let sig = &rest[1..];
        if safe_equal(&self.hmac(value, "session"), sig) {
            Some(value.to_string())
        } else {
            None
        }
    }

    pub fn hash_code(&self, code: &str) -> String {
        self.hmac(code, "login-code")
    }
}

/// Constant-time string comparison that tolerates differing lengths (the
/// length check itself is not constant-time, matching `crypto.ts`, which
/// has the same property).
pub fn safe_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Verifies a GitHub `X-Hub-Signature-256` header against the *raw* request
/// body, keyed directly by the project's plain webhook secret — unlike
/// every other HMAC use here, this one is not scrypt-derived, matching
/// `verifyGithubSignature` in `crypto.ts`.
pub fn verify_github_signature(raw_body: &[u8], header: Option<&str>, secret: &str) -> bool {
    let Some(header) = header else { return false };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()).expect("any length key is valid for HMAC");
    mac.update(raw_body);
    let expected = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
    safe_equal(&expected, header)
}

/// 6-digit numeric one-time login code.
pub fn generate_login_code() -> String {
    let mut bytes = [0u8; 4];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let n = u32::from_be_bytes(bytes) % 1_000_000;
    format!("{n:06}")
}

pub fn random_secret(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    hex::encode(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_round_trip() {
        let c = Crypto::new("test-secret");
        let enc = c.encrypt("hello world", "secret");
        assert_ne!(enc, "hello world");
        assert_eq!(c.decrypt(&enc, "secret").unwrap(), "hello world");
    }

    #[test]
    fn decrypt_rejects_wrong_purpose() {
        let c = Crypto::new("test-secret");
        let enc = c.encrypt("hello world", "secret");
        assert!(c.decrypt(&enc, "other-purpose").is_err());
    }

    #[test]
    fn decrypt_rejects_tampering() {
        let c = Crypto::new("test-secret");
        let mut enc = c.encrypt("hello world", "secret");
        enc.push('x');
        assert!(c.try_decrypt(&enc, "secret").is_none());
    }

    #[test]
    fn sign_and_verify_token() {
        let c = Crypto::new("test-secret");
        let token = c.sign_token("session-id-123");
        assert_eq!(c.verify_token(&token).as_deref(), Some("session-id-123"));
        assert_eq!(c.verify_token("session-id-123.bad-signature"), None);
    }

    #[test]
    fn login_code_is_six_digits() {
        for _ in 0..50 {
            let code = generate_login_code();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|ch| ch.is_ascii_digit()));
        }
    }

    #[test]
    fn github_signature_matches_known_vector() {
        // node -e "console.log(require('crypto')
        //   .createHmac('sha256', \"it's a secret\")
        //   .update('Hello, World!').digest('hex'))"
        let sig = verify_github_signature(
            b"Hello, World!",
            Some("sha256=258c6c59f43f2bc8b335465c7873f85fee5e447c9c7b973839b54a6515ac0d5f"),
            "it's a secret",
        );
        assert!(sig);
    }

    /// Cross-check against a payload produced by the *actual* Node
    /// `encrypt()` — `node -e` with the same fixed secret/purpose/plaintext
    /// (see docs/rust-api-migration-plan.md's "parity tests" section). If
    /// this ever fails, the scrypt params or base64 alphabet have drifted.
    #[test]
    fn decrypts_a_payload_produced_by_node() {
        let c = Crypto::new("parity-test-secret");
        // Produced by the real Node crypto.ts:
        //   AVAIL_SECRET=parity-test-secret node --experimental-sqlite \
        //     --import tsx -e "import('./packages/shared/src/crypto.ts')
        //       .then(m => console.log(m.encrypt('parity check', 'secret')))"
        // Regenerate this constant if crypto.ts's format ever changes.
        let node_payload = "v1.nhQZh8EptaNgSnft.8Hscyl05n9A1ipwTTeEhkw.2zeb67IzNHOa7u3v";
        assert_eq!(c.decrypt(node_payload, "secret").unwrap(), "parity check");
    }
}
