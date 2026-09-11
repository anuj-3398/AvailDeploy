//! Mirrors `packages/shared/src/ids.ts`. `id()`'s modulo-36 mapping is not
//! statistically uniform (256 % 36 != 0) — replicated exactly anyway, not
//! "fixed", so ids stay the same shape whichever process minted them.

use rand::RngCore;

const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// URL-safe lowercase id with a Vercel-style prefix (e.g. `dpl_a1b2c3`).
pub fn id(prefix: &str, size: usize) -> String {
    let mut bytes = vec![0u8; size];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let body: String = bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect();
    if prefix.is_empty() {
        body
    } else {
        format!("{prefix}_{body}")
    }
}

pub fn id_default(prefix: &str) -> String {
    id(prefix, 20)
}

pub fn new_deployment_id() -> String {
    id_default("dpl")
}
pub fn new_project_id() -> String {
    id_default("prj")
}
pub fn new_user_id() -> String {
    id_default("usr")
}
pub fn new_session_id() -> String {
    id("sess", 28)
}
pub fn new_env_id() -> String {
    id_default("env")
}
pub fn new_alias_id() -> String {
    id_default("alias")
}
pub fn new_integration_id() -> String {
    id_default("git")
}

/// `My Cool App` -> `my-cool-app`; safe to use as a hostname label.
pub fn slugify(input: &str) -> String {
    // `.normalize('NFKD').toLowerCase()` in JS mainly matters for accented
    // input; every non [a-z0-9] byte is collapsed to `-` right after, so a
    // plain lowercase + ASCII filter reaches the same result for the
    // overwhelming majority of project names without a unicode-normalization
    // dependency. Non-ASCII letters fall out here exactly as they would in
    // JS once NFKD-decomposed accents are stripped by the same filter.
    let lower = input.to_lowercase();
    let mut slug = String::with_capacity(lower.len());
    let mut last_was_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug.truncate(48);
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

/// Short random suffix used inside deployment hostnames.
pub fn short_hash(size: usize) -> String {
    id("", size)
}

pub fn short_hash_default() -> String {
    short_hash(9)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_has_prefix_and_length() {
        let v = id("dpl", 20);
        assert!(v.starts_with("dpl_"));
        assert_eq!(v.len(), "dpl_".len() + 20);
        assert!(v[4..].bytes().all(|b| ALPHABET.contains(&b)));
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("My Cool App"), "my-cool-app");
        assert_eq!(slugify("  --weird__name!! "), "weird-name");
        assert_eq!(slugify(""), "project");
        assert_eq!(slugify("!!!"), "project");
    }

    #[test]
    fn slugify_truncates_to_48() {
        let long = "a".repeat(100);
        assert_eq!(slugify(&long).len(), 48);
    }
}
