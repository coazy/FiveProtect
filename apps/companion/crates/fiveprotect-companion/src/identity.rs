//! What the companion says about itself.
//!
//! The build hash is the load-bearing part: the backend compares it against the list of
//! accepted builds, and it is repeated on every heartbeat so a binary swapped mid-session is
//! visible. It is therefore computed from the file on disk at every start, never baked in —
//! a constant would be a value an attacker could keep truthful while changing everything
//! around it.

use std::fs::File;
use std::io::{self, Read};
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use time::format_description::BorrowedFormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

/// 64 KiB at a time. The binary is a few megabytes and there is no reason to hold it whole.
const CHUNK: usize = 64 * 1024;

/// Milliseconds, always UTC, always with the `Z`. What the protocol's datetime format wants.
const TIMESTAMP: &[BorrowedFormatItem<'_>] = format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
);

/// SHA-256 of the running executable, lowercase hex.
pub fn build_hash() -> io::Result<String> {
    let path = std::env::current_exe()?;
    hash_file(&path)
}

fn hash_file(path: &PathBuf) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Now, in the shape the protocol declares.
#[must_use]
pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(TIMESTAMP)
        // A formatting failure here would mean the format description itself is wrong, which
        // is a build-time mistake rather than a runtime one. Falling back to the epoch keeps
        // the companion running and makes the mistake obvious in the backend's logs.
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_owned())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_build_hash_is_a_sha256_of_the_running_binary() {
        let hash = build_hash().expect("hashes the test binary");
        assert_eq!(hash.len(), 64, "{hash}");
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn the_build_hash_is_stable_across_calls() {
        assert_eq!(build_hash().unwrap(), build_hash().unwrap());
    }

    #[test]
    fn the_timestamp_matches_what_the_protocol_accepts() {
        let stamp = now_iso();
        // The same shape check the generated protocol runs, spelled out so a change to the
        // format description fails here rather than at the backend.
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(stamp.ends_with('Z'), "{stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
        assert_eq!(&stamp[19..20], ".");
    }
}
