//! Mirrors `apps/builder/src/paths.ts`.

use std::path::Path;

use crate::config::Config;

/// Converts a Windows path to the path WSL sees.
///
///   `D:\Projects\my-app\data`             -> `/mnt/d/Projects/my-app/data`
///   `\\wsl.localhost\Ubuntu\home\me\data` -> `/home/me/data`
pub fn to_wsl_path(win_path: &str) -> String {
    let raw = win_path.replace('\\', "/");

    if let Some(rest) = strip_wsl_unc_prefix(&raw) {
        return if rest.is_empty() { "/".to_string() } else { rest };
    }

    let normalized = std::fs::canonicalize(win_path)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| raw.clone());
    // `canonicalize` on Windows returns a `\\?\C:\...` extended-length path;
    // strip that prefix before looking for the drive letter.
    let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);

    match drive_letter(normalized) {
        Some((letter, rest)) => format!("/mnt/{}/{}", letter.to_lowercase(), rest),
        None => normalized.to_string(),
    }
}

fn strip_wsl_unc_prefix(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("//wsl.localhost/").or_else(|| raw.strip_prefix("//wsl$/"))?;
    let after_distro = rest.split_once('/').map(|(_, r)| r).unwrap_or("");
    Some(format!("/{after_distro}"))
}

fn drive_letter(path: &str) -> Option<(char, &str)> {
    let mut chars = path.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() {
        return None;
    }
    if chars.next() != Some(':') {
        return None;
    }
    let rest = &path[2..];
    Some((letter, rest.trim_start_matches('/')))
}

/// Path as the build executor sees it: WSL builds address Windows paths
/// through `/mnt/<drive>`, local builds use the path as-is.
pub fn exec_path(cfg: &Config, p: &str) -> String {
    if cfg.build.executor == "wsl" {
        to_wsl_path(p)
    } else {
        p.to_string()
    }
}

pub fn exec_path_of(cfg: &Config, p: &Path) -> String {
    exec_path(cfg, &p.to_string_lossy())
}

/// Quotes a value for safe interpolation into a POSIX shell script.
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_unc_path() {
        assert_eq!(to_wsl_path(r"\\wsl.localhost\Ubuntu\home\me\data"), "/home/me/data");
    }

    #[test]
    fn sh_quote_escapes_single_quotes() {
        assert_eq!(sh_quote("it's a test"), r"'it'\''s a test'");
    }
}
