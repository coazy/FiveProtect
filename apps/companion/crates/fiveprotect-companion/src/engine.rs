//! The seam between the Rust shell and the C++ scan engine.
//!
//! The engine returns a `SystemSnapshot` as JSON rather than a struct, so the only thing
//! crossing the FFI boundary is bytes. That keeps one contract — the protocol schema —
//! instead of a second, hand-written one that would have to be kept in step with it.
//!
//! Everything unsafe in the companion is in this file.

use std::ffi::{c_char, c_int, CStr, CString};

use fiveprotect_protocol::SystemSnapshot;

/// Return codes from `engine_abi.h`.
const FIVEPROTECT_OK: c_int = 0;
const FIVEPROTECT_ERR_BUFFER_TOO_SMALL: c_int = -1;

/// Enough for a snapshot on an ordinary machine. Growing is handled, this only avoids it.
const INITIAL_BUFFER: usize = 64 * 1024;

/// A refusal to grow without bound. A snapshot this large means the engine is misbehaving.
const MAX_BUFFER: usize = 4 * 1024 * 1024;

extern "C" {
    fn fiveprotect_scan_snapshot_json(
        companion_version: *const c_char,
        companion_build_hash: *const c_char,
        collected_at_iso: *const c_char,
        buffer: *mut c_char,
        buffer_size: usize,
        written: *mut usize,
    ) -> c_int;

    fn fiveprotect_engine_version() -> *const c_char;
}

#[derive(Debug)]
pub enum ScanError {
    /// One of the strings handed in contained a NUL byte.
    Argument(&'static str),
    /// The engine returned a failure code.
    Engine(c_int),
    /// The engine asked for more room than this build is willing to give it.
    TooLarge(usize),
    /// The engine produced bytes that are not a snapshot.
    Malformed(String),
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Argument(name) => write!(f, "{name} is not a valid C string"),
            Self::Engine(code) => write!(f, "the scan engine failed with code {code}"),
            Self::TooLarge(size) => write!(f, "the scan engine asked for {size} bytes"),
            Self::Malformed(detail) => write!(f, "the scan engine produced no snapshot: {detail}"),
        }
    }
}

impl std::error::Error for ScanError {}

/// Version string the engine was built as.
#[must_use]
pub fn version() -> String {
    // SAFETY: the engine returns a pointer to a static string literal with static lifetime,
    // and the ABI documents it as never null.
    #[allow(unsafe_code)]
    let raw = unsafe { fiveprotect_engine_version() };
    if raw.is_null() {
        return "unknown".to_owned();
    }
    // SAFETY: non-null and NUL terminated, as above.
    #[allow(unsafe_code)]
    let text = unsafe { CStr::from_ptr(raw) };
    text.to_string_lossy().into_owned()
}

/// Runs every probe and parses the result.
///
/// The timestamp comes from the caller rather than the engine: the shell is what the backend
/// compares against, and two clocks that disagree by a second would be a puzzle nobody wants
/// to debug from a support ticket.
pub fn scan(
    companion_version: &str,
    build_hash: &str,
    collected_at: &str,
) -> Result<SystemSnapshot, ScanError> {
    let version_c =
        CString::new(companion_version).map_err(|_| ScanError::Argument("companion_version"))?;
    let hash_c = CString::new(build_hash).map_err(|_| ScanError::Argument("build_hash"))?;
    let time_c = CString::new(collected_at).map_err(|_| ScanError::Argument("collected_at"))?;

    let mut capacity = INITIAL_BUFFER;

    loop {
        let mut buffer = vec![0u8; capacity];
        let mut written: usize = 0;

        // SAFETY: the three inputs are NUL-terminated and outlive the call. `buffer` is a
        // live allocation of exactly `capacity` bytes and `written` is a live usize. The
        // engine is documented never to retain any of these pointers.
        #[allow(unsafe_code)]
        let code = unsafe {
            fiveprotect_scan_snapshot_json(
                version_c.as_ptr(),
                hash_c.as_ptr(),
                time_c.as_ptr(),
                buffer.as_mut_ptr().cast::<c_char>(),
                capacity,
                &mut written,
            )
        };

        match code {
            FIVEPROTECT_OK => {
                buffer.truncate(written);
                let json = String::from_utf8(buffer)
                    .map_err(|error| ScanError::Malformed(error.to_string()))?;
                return serde_json::from_str(&json)
                    .map_err(|error| ScanError::Malformed(error.to_string()));
            }
            FIVEPROTECT_ERR_BUFFER_TOO_SMALL => {
                // `written` holds the required size. One byte of headroom for the NUL the
                // engine writes but does not count.
                let required = written.saturating_add(1);
                if required > MAX_BUFFER || required <= capacity {
                    return Err(ScanError::TooLarge(required));
                }
                capacity = required;
            }
            other => return Err(ScanError::Engine(other)),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_reports_a_version() {
        let reported = version();
        assert!(!reported.is_empty(), "engine version must not be empty");
    }

    #[test]
    fn a_scan_produces_a_snapshot_for_this_machine() {
        // Runs the real probes. What they find depends on the machine, so this asserts the
        // contract rather than the content: the shell's own values come back unchanged and
        // the snapshot parses against the generated protocol type.
        let hash = "a".repeat(64);
        let snapshot = scan("0.1.0", &hash, "2026-08-04T12:00:00Z").expect("scan succeeds");

        assert_eq!(snapshot.companion_version, "0.1.0");
        assert_eq!(snapshot.companion_build_hash, hash);
        assert_eq!(snapshot.collected_at, "2026-08-04T12:00:00Z");
        assert_eq!(snapshot.schema_version, 1);
    }

    #[test]
    fn a_snapshot_never_carries_a_verdict() {
        // ADR 0004 at the FFI boundary. The engine reports what it found; if a field named
        // like an outcome ever appears in its JSON, this fails.
        let hash = "b".repeat(64);
        let snapshot = scan("0.1.0", &hash, "2026-08-04T12:00:00Z").expect("scan succeeds");
        let json = serde_json::to_string(&snapshot).expect("serializes");

        for forbidden in ["\"clean\"", "\"passed\"", "\"verdict\"", "\"allow\""] {
            assert!(
                !json.contains(forbidden),
                "snapshot must not contain {forbidden}"
            );
        }
    }

    #[test]
    fn a_string_with_a_nul_byte_is_refused_rather_than_truncated() {
        let result = scan("0.1.0\0evil", &"c".repeat(64), "2026-08-04T12:00:00Z");
        assert!(
            matches!(result, Err(ScanError::Argument("companion_version"))),
            "{result:?}"
        );
    }
}
