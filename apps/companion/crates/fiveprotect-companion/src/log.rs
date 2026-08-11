//! The companion's log.
//!
//! The shipped build has no console — a black window flashing up behind the UI looks like a
//! crashed installer — so a line that goes only to stderr goes nowhere. Support requests
//! arrive as "it says blocked and I don't know why", and the answer is in this file.
//!
//! What it must never contain: the nonce. It is a bearer secret for its thirty seconds, and
//! a log is the one artefact a player will happily paste into a public Discord.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

use crate::identity;

/// Truncated at this size on start-up. Enough for several sessions, small enough to attach.
const MAX_BYTES: u64 = 512 * 1024;

static SINK: OnceLock<Option<Mutex<File>>> = OnceLock::new();

/// Where the log lives. Under the user's own profile, so no elevation is needed.
#[must_use]
pub fn path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(|| {
        // Not Windows, or a stripped environment. The temp directory is a poor log location
        // but a better one than dropping the diagnostics entirely.
        Some(std::env::temp_dir())
    })?;
    Some(base.join("FiveProtect").join("companion.log"))
}

fn sink() -> Option<&'static Mutex<File>> {
    SINK.get_or_init(|| {
        let file = path()?;
        std::fs::create_dir_all(file.parent()?).ok()?;

        // One generation back is kept. A player who restarts the companion before asking for
        // help would otherwise hand over a log that begins after the interesting part.
        if std::fs::metadata(&file).is_ok_and(|meta| meta.len() > MAX_BYTES) {
            std::fs::rename(&file, file.with_extension("log.1")).ok();
        }

        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .ok()
            .map(Mutex::new)
    })
    .as_ref()
}

/// Writes one line, to the log file and to stderr.
///
/// stderr as well because a developer running the debug build from a terminal should not
/// have to go looking for a file, and because a build started from a console still has one.
pub fn line(message: &str) {
    let stamped = format!("{} {message}", identity::now_iso());

    eprintln!("[FiveProtect] {message}");

    if let Some(handle) = sink() {
        if let Ok(mut file) = handle.lock() {
            writeln!(file, "{stamped}").ok();
            file.flush().ok();
        }
    }
}

/// `log::line` with formatting, so call sites read like `println!`.
macro_rules! logline {
    ($($arg:tt)*) => {
        $crate::log::line(&format!($($arg)*))
    };
}

pub(crate) use logline;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_log_goes_somewhere_writable() {
        let file = path().expect("a log path is always resolvable");
        assert!(
            file.ends_with("FiveProtect/companion.log") || file.ends_with(r"FiveProtect\companion.log"),
            "{}",
            file.display()
        );
    }

    #[test]
    fn writing_a_line_does_not_fail_even_twice() {
        // Every call site treats logging as infallible. If it can panic, a disk that filled
        // up takes the companion down with it.
        line("test: erste Zeile");
        line("test: zweite Zeile");
    }
}
