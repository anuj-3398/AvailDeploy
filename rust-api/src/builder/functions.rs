//! Mirrors `apps/builder/src/functions.ts`.

use std::path::Path;

use serde::Serialize;

const FUNCTION_EXTENSIONS: &[&str] = &["js", "mjs", "cjs", "ts", "mts"];
const IGNORED_DIRS: &[&str] = &["node_modules", ".git", "_middleware", "__tests__"];

#[derive(Debug, Clone, Serialize)]
pub struct FunctionEntry {
    pub route: String,
    pub file: String,
    pub runtime: &'static str,
    #[serde(rename = "maxDuration")]
    pub max_duration: i64,
}

/// Discovers serverless functions under `<work_dir>/api`, following
/// Vercel's file-system routing: `api/users/[id].ts` serves `/api/users/[id]`.
pub fn discover_functions(work_dir: &Path, max_duration_default: i64) -> Vec<FunctionEntry> {
    let api_dir = work_dir.join("api");
    if !api_dir.is_dir() {
        return Vec::new();
    }

    let mut entries = Vec::new();
    walk(&api_dir, "/api", work_dir, max_duration_default, &mut entries);

    // Static routes before dynamic ones, and longer paths before shorter.
    entries.sort_by(|a, b| {
        let dynamic_a = a.route.contains('[') as i32;
        let dynamic_b = b.route.contains('[') as i32;
        if dynamic_a != dynamic_b {
            return dynamic_a.cmp(&dynamic_b);
        }
        let catch_all_a = a.route.contains("[...") as i32;
        let catch_all_b = b.route.contains("[...") as i32;
        if catch_all_a != catch_all_b {
            return catch_all_a.cmp(&catch_all_b);
        }
        b.route.len().cmp(&a.route.len())
    });
    entries
}

fn walk(dir: &Path, prefix: &str, work_dir: &Path, max_duration_default: i64, out: &mut Vec<FunctionEntry>) {
    let Ok(read_dir) = std::fs::read_dir(dir) else { return };
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        let abs = entry.path();
        let Ok(meta) = entry.metadata() else { continue };

        if meta.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&abs, &format!("{prefix}/{name}"), work_dir, max_duration_default, out);
            continue;
        }

        let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !FUNCTION_EXTENSIONS.contains(&ext) {
            continue;
        }
        if is_test_or_declaration(&name) {
            continue;
        }

        let base = &name[..name.len() - ext.len() - 1];
        let route = if base == "index" { prefix.to_string() } else { format!("{prefix}/{base}") };
        let file = abs.strip_prefix(work_dir).unwrap_or(&abs).to_string_lossy().replace('\\', "/");

        out.push(FunctionEntry {
            route: if route.is_empty() { "/api".to_string() } else { route },
            file,
            runtime: "nodejs",
            max_duration: max_duration_default,
        });
    }
}

/// `.test.ts` / `.spec.ts` / `.d.ts` (and the `.cts`/`.mts` variants).
fn is_test_or_declaration(name: &str) -> bool {
    for suffix in [".test.ts", ".spec.ts", ".d.ts", ".test.cts", ".spec.cts", ".d.cts", ".test.mts", ".spec.mts", ".d.mts"] {
        if name.ends_with(suffix) {
            return true;
        }
    }
    false
}
