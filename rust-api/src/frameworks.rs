//! `GET /api/frameworks` reads the exact same data file
//! `packages/frameworks/src/frameworks.json` that `@avail/frameworks`
//! (Node, unchanged) reads — one source of truth, no risk of the two lists
//! drifting apart. Only the list-serving shape is ported here; framework
//! *detection* (`packages/frameworks/src/index.ts`'s matching algorithm) is
//! Phase 2, used by the not-yet-ported `routes/projects.ts`.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize)]
struct FrameworkSettings {
    #[serde(rename = "installCommand")]
    install_command: Option<String>,
    #[serde(rename = "buildCommand")]
    build_command: Option<String>,
    #[serde(rename = "devCommand")]
    dev_command: Option<String>,
    #[serde(rename = "outputDirectory")]
    output_directory: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FrameworkPreset {
    name: String,
    slug: String,
    logo: Option<String>,
    settings: FrameworkSettings,
    #[serde(rename = "defaultOutputDirName")]
    default_output_dir_name: Option<String>,
    #[serde(default)]
    experimental: bool,
}

#[derive(Debug, Serialize)]
pub struct FrameworkSummary {
    pub slug: String,
    pub name: String,
    pub logo: Option<String>,
    #[serde(rename = "buildCommand")]
    pub build_command: Option<String>,
    #[serde(rename = "installCommand")]
    pub install_command: Option<String>,
    #[serde(rename = "outputDirectory")]
    pub output_directory: Option<String>,
    #[serde(rename = "devCommand")]
    pub dev_command: Option<String>,
}

pub fn load(repo_root: &Path) -> Vec<FrameworkSummary> {
    let path = repo_root.join("packages/frameworks/src/frameworks.json");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let presets: Vec<FrameworkPreset> = match serde_json::from_str(&contents) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    presets
        .into_iter()
        .filter(|f| !f.experimental && !f.slug.is_empty())
        .map(|f| FrameworkSummary {
            slug: f.slug,
            name: f.name,
            logo: f.logo,
            build_command: f.settings.build_command,
            install_command: f.settings.install_command,
            output_directory: f.settings.output_directory.or(f.default_output_dir_name),
            dev_command: f.settings.dev_command,
        })
        .collect()
}
