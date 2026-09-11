//! Mirrors `apps/builder/src/settings.ts`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::builder::detect::{
    default_install_command, detect_framework, detect_package_manager, find_output_directory,
    get_framework, has_script, read_package_json, run_script_command, server_frameworks,
    PackageManager,
};
use crate::db::types::Project;

/// `avail.json` / `vercel.json` — mirrors `ProjectConfigFile` in
/// `packages/shared/src/types.ts`. Round-trips into the deployment manifest,
/// so unrecognized fields are kept via `extra` rather than dropped.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectConfigFile {
    pub framework: Option<String>,
    #[serde(rename = "buildCommand")]
    pub build_command: Option<String>,
    #[serde(rename = "installCommand")]
    pub install_command: Option<String>,
    #[serde(rename = "outputDirectory")]
    pub output_directory: Option<String>,
    #[serde(rename = "devCommand")]
    pub dev_command: Option<String>,
    #[serde(rename = "rootDirectory")]
    pub root_directory: Option<String>,
    #[serde(rename = "serveMode")]
    pub serve_mode: Option<String>,
    #[serde(rename = "startCommand")]
    pub start_command: Option<String>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, Value>,
}

const CONFIG_FILES: &[&str] = &["avail.json", "vercel.json"];

pub fn read_project_config(dir: &Path) -> Result<ProjectConfigFile, String> {
    for name in CONFIG_FILES {
        let file = dir.join(name);
        if !file.exists() {
            continue;
        }
        let contents = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
        return serde_json::from_str(&contents).map_err(|e| format!("Invalid {name}: {e}"));
    }
    Ok(ProjectConfigFile::default())
}

/// Default boot commands for frameworks served as a long-lived process.
/// `$PORT` and `$HOST` are exported into the process environment.
fn default_start_command(slug: &str) -> Option<&'static str> {
    Some(match slug {
        "nextjs" => "npx --no-install next start --port $PORT --hostname $HOST",
        "blitzjs" => "npx --no-install blitz start --port $PORT",
        "nuxtjs" | "nitro" => "node .output/server/index.mjs",
        "sveltekit" | "sveltekit-1" => "node build/index.js",
        "remix" => "npx --no-install remix-serve ./build/server/index.js",
        "react-router" => "npx --no-install react-router-serve ./build/server/index.js",
        "solidstart-1" | "solidstart" | "tanstack-start" => "node .output/server/index.mjs",
        "hydrogen" => "npx --no-install shopify hydrogen preview --port $PORT",
        "nestjs" => "node dist/main.js",
        "redwoodjs" => "npx --no-install rw serve --port $PORT",
        _ => return None,
    })
}

fn dir_exists(p: &Path) -> bool {
    p.is_dir()
}

pub struct ResolvedBuildSettings {
    pub framework: Option<String>,
    pub root_directory: String,
    pub install_command: Option<String>,
    pub build_command: Option<String>,
    pub output_directory: Option<String>,
    pub serve_mode: String, // "static" | "server"
    pub start_command: Option<String>,
    pub node_version: String,
}

pub struct ResolveOptions<'a> {
    pub repo_dir: &'a Path,
    pub project: &'a Project,
    /// Config file already read from the resolved root directory.
    pub config_file: Option<ProjectConfigFile>,
}

pub struct Resolved {
    pub settings: ResolvedBuildSettings,
    pub config_file: ProjectConfigFile,
    pub work_dir: PathBuf,
    pub package_manager: PackageManager,
    pub detected_framework: Option<String>,
}

/// Merges framework preset, `avail.json`/`vercel.json` and project overrides
/// into the concrete commands used for a build. Project settings win, then
/// the config file, then the detected framework's defaults.
pub fn resolve_settings(options: ResolveOptions<'_>) -> Result<Resolved, String> {
    let project = options.project;

    let root_directory = project
        .root_directory
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| options.config_file.as_ref().and_then(|c| c.root_directory.as_deref()).map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or(".")
        .to_string();
    let work_dir = options.repo_dir.join(&root_directory);
    if !dir_exists(&work_dir) {
        return Err(format!("Root directory \"{root_directory}\" does not exist in the repository"));
    }

    let config_file = match options.config_file {
        Some(c) => c,
        None => read_project_config(&work_dir)?,
    };
    let pkg = read_package_json(&work_dir);
    let package_manager = detect_package_manager(&work_dir);

    let detected = detect_framework(&work_dir);
    let framework_slug = project
        .framework
        .clone()
        .or_else(|| config_file.framework.clone())
        .or_else(|| detected.as_ref().map(|d| d.slug.clone()));
    let preset = get_framework(framework_slug.as_deref());

    let install_command = project
        .install_command
        .clone()
        .or_else(|| config_file.install_command.clone())
        .or_else(|| preset.and_then(|p| p.settings.install_command.clone()))
        .or_else(|| pkg.as_ref().map(|_| default_install_command(package_manager)));

    // Vercel's rule: a `build` script in package.json wins over the preset.
    let preset_build = preset.and_then(|p| p.settings.build_command.clone());
    let build_command = project
        .build_command
        .clone()
        .or_else(|| config_file.build_command.clone())
        .or_else(|| {
            if has_script(pkg.as_ref(), "build") {
                Some(run_script_command(package_manager, "build"))
            } else {
                preset_build.clone()
            }
        });

    let serve_mode = project
        .serve_mode
        .clone()
        .or_else(|| config_file.serve_mode.clone())
        .unwrap_or_else(|| {
            if framework_slug.as_deref().map(|s| server_frameworks().contains(s)).unwrap_or(false) {
                "server".to_string()
            } else {
                "static".to_string()
            }
        });

    let output_directory = project
        .output_directory
        .clone()
        .or_else(|| config_file.output_directory.clone())
        .or_else(|| preset.and_then(|p| p.settings.output_directory.clone()));

    let start_command = if serve_mode == "server" {
        config_file
            .start_command
            .clone()
            .or_else(|| framework_slug.as_deref().and_then(default_start_command).map(str::to_string))
            .or_else(|| {
                if has_script(pkg.as_ref(), "start") {
                    Some(run_script_command(package_manager, "start"))
                } else {
                    None
                }
            })
    } else {
        None
    };

    Ok(Resolved {
        settings: ResolvedBuildSettings {
            framework: framework_slug,
            root_directory,
            install_command,
            build_command,
            output_directory,
            serve_mode,
            start_command,
            node_version: if project.node_version.is_empty() { "22.x".to_string() } else { project.node_version.clone() },
        },
        config_file,
        work_dir,
        package_manager,
        detected_framework: detected.map(|d| d.slug),
    })
}

/// Resolves the static output directory after the build has run, probing
/// the usual candidates when the framework did not declare one.
pub fn resolve_output_directory(work_dir: &Path, declared: Option<&str>, framework_slug: Option<&str>) -> Option<String> {
    if let Some(declared) = declared {
        let abs = work_dir.join(declared);
        return if dir_exists(&abs) { Some(declared.to_string()) } else { None };
    }

    if let Some(preset) = get_framework(framework_slug) {
        if let Some(default_dir) = &preset.default_output_dir_name {
            if dir_exists(&work_dir.join(default_dir)) {
                return Some(default_dir.clone());
            }
        }
    }

    // A Next.js static export lands in `out/`.
    if framework_slug == Some("nextjs") && dir_exists(&work_dir.join("out")) {
        return Some("out".to_string());
    }

    find_output_directory(work_dir)
}
