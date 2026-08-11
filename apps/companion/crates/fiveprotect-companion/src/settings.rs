//! Which backends this companion will talk to.
//!
//! The list is the companion's only defence against being pointed somewhere else: the
//! backend URL arrives from the game client, which is untrusted, and without an allow-list a
//! local process could aim the system snapshot at a server of its choosing (`fiveprotect_core::local`).
//!
//! A file next to the executable can extend the compiled-in list. That is not a weakening:
//! anyone who can write that file can also replace the executable, and the build hash the
//! backend pins is computed from the executable, so a swapped binary is refused anyway. It
//! exists because a server operator running their own deployment needs to name it, and
//! shipping a rebuilt companion per customer is not a product.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The production backend, compiled in so the shipped build works with no file at all.
const BUILT_IN: &[&str] = &["https://api.fiveprotect.dev"];

/// Read from next to the executable, if present.
const FILE_NAME: &str = "fiveprotect.json";

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsFile {
    #[serde(default)]
    allowed_backends: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Settings {
    /// Origins the companion will send a snapshot to. Never empty.
    pub allowed_backends: Vec<String>,
    /// Where the extra entries came from, for the log line at start-up.
    pub source: Option<PathBuf>,
}

impl Settings {
    /// Loads the compiled-in list plus anything the file next to the executable adds.
    #[must_use]
    pub fn load() -> Self {
        let path = match std::env::current_exe() {
            Ok(exe) => exe.parent().map(|dir| dir.join(FILE_NAME)),
            Err(_) => None,
        };

        match path {
            Some(file) if file.is_file() => Self::from_file(&file),
            _ => Self::built_in(),
        }
    }

    fn built_in() -> Self {
        Self {
            allowed_backends: BUILT_IN.iter().map(|entry| (*entry).to_owned()).collect(),
            source: None,
        }
    }

    fn from_file(path: &Path) -> Self {
        let mut settings = Self::built_in();

        let Ok(text) = std::fs::read_to_string(path) else {
            return settings;
        };
        let Ok(parsed) = serde_json::from_str::<SettingsFile>(&text) else {
            // A malformed file leaves the compiled-in list in place rather than emptying it.
            // Refusing to start would turn a typo into a machine that cannot play anywhere.
            return settings;
        };

        settings.allowed_backends.extend(parsed.allowed_backends);
        settings.allowed_backends.sort_unstable();
        settings.allowed_backends.dedup();
        settings.source = Some(path.to_path_buf());
        settings
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_list_is_never_empty() {
        // An empty list would refuse every backend, which looks like a broken companion
        // rather than a misconfiguration.
        assert!(!Settings::built_in().allowed_backends.is_empty());
    }

    #[test]
    fn a_file_extends_the_list_rather_than_replacing_it() {
        let dir = std::env::temp_dir().join(format!("fiveprotect-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(FILE_NAME);
        std::fs::write(&file, r#"{"allowedBackends":["http://127.0.0.1:8080"]}"#).unwrap();

        let settings = Settings::from_file(&file);
        assert!(settings
            .allowed_backends
            .contains(&"http://127.0.0.1:8080".to_owned()));
        for built_in in BUILT_IN {
            assert!(settings.allowed_backends.contains(&(*built_in).to_owned()));
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_file_leaves_the_compiled_in_list_intact() {
        let dir = std::env::temp_dir().join(format!("fiveprotect-broken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(FILE_NAME);
        std::fs::write(&file, "{ not json").unwrap();

        assert_eq!(
            Settings::from_file(&file).allowed_backends,
            Settings::built_in().allowed_backends
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
