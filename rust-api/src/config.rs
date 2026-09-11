//! Mirrors `packages/shared/src/config.ts`. Field names, defaults and the
//! `.env` loading order are kept identical on purpose — both the Node API
//! and this one read the same `.env` at the same repo root.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Repo root: `rust-api/`'s parent directory, resolved at compile time so it
/// does not depend on the working directory the binary is launched from.
pub fn root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("rust-api/ has a parent directory")
            .to_path_buf()
    })
}

/// Same semantics as `config.ts`'s `loadEnvFile`: `KEY=value` per line,
/// `#` comments, optional matching quotes stripped, and a value already set
/// in the process environment is never overwritten (so `.env` loses to
/// `.env.local`'s already-applied values, which loses to a real env var).
fn load_env_file(file: &Path) {
    let Ok(contents) = fs::read_to_string(file) else {
        return;
    };
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let key = line[..eq].trim();
        let mut value = line[eq + 1..].trim();
        let quoted = (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2);
        if quoted {
            value = &value[1..value.len() - 1];
        }
        if env::var_os(key).is_none() {
            env::set_var(key, value);
        }
    }
}

fn num(key: &str, fallback: i64) -> i64 {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(fallback)
}

fn boolean(key: &str, fallback: bool) -> bool {
    match env::var(key) {
        Err(_) => fallback,
        Ok(v) => matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
    }
}

fn string(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn opt_string(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
}

pub struct GithubConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub webhook_secret: Option<String>,
    pub api_url: String,
    pub poll_enabled: bool,
    pub poll_interval_ms: i64,
}

pub struct GoogleConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

pub struct BuildConfig {
    /// `local` runs commands with the host shell, `wsl` runs them inside WSL.
    pub executor: String,
    pub wsl_distro: String,
    pub concurrency: i64,
    pub timeout_ms: i64,
    pub keep_per_project: i64,
    pub default_node_version: String,
}

/// Serverless functions + server deployments.
pub struct RuntimeConfig {
    pub idle_timeout_ms: i64,
    pub boot_timeout_ms: i64,
    pub port_range_start: u16,
    pub port_range_end: u16,
    pub max_duration_sec: i64,
}

pub struct Config {
    pub root: PathBuf,
    pub env: String,

    pub api_port: u16,
    pub proxy_port: u16,
    pub dashboard_port: u16,
    pub host: String,

    pub api_url: String,
    pub dashboard_url: String,

    pub deployment_domain: String,
    pub deployment_scheme: String,

    pub data_dir: PathBuf,
    pub db_file: PathBuf,
    pub workspace_dir: PathBuf,
    pub workspace_is_native: bool,
    pub workspace_reason: String,
    pub projects_dir: PathBuf,
    pub deployments_dir: PathBuf,
    pub cache_dir: PathBuf,

    pub secret: String,
    pub allowed_email_domains: Vec<String>,
    pub session_ttl_ms: i64,
    pub login_code_ttl_ms: i64,
    pub auth_dev_echo: bool,
    pub cookie_name: String,

    pub smtp_url: Option<String>,
    pub mail_from: String,

    pub google: GoogleConfig,
    pub github: GithubConfig,

    pub build: BuildConfig,
    pub runtime: RuntimeConfig,
}

/// True when the data directory is nested inside the platform repository —
/// builds would otherwise inherit this repo's own `node_modules`.
pub fn data_dir_is_nested(data_dir: &Path) -> bool {
    match data_dir.strip_prefix(root()) {
        Ok(rel) => !rel.as_os_str().is_empty(),
        Err(_) => false,
    }
}

struct Workspace {
    dir: PathBuf,
    native: bool,
    reason: String,
}

/// See `config.ts`'s `resolveWorkspaceDir` — same WSL-native-filesystem
/// probe, same on-disk cache so it costs one `wsl.exe` call per host, not
/// per process boot.
fn resolve_workspace_dir(data_dir: &Path, executor: &str, wsl_distro: &str) -> Workspace {
    if let Some(dir) = opt_string("AVAIL_WORKSPACE_DIR") {
        return Workspace { dir: PathBuf::from(dir), native: true, reason: "AVAIL_WORKSPACE_DIR".into() };
    }
    if executor != "wsl" || cfg!(not(windows)) {
        return Workspace {
            dir: data_dir.to_path_buf(),
            native: true,
            reason: "executor runs on this filesystem".into(),
        };
    }
    if !boolean("WSL_NATIVE_WORKSPACE", true) {
        return Workspace {
            dir: data_dir.to_path_buf(),
            native: false,
            reason: "disabled by WSL_NATIVE_WORKSPACE".into(),
        };
    }

    let cache_file = data_dir.join("workspace.json");
    if let Ok(cached) = fs::read_to_string(&cache_file) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&cached) {
            let cached_distro = json.get("distro").and_then(|v| v.as_str()).unwrap_or("");
            let cached_dir = json.get("dir").and_then(|v| v.as_str()).unwrap_or("");
            if cached_distro == wsl_distro && !cached_dir.is_empty() && Path::new(cached_dir).exists() {
                return Workspace {
                    dir: PathBuf::from(cached_dir),
                    native: true,
                    reason: "cached WSL-native workspace".into(),
                };
            }
        }
    }

    let probe = (|| -> Result<Workspace, String> {
        let home = Command::new("wsl.exe")
            .args(["-d", wsl_distro, "--", "sh", "-lc", "echo $HOME"])
            .output()
            .map_err(|e| e.to_string())?;
        let wsl_home = String::from_utf8_lossy(&home.stdout).trim().to_string();
        if !home.status.success() || !wsl_home.starts_with('/') {
            return Err("could not read WSL $HOME".into());
        }

        let unc = format!(
            "\\\\wsl.localhost\\{wsl_distro}{}\\.avail-deploy",
            wsl_home.replace('/', "\\")
        );
        fs::create_dir_all(&unc).map_err(|e| e.to_string())?;
        let probe_file = Path::new(&unc).join(".write-probe");
        fs::write(&probe_file, "ok").map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&probe_file);

        fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        fs::write(
            &cache_file,
            serde_json::json!({ "dir": unc, "distro": wsl_distro }).to_string(),
        )
        .map_err(|e| e.to_string())?;

        Ok(Workspace { dir: PathBuf::from(unc), native: true, reason: "WSL-native workspace".into() })
    })();

    probe.unwrap_or_else(|err| Workspace {
        dir: data_dir.to_path_buf(),
        native: false,
        reason: format!("WSL-native workspace unavailable ({err})"),
    })
}

pub fn load() -> Config {
    load_env_file(&root().join(".env"));
    load_env_file(&root().join(".env.local"));

    let data_dir = opt_string("AVAIL_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs_home().join(".avail-deploy"));

    let executor = string(
        "BUILD_EXECUTOR",
        if cfg!(windows) { "wsl" } else { "local" },
    );
    let wsl_distro = string("WSL_DISTRO", "Ubuntu");
    let workspace = resolve_workspace_dir(&data_dir, &executor, &wsl_distro);

    let api_port = num("API_PORT", 3001) as u16;
    let dashboard_port = num("DASHBOARD_PORT", 3000) as u16;

    Config {
        root: root().to_path_buf(),
        env: string("NODE_ENV", "development"),

        api_port,
        proxy_port: num("PROXY_PORT", 3002) as u16,
        dashboard_port,
        host: string("HOST", "127.0.0.1"),

        api_url: opt_string("API_URL").unwrap_or_else(|| format!("http://localhost:{api_port}")),
        dashboard_url: opt_string("DASHBOARD_URL")
            .unwrap_or_else(|| format!("http://localhost:{dashboard_port}")),

        deployment_domain: string("DEPLOYMENT_DOMAIN", "avail.localhost"),
        deployment_scheme: string("DEPLOYMENT_SCHEME", "http"),

        db_file: opt_string("AVAIL_DB_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("avail.db")),
        workspace_is_native: workspace.native,
        workspace_reason: workspace.reason,
        projects_dir: workspace.dir.join("projects"),
        deployments_dir: workspace.dir.join("deployments"),
        cache_dir: workspace.dir.join("cache"),
        workspace_dir: workspace.dir,
        data_dir,

        secret: string("AVAIL_SECRET", "dev-insecure-secret-change-me"),
        allowed_email_domains: string("ALLOWED_EMAIL_DOMAINS", "availproject.org")
            .split(',')
            .map(|d| d.trim().to_lowercase())
            .filter(|d| !d.is_empty())
            .collect(),
        session_ttl_ms: num("SESSION_TTL_DAYS", 30) * 24 * 60 * 60 * 1000,
        login_code_ttl_ms: num("LOGIN_CODE_TTL_MINUTES", 10) * 60 * 1000,
        auth_dev_echo: boolean("AUTH_DEV_ECHO", true),
        cookie_name: string("COOKIE_NAME", "avail_session"),

        smtp_url: opt_string("SMTP_URL"),
        mail_from: string("MAIL_FROM", "Avail Deploy <deploy@availproject.org>"),

        google: GoogleConfig {
            client_id: opt_string("GOOGLE_CLIENT_ID"),
            client_secret: opt_string("GOOGLE_CLIENT_SECRET"),
        },
        github: GithubConfig {
            client_id: opt_string("GITHUB_CLIENT_ID"),
            client_secret: opt_string("GITHUB_CLIENT_SECRET"),
            webhook_secret: opt_string("GITHUB_WEBHOOK_SECRET"),
            api_url: string("GITHUB_API_URL", "https://api.github.com"),
            poll_enabled: boolean("GITHUB_POLL_ENABLED", true),
            poll_interval_ms: num("GITHUB_POLL_INTERVAL_SECONDS", 60) * 1000,
        },

        build: BuildConfig {
            executor,
            wsl_distro,
            concurrency: num("BUILD_CONCURRENCY", 2),
            timeout_ms: num("BUILD_TIMEOUT_MINUTES", 30) * 60 * 1000,
            keep_per_project: num("KEEP_DEPLOYMENTS_PER_PROJECT", 20),
            default_node_version: string("DEFAULT_NODE_VERSION", "22.x"),
        },

        runtime: RuntimeConfig {
            idle_timeout_ms: num("RUNTIME_IDLE_MINUTES", 15) * 60 * 1000,
            boot_timeout_ms: num("RUNTIME_BOOT_TIMEOUT_SECONDS", 90) * 1000,
            port_range_start: num("RUNTIME_PORT_START", 43000) as u16,
            port_range_end: num("RUNTIME_PORT_END", 44000) as u16,
            max_duration_sec: num("FUNCTION_MAX_DURATION", 60),
        },
    }
}

fn dirs_home() -> PathBuf {
    // No `dirs` crate dependency for one lookup: HOME (Unix) / USERPROFILE
    // (Windows), matching Node's `os.homedir()` on both platforms.
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .expect("no home directory in the environment")
}

/// `email` belongs to an allow-listed domain.
pub fn is_email_allowed(config: &Config, email: &str) -> bool {
    match email.rfind('@') {
        None => false,
        Some(at) => {
            let domain = email[at + 1..].to_lowercase();
            config.allowed_email_domains.iter().any(|d| *d == domain)
        }
    }
}

pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}
