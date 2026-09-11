//! Mirrors `packages/shared/src/logger.ts`'s output shape
//! (`HH:MM:SS.mmm LEVEL [scope] message`) so this process's lines read the
//! same as the Node services it runs alongside under `npm run dev`.

use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy)]
pub struct Logger {
    pub scope: &'static str,
}

pub fn scoped(scope: &'static str) -> Logger {
    Logger { scope }
}

fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs_today = now.as_secs() % 86_400;
    let millis = now.subsec_millis();
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        secs_today / 3600,
        (secs_today % 3600) / 60,
        secs_today % 60,
        millis
    )
}

impl Logger {
    fn emit(&self, level: &str, message: &str) {
        println!("{} {:<5} [{}] {}", timestamp(), level, self.scope, message);
    }

    pub fn info(&self, message: impl AsRef<str>) {
        self.emit("INFO", message.as_ref());
    }

    pub fn warn(&self, message: impl AsRef<str>) {
        self.emit("WARN", message.as_ref());
    }

    pub fn error(&self, message: impl AsRef<str>) {
        self.emit("ERROR", message.as_ref());
    }
}
