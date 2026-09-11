//! Mirrors `apps/builder/src/executor.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::builder::paths::{exec_path, sh_quote};

/// `(level, text)`; matches `LogSink` in `executor.ts`. Called from the
/// stdout/stderr-draining tasks, so it must be cheap and thread-safe — the
/// worker's implementation writes straight to SQLite.
pub type LogFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct RunOptions {
    pub command: String,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    /// Where the generated shell script is written — kept out of the git
    /// working tree so it never ends up inside a build.
    pub script_dir: PathBuf,
    pub label: String,
    /// `<= 0` means no timeout — used by long-lived runtime processes.
    pub timeout_ms: i64,
    pub cancel: CancellationToken,
    pub log: LogFn,
}

pub struct RunResult {
    pub code: i32,
    pub timed_out: bool,
    pub aborted: bool,
}

/// Renders a POSIX script that applies the environment and runs `command`.
/// A file (rather than a long `-c` string) keeps quoting sane across the
/// Windows -> wsl.exe -> bash boundary.
pub fn render_script(cfg: &Config, command: &str, cwd: &Path, env: &HashMap<String, String>) -> String {
    let key_re = regex::Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap();
    let mut lines = vec!["#!/usr/bin/env bash".to_string(), "set -euo pipefail".to_string(), String::new()];
    for (key, value) in env {
        if !key_re.is_match(key) {
            continue;
        }
        lines.push(format!("export {key}={}", sh_quote(value)));
    }
    lines.push(String::new());
    lines.push(format!("cd {}", sh_quote(&exec_path(cfg, &cwd.to_string_lossy()))));
    lines.push(String::new());
    lines.push(command.to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn build_spawn(cfg: &Config, script_host_path: &Path) -> (String, Vec<String>) {
    if cfg.build.executor == "wsl" {
        (
            "wsl.exe".to_string(),
            vec![
                "-d".to_string(),
                cfg.build.wsl_distro.clone(),
                "--".to_string(),
                "bash".to_string(),
                exec_path(cfg, &script_host_path.to_string_lossy()),
            ],
        )
    } else {
        ("bash".to_string(), vec![script_host_path.to_string_lossy().to_string()])
    }
}

/// Runs a shell command through the configured executor (`wsl` or `local`),
/// streaming stdout/stderr line by line into `log`.
pub async fn run(cfg: &Config, options: RunOptions) -> std::io::Result<RunResult> {
    std::fs::create_dir_all(&options.script_dir)?;
    let script_path = options.script_dir.join(format!(".avail-{}.sh", options.label));
    std::fs::write(&script_path, render_script(cfg, &options.command, &options.cwd, &options.env))?;

    let (file, args) = build_spawn(cfg, &script_path);
    (options.log)("command", &format!("$ {}", options.command));

    let mut child = Command::new(&file)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let log_out = options.log.clone();
    let log_err = options.log.clone();

    let out_task = tokio::spawn(async move { drain(stdout, "stdout", log_out).await });
    let err_task = tokio::spawn(async move { drain(stderr, "stderr", log_err).await });

    let timeout_ms = if options.timeout_ms > 0 { Some(options.timeout_ms as u64) } else { None };
    let (code, timed_out, aborted) = wait_with_timeout_and_cancel(&mut child, timeout_ms, &options.cancel, &options.log).await;

    let _ = out_task.await;
    let _ = err_task.await;
    let _ = std::fs::remove_file(&script_path);

    Ok(RunResult { code, timed_out, aborted })
}

async fn drain<S: tokio::io::AsyncRead + Unpin>(
    stream: Option<S>,
    level: &'static str,
    log: LogFn,
) {
    let Some(stream) = stream else { return };
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log(level, &line);
    }
}

async fn wait_with_timeout_and_cancel(
    child: &mut Child,
    timeout_ms: Option<u64>,
    cancel: &CancellationToken,
    log: &LogFn,
) -> (i32, bool, bool) {
    let pid = child.id();
    let timeout = timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));

    tokio::select! {
        status = child.wait() => {
            let code = status.map(|s| s.code().unwrap_or(1)).unwrap_or(1);
            (code, false, false)
        }
        _ = cancel.cancelled() => {
            log("warn", "Build canceled");
            if let Some(pid) = pid { kill_pid(pid).await; }
            let _ = child.wait().await;
            (1, false, true)
        }
        _ = async {
            match timeout {
                Some(t) => t.await,
                None => std::future::pending().await,
            }
        } => {
            log("error", &format!("Timed out after {}s", timeout_ms.unwrap_or(0) / 1000));
            if let Some(pid) = pid { kill_pid(pid).await; }
            let _ = child.wait().await;
            (1, true, false)
        }
    }
}

/// Terminates a process tree by pid — `taskkill /t /f` on Windows (needed
/// to reach the `wsl.exe`-fronted command's tree), `SIGTERM` elsewhere.
async fn kill_pid(pid: u32) {
    if cfg!(windows) {
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/t", "/f"])
            .kill_on_drop(false)
            .status()
            .await;
    } else {
        unsafe {
            libc_kill(pid as i32, 15);
        }
    }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, sig);
}

#[cfg(not(unix))]
unsafe fn libc_kill(_pid: i32, _sig: i32) {}

/// Runs a command and returns its trimmed stdout, throwing on failure.
pub async fn capture(cfg: &Config, mut options: RunOptions) -> Result<String, String> {
    let out = Arc::new(std::sync::Mutex::new(String::new()));
    let err = Arc::new(std::sync::Mutex::new(String::new()));
    let out2 = out.clone();
    let err2 = err.clone();
    options.log = Arc::new(move |level, text| {
        if level == "stdout" {
            out2.lock().unwrap().push_str(text);
            out2.lock().unwrap().push('\n');
        } else if level == "stderr" {
            err2.lock().unwrap().push_str(text);
            err2.lock().unwrap().push('\n');
        }
    });
    let command = options.command.clone();
    let result = run(cfg, options).await.map_err(|e| e.to_string())?;
    if result.code != 0 {
        let err_text = err.lock().unwrap().trim().to_string();
        let out_text = out.lock().unwrap().trim().to_string();
        return Err(format!("Command failed ({}): {command}\n{}", result.code, if err_text.is_empty() { out_text } else { err_text }));
    }
    let out_text = out.lock().unwrap().trim().to_string();
    Ok(out_text)
}

/// Verifies the configured executor can run commands at all.
pub async fn check_executor(cfg: &Config) -> (bool, String) {
    let options = RunOptions {
        command: "node --version || echo \"no-node\"".to_string(),
        cwd: cfg.data_dir.clone(),
        env: HashMap::new(),
        script_dir: cfg.cache_dir.clone(),
        label: "doctor".to_string(),
        timeout_ms: 60_000,
        cancel: CancellationToken::new(),
        log: Arc::new(|_, _| {}),
    };
    match capture(cfg, options).await {
        Ok(out) => (!out.contains("no-node"), out),
        Err(e) => (false, e),
    }
}
