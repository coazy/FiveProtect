//! What the "Diagnose speichern" button does.
//!
//! A player who is blocked and does not understand why needs one file to hand to support.
//! This writes it somewhere they will find it — the desktop — rather than leaving them to
//! navigate to `%LOCALAPPDATA%`.
//!
//! It contains the log and a fresh scan of the machine. It does not contain a nonce, a
//! session id or anything else that would still be usable by whoever the file is forwarded
//! to; a diagnostics file ends up in a public Discord more often than anywhere else.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::{engine, identity, log, settings};

const FILE_NAME: &str = "FiveProtect-Diagnose.txt";

/// Writes the file and returns where it went.
pub fn export() -> io::Result<PathBuf> {
    export_into(&desktop())
}

/// The part that composes the file, with the directory handed in.
///
/// Split out for the tests: `export` always writes the same path, so two tests calling it at
/// once raced each other — one deleted the file the other was still reading. Each test now
/// gets its own directory, and no test writes to the developer's actual desktop.
fn export_into(dir: &Path) -> io::Result<PathBuf> {
    let target = dir.join(FILE_NAME);
    let mut file = std::fs::File::create(&target)?;

    writeln!(file, "FiveProtect Diagnose")?;
    writeln!(file, "Erstellt: {}", identity::now_iso())?;
    writeln!(file, "Version: {}", fiveprotect_core::VERSION)?;
    writeln!(file, "Scan-Engine: {}", engine::version())?;

    match identity::build_hash() {
        Ok(hash) => writeln!(file, "Build-Hash: {hash}")?,
        Err(error) => writeln!(file, "Build-Hash: nicht lesbar ({error})")?,
    }

    let settings = settings::Settings::load();
    writeln!(file, "Backends: {}", settings.allowed_backends.join(", "))?;

    writeln!(file, "\n--- Systemprüfung ---")?;
    match engine::scan(fiveprotect_core::VERSION, &"0".repeat(64), &identity::now_iso()) {
        Ok(snapshot) => {
            // Pretty-printed rather than the wire form: this is read by a person, and the
            // one-line JSON the backend receives is unreadable at the width of a chat window.
            match serde_json::to_string_pretty(&snapshot) {
                Ok(text) => writeln!(file, "{text}")?,
                Err(error) => writeln!(file, "konnte nicht formatiert werden: {error}")?,
            }
        }
        Err(error) => writeln!(file, "Systemprüfung fehlgeschlagen: {error}")?,
    }

    writeln!(file, "\n--- Protokoll ---")?;
    match log::path().map(std::fs::read_to_string) {
        Some(Ok(text)) => writeln!(file, "{text}")?,
        Some(Err(error)) => writeln!(file, "Protokoll nicht lesbar: {error}")?,
        None => writeln!(file, "Kein Protokollpfad")?,
    }

    file.flush()?;
    Ok(target)
}

/// The user's desktop, or their profile directory, or the temp directory.
///
/// Three fallbacks because the only thing worse than a file in an odd place is a button that
/// reports failure to a player who is already stuck.
fn desktop() -> PathBuf {
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        let desktop = profile.join("Desktop");
        if desktop.is_dir() {
            return desktop;
        }
        return profile;
    }
    std::env::temp_dir()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// A directory of this test's own, so two tests never write the same file.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fiveprotect-diagnostics-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_export_lands_somewhere_and_says_where() {
        let dir = scratch("lands");
        let path = export_into(&dir).expect("diagnostics are written");
        assert!(path.is_file(), "{}", path.display());

        let text = std::fs::read_to_string(&path).expect("readable");
        assert!(text.contains("FiveProtect Diagnose"), "header missing");
        assert!(text.contains("--- Systemprüfung ---"), "scan section missing");
        assert!(text.contains("osBuild"), "the snapshot is not in the file");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_desktop_fallback_names_a_directory_that_exists() {
        // The button must not fail on a machine without a Desktop folder — a profile
        // directory or the temp directory will do, but it has to be somewhere writable.
        assert!(desktop().is_dir(), "{}", desktop().display());
    }

    #[test]
    fn the_export_adds_no_secret_of_its_own() {
        // What this file can hold is decided where things are written, not here: it embeds
        // the log, and a log on a real machine carries whatever earlier runs put there. So
        // the rule is enforced at the source — `worker::short_session` for the session id,
        // and the fact that no call site ever passes a nonce to the log at all. What is
        // checked here is the part `export` itself composes.
        let dir = scratch("no-secret");
        let path = export_into(&dir).expect("diagnostics are written");
        let text = std::fs::read_to_string(&path).expect("readable");

        let composed = text.split("--- Protokoll ---").next().unwrap_or_default();

        assert!(
            !composed.contains("nonce"),
            "the diagnostics header and snapshot must not mention a nonce"
        );
        assert!(
            !composed.contains("sessionId"),
            "the diagnostics header and snapshot must not carry a session id"
        );

        // The scan is run with a placeholder hash rather than the real one, because the
        // snapshot in this file is a picture of the machine and not an attestation.
        assert!(composed.contains(&"0".repeat(64)), "placeholder hash missing");

        std::fs::remove_dir_all(&dir).ok();
    }
}
