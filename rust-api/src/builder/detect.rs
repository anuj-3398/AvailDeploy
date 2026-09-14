//! Mirrors `packages/frameworks/src/index.ts` in full — this is the
//! detection algorithm the builder actually needs (`rust-api`'s own
//! `frameworks.rs` only serves the summary list for `GET /api/frameworks`).
//! Reads the *same* `frameworks.json` Node does — one source of truth.

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct DetectionItem {
    pub path: Option<String>,
    #[serde(rename = "matchPackage")]
    pub match_package: Option<String>,
    #[serde(rename = "matchContent")]
    pub match_content: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Detectors {
    #[serde(default)]
    pub every: Vec<DetectionItem>,
    #[serde(default)]
    pub some: Vec<DetectionItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FrameworkSettings {
    #[serde(rename = "installCommand")]
    pub install_command: Option<String>,
    #[serde(rename = "buildCommand")]
    pub build_command: Option<String>,
    #[serde(rename = "devCommand")]
    pub dev_command: Option<String>,
    #[serde(rename = "outputDirectory")]
    pub output_directory: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FrameworkPreset {
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub detectors: Detectors,
    pub settings: FrameworkSettings,
    #[serde(rename = "defaultOutputDirName")]
    pub default_output_dir_name: Option<String>,
    pub supersedes: Option<Vec<String>>,
    #[serde(default)]
    pub experimental: bool,
}

fn frameworks() -> &'static Vec<FrameworkPreset> {
    static FRAMEWORKS: OnceLock<Vec<FrameworkPreset>> = OnceLock::new();
    FRAMEWORKS.get_or_init(|| {
        // `env!("CARGO_MANIFEST_DIR")` is `rust-api/`; the data file is a
        // repo-root-relative sibling, same file `@avail/frameworks` reads.
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("rust-api/ has a parent")
            .join("packages/frameworks/src/frameworks.json");
        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&contents).unwrap_or_default()
    })
}

/// Frameworks whose output is a long-lived HTTP server rather than a folder
/// of static assets. These are booted as a managed process behind the proxy.
pub fn server_frameworks() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "nextjs", "blitzjs", "nuxtjs", "remix", "react-router", "redwoodjs", "sveltekit",
            "sveltekit-1", "solidstart", "solidstart-1", "nitro", "nestjs", "express", "fastify",
            "koa", "hono", "h3", "elysia", "hydrogen", "tanstack-start", "tanstack-start-lovable",
            "node", "bun", "container", "mastra", "xmcp",
        ]
        .into_iter()
        .collect()
    })
}

/// Output directories probed when a framework declares none.
const DEFAULT_OUTPUT_CANDIDATES: &[&str] = &["dist", "build", "out", "public", "_site", "output", ".output/public"];

pub fn get_framework(slug: Option<&str>) -> Option<&'static FrameworkPreset> {
    let slug = slug?;
    frameworks().iter().find(|f| f.slug == slug)
}

fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

struct CheckResult {
    matched: bool,
    version: Option<String>,
}

fn check_item(dir: &Path, item: &DetectionItem) -> CheckResult {
    let file_path = item.path.clone().unwrap_or_else(|| "package.json".to_string());
    let abs = dir.join(&file_path);
    if !abs.exists() {
        return CheckResult { matched: false, version: None };
    }

    let match_content = if let Some(pkg) = &item.match_package {
        Some(format!(
            r#""(dev)?(d|D)ependencies":\s*\{{[^}}]*"{}":\s*"(.+?)"[^}}]*\}}"#,
            escape_regex(pkg)
        ))
    } else {
        item.match_content.clone()
    };

    match match_content {
        None => CheckResult { matched: true, version: None },
        Some(pattern) => {
            let Ok(content) = std::fs::read_to_string(&abs) else {
                return CheckResult { matched: false, version: None };
            };
            let Ok(re) = regex::RegexBuilder::new(&pattern).multi_line(true).build() else {
                return CheckResult { matched: false, version: None };
            };
            match re.captures(&content) {
                None => CheckResult { matched: false, version: None },
                Some(caps) => CheckResult {
                    matched: true,
                    version: if item.match_package.is_some() {
                        caps.get(3).map(|m| m.as_str().to_string())
                    } else {
                        None
                    },
                },
            }
        }
    }
}

pub struct DetectionResult {
    pub slug: String,
}

/// Detects the framework used by the project rooted at `dir`, mirroring
/// Vercel's `detect-framework` algorithm (every/some detectors + supersedes).
pub fn detect_framework(dir: &Path) -> Option<DetectionResult> {
    let mut matched: Vec<&'static FrameworkPreset> = Vec::new();

    for preset in frameworks() {
        if preset.experimental {
            continue;
        }
        if preset.detectors.every.is_empty() && preset.detectors.some.is_empty() {
            continue;
        }

        let mut ok = true;
        for item in &preset.detectors.every {
            if !check_item(dir, item).matched {
                ok = false;
                break;
            }
        }
        if ok && !preset.detectors.some.is_empty() {
            ok = preset.detectors.some.iter().any(|item| check_item(dir, item).matched);
        }
        if ok {
            matched.push(preset);
        }
    }

    if matched.is_empty() {
        return None;
    }

    // A framework that supersedes another wins (e.g. SvelteKit over Vite).
    let mut superseded: HashSet<&str> = HashSet::new();
    for m in &matched {
        if let Some(list) = &m.supersedes {
            for s in list {
                superseded.insert(s.as_str());
            }
        }
    }
    let winner = matched.iter().find(|m| !superseded.contains(m.slug.as_str())).unwrap_or(&matched[0]);

    Some(DetectionResult { slug: winner.slug.clone() })
}

/// Picks the first existing directory from a list of candidates.
pub fn find_output_directory(dir: &Path) -> Option<String> {
    DEFAULT_OUTPUT_CANDIDATES.iter().find(|c| dir.join(c).is_dir()).map(|c| c.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManager {
    Npm,
    Yarn,
    Pnpm,
    Bun,
}

/// Infers the package manager from the lockfile present in `dir`.
pub fn detect_package_manager(dir: &Path) -> PackageManager {
    if dir.join("pnpm-lock.yaml").exists() {
        PackageManager::Pnpm
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        PackageManager::Bun
    } else if dir.join("yarn.lock").exists() {
        PackageManager::Yarn
    } else {
        PackageManager::Npm
    }
}

/// Default install command for a package manager. Dev dependencies are
/// forced on: build tooling almost always lives there, and package managers
/// omit them when `NODE_ENV=production`.
pub fn default_install_command(pm: PackageManager) -> String {
    match pm {
        PackageManager::Pnpm => "pnpm install --no-frozen-lockfile --prod=false".to_string(),
        PackageManager::Yarn => "yarn install --production=false".to_string(),
        PackageManager::Bun => "bun install".to_string(),
        PackageManager::Npm => "npm install --no-audit --no-fund --include=dev".to_string(),
    }
}

/// `npm run build`, `pnpm run build`, ...
pub fn run_script_command(pm: PackageManager, script: &str) -> String {
    match pm {
        PackageManager::Npm => format!("npm run {script}"),
        PackageManager::Yarn => format!("yarn run {script}"),
        PackageManager::Pnpm => format!("pnpm run {script}"),
        PackageManager::Bun => format!("bun run {script}"),
    }
}

pub fn read_package_json(dir: &Path) -> Option<serde_json::Value> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn has_script(pkg: Option<&serde_json::Value>, name: &str) -> bool {
    pkg.and_then(|p| p.get("scripts")).and_then(|s| s.get(name)).is_some()
}

