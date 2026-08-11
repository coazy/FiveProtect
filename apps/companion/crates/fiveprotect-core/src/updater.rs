//! The signed auto-updater.
//!
//! Design document 10 puts this in phase 1 for one reason: in a race against cheat
//! developers, the ability to ship a fix within hours matters more than any single
//! detection — and an updater cannot be retrofitted without abandoning the first version
//! that shipped without one.
//!
//! The trust anchor is an Ed25519 public key compiled into the binary. A manifest is
//! accepted only if its signature verifies against that key and the downloaded file matches
//! the hash the manifest names. Both checks, in that order, every time.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// A release, as published by the update server.
///
/// The signature covers the canonical serialization of everything except itself. Signing
/// the fields rather than the file means a re-encoded manifest still verifies, and a
/// manifest with one field swapped does not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateManifest {
    pub version: String,
    /// SHA-256 of the installer, lowercase hex.
    pub sha256: String,
    pub url: String,
    /// Rollout channel. A build only accepts manifests for the channel it was built for.
    pub channel: String,
    /// Percentage of installations that should take this update, 0 to 100.
    ///
    /// Staged rollout from design document 10: a bad update reaches a slice of the player
    /// base rather than all of it.
    pub rollout_percent: u8,
    /// Ed25519 signature over the signing payload, base64 or hex.
    pub signature: String,
}

impl UpdateManifest {
    /// The exact bytes the signature covers.
    ///
    /// Field order is fixed here rather than taken from a serializer, because a serializer
    /// that reorders fields between versions would invalidate every published signature.
    pub fn signing_payload(&self) -> Vec<u8> {
        format!(
            "fiveprotect-update-v1\n{}\n{}\n{}\n{}\n{}",
            self.version, self.sha256, self.url, self.channel, self.rollout_percent
        )
        .into_bytes()
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum UpdateError {
    #[error("the manifest signature is not valid")]
    BadSignature,

    #[error("the signature field could not be decoded")]
    MalformedSignature,

    #[error("the downloaded file does not match the hash in the manifest")]
    HashMismatch,

    #[error("the manifest is for channel {theirs}, this build follows {ours}")]
    WrongChannel { theirs: String, ours: String },

    #[error("the manifest offers {offered}, which is not newer than {current}")]
    NotNewer { offered: String, current: String },

    #[error("the version {0} is not a version number")]
    MalformedVersion(String),

    #[error("the download URL is not one this build will fetch from")]
    UntrustedUrl,
}

/// What this build will accept an update from.
#[derive(Debug, Clone)]
pub struct UpdatePolicy {
    pub current_version: String,
    pub channel: String,
    /// Origin the installer must be downloaded from, for example `https://dist.fiveprotect.dev`.
    pub download_origin: String,
    /// Stable per-installation number, 0 to 99, deciding whether this machine is in the
    /// current rollout slice.
    pub rollout_bucket: u8,
}

/// Whether a manifest should be acted on.
///
/// Verification comes first and unconditionally. A manifest that fails any check is not
/// "skipped for now" — it is refused, and the companion keeps running the version it has.
pub fn evaluate_manifest(
    manifest: &UpdateManifest,
    policy: &UpdatePolicy,
    public_key: &VerifyingKey,
) -> Result<bool, UpdateError> {
    verify_signature(manifest, public_key)?;

    if manifest.channel != policy.channel {
        return Err(UpdateError::WrongChannel {
            theirs: manifest.channel.clone(),
            ours: policy.channel.clone(),
        });
    }

    if !is_same_origin(&manifest.url, &policy.download_origin) {
        return Err(UpdateError::UntrustedUrl);
    }

    let offered = parse_version(&manifest.version)?;
    let current = parse_version(&policy.current_version)?;
    if offered <= current {
        return Err(UpdateError::NotNewer {
            offered: manifest.version.clone(),
            current: policy.current_version.clone(),
        });
    }

    // Staged rollout. A machine outside the slice is not an error — it takes the update once
    // the percentage grows.
    Ok(policy.rollout_bucket < manifest.rollout_percent)
}

/// Checks the manifest signature against the key compiled into this build.
pub fn verify_signature(
    manifest: &UpdateManifest,
    public_key: &VerifyingKey,
) -> Result<(), UpdateError> {
    let raw = decode_signature(&manifest.signature).ok_or(UpdateError::MalformedSignature)?;
    let bytes: [u8; 64] = raw
        .try_into()
        .map_err(|_| UpdateError::MalformedSignature)?;
    let signature = Signature::from_bytes(&bytes);

    public_key
        .verify(&manifest.signing_payload(), &signature)
        .map_err(|_| UpdateError::BadSignature)
}

/// Confirms a downloaded file is the one the manifest described.
///
/// The signature proves the manifest is ours; this proves the bytes are the ones it named.
/// Neither check is sufficient alone: a valid signature over a manifest pointing at a
/// swapped file would otherwise install the swapped file.
pub fn verify_download(contents: &[u8], manifest: &UpdateManifest) -> Result<(), UpdateError> {
    let digest = Sha256::digest(contents);
    let actual = hex::encode(digest);
    if actual.eq_ignore_ascii_case(&manifest.sha256) {
        Ok(())
    } else {
        Err(UpdateError::HashMismatch)
    }
}

fn decode_signature(value: &str) -> Option<Vec<u8>> {
    if let Ok(bytes) = hex::decode(value) {
        return Some(bytes);
    }
    base64_decode(value)
}

/// Minimal standard-alphabet base64 decoder.
///
/// One dependency fewer on a code path that must keep working for the lifetime of every
/// shipped build — an updater that cannot parse its own manifest cannot fix itself.
fn base64_decode(value: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let trimmed = value.trim_end_matches('=');
    let mut out = Vec::with_capacity(trimmed.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0_u32;

    for byte in trimmed.bytes() {
        let index = ALPHABET.iter().position(|candidate| *candidate == byte)? as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }

    Some(out)
}

/// Semantic version as a comparable triple.
fn parse_version(value: &str) -> Result<(u32, u32, u32), UpdateError> {
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let mut parts = core.split('.');
    let mut next = || -> Option<u32> { parts.next()?.parse().ok() };

    match (next(), next(), next()) {
        (Some(major), Some(minor), Some(patch)) => Ok((major, minor, patch)),
        _ => Err(UpdateError::MalformedVersion(value.to_owned())),
    }
}

/// Exact origin comparison, not a prefix match.
fn is_same_origin(url: &str, origin: &str) -> bool {
    fn origin_of(value: &str) -> Option<String> {
        let lowered = value.trim().to_ascii_lowercase();
        let (scheme, rest) = lowered
            .strip_prefix("https://")
            .map(|rest| ("https", rest))
            .or_else(|| lowered.strip_prefix("http://").map(|rest| ("http", rest)))?;
        let authority = rest.split(['/', '?', '#']).next()?;
        if authority.is_empty() {
            return None;
        }
        Some(format!("{scheme}://{authority}"))
    }

    match (origin_of(url), origin_of(origin)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn signing_key() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    fn manifest(key: &SigningKey, version: &str) -> UpdateManifest {
        let mut manifest = UpdateManifest {
            version: version.to_owned(),
            sha256: "a".repeat(64),
            url: "https://dist.fiveprotect.dev/fiveprotect-setup.exe".to_owned(),
            channel: "stable".to_owned(),
            rollout_percent: 100,
            signature: String::new(),
        };
        manifest.signature = hex::encode(key.sign(&manifest.signing_payload()).to_bytes());
        manifest
    }

    fn policy() -> UpdatePolicy {
        UpdatePolicy {
            current_version: "0.1.0".to_owned(),
            channel: "stable".to_owned(),
            download_origin: "https://dist.fiveprotect.dev".to_owned(),
            rollout_bucket: 0,
        }
    }

    #[test]
    fn accepts_a_newer_signed_release() {
        let key = signing_key();
        let manifest = manifest(&key, "0.2.0");
        assert_eq!(
            evaluate_manifest(&manifest, &policy(), &key.verifying_key()),
            Ok(true)
        );
    }

    #[test]
    fn refuses_a_manifest_signed_by_someone_else() {
        // The whole point of the updater: an attacker who controls the network still cannot
        // make the companion install their build.
        let ours = signing_key();
        let theirs = signing_key();
        let manifest = manifest(&theirs, "0.2.0");

        assert_eq!(
            evaluate_manifest(&manifest, &policy(), &ours.verifying_key()),
            Err(UpdateError::BadSignature)
        );
    }

    #[test]
    fn refuses_a_manifest_whose_fields_were_edited_after_signing() {
        let key = signing_key();

        for edit in [
            |m: &mut UpdateManifest| m.url = "https://dist.fiveprotect.dev/other.exe".to_owned(),
            |m: &mut UpdateManifest| m.sha256 = "b".repeat(64),
            |m: &mut UpdateManifest| m.version = "9.9.9".to_owned(),
            |m: &mut UpdateManifest| m.rollout_percent = 100,
            |m: &mut UpdateManifest| m.channel = "beta".to_owned(),
        ] {
            let mut tampered = manifest(&key, "0.2.0");
            tampered.rollout_percent = 50;
            tampered.signature = hex::encode(key.sign(&tampered.signing_payload()).to_bytes());
            edit(&mut tampered);

            assert_eq!(
                evaluate_manifest(&tampered, &policy(), &key.verifying_key()),
                Err(UpdateError::BadSignature),
                "an edited manifest must not verify"
            );
        }
    }

    #[test]
    fn refuses_a_signature_that_is_not_a_signature() {
        let key = signing_key();
        for bad in ["", "zz", &"a".repeat(10), "not-base64-or-hex!!"] {
            let mut broken = manifest(&key, "0.2.0");
            broken.signature = bad.to_owned();
            let result = evaluate_manifest(&broken, &policy(), &key.verifying_key());
            assert!(
                matches!(
                    result,
                    Err(UpdateError::MalformedSignature) | Err(UpdateError::BadSignature)
                ),
                "signature {bad:?} gave {result:?}"
            );
        }
    }

    #[test]
    fn accepts_a_base64_signature_as_well_as_hex() {
        let key = signing_key();
        let mut manifest = manifest(&key, "0.2.0");
        let raw = key.sign(&manifest.signing_payload()).to_bytes();
        manifest.signature = base64_encode(&raw);

        assert_eq!(
            evaluate_manifest(&manifest, &policy(), &key.verifying_key()),
            Ok(true)
        );
    }

    #[test]
    fn refuses_a_download_from_another_origin() {
        // A signed manifest is still not permission to fetch from anywhere.
        let key = signing_key();
        let mut manifest = manifest(&key, "0.2.0");
        manifest.url = "https://dist.fiveprotect.dev.evil.example/setup.exe".to_owned();
        manifest.signature = hex::encode(key.sign(&manifest.signing_payload()).to_bytes());

        assert_eq!(
            evaluate_manifest(&manifest, &policy(), &key.verifying_key()),
            Err(UpdateError::UntrustedUrl)
        );
    }

    #[test]
    fn refuses_a_manifest_for_another_channel() {
        let key = signing_key();
        let mut manifest = manifest(&key, "0.2.0");
        manifest.channel = "beta".to_owned();
        manifest.signature = hex::encode(key.sign(&manifest.signing_payload()).to_bytes());

        assert!(matches!(
            evaluate_manifest(&manifest, &policy(), &key.verifying_key()),
            Err(UpdateError::WrongChannel { .. })
        ));
    }

    #[test]
    fn refuses_to_go_backwards() {
        // A downgrade is how an attacker reintroduces a fixed weakness.
        let key = signing_key();
        for version in ["0.0.9", "0.1.0"] {
            let manifest = manifest(&key, version);
            assert!(
                matches!(
                    evaluate_manifest(&manifest, &policy(), &key.verifying_key()),
                    Err(UpdateError::NotNewer { .. })
                ),
                "version {version} should be refused"
            );
        }
    }

    #[test]
    fn honours_the_rollout_slice() {
        // Staged rollout from design document 10: a bad update reaches a slice, not everyone.
        let key = signing_key();
        let mut manifest = manifest(&key, "0.2.0");
        manifest.rollout_percent = 10;
        manifest.signature = hex::encode(key.sign(&manifest.signing_payload()).to_bytes());

        let inside = UpdatePolicy {
            rollout_bucket: 5,
            ..policy()
        };
        let outside = UpdatePolicy {
            rollout_bucket: 50,
            ..policy()
        };

        assert_eq!(
            evaluate_manifest(&manifest, &inside, &key.verifying_key()),
            Ok(true)
        );
        // Outside the slice is not an error: this machine updates when the percentage grows.
        assert_eq!(
            evaluate_manifest(&manifest, &outside, &key.verifying_key()),
            Ok(false)
        );
    }

    #[test]
    fn verifies_the_downloaded_bytes_as_well_as_the_manifest() {
        // A valid signature over a manifest pointing at a swapped file would otherwise
        // install the swapped file.
        let contents = b"the real installer";
        let mut manifest = UpdateManifest {
            version: "0.2.0".to_owned(),
            sha256: hex::encode(Sha256::digest(contents)),
            url: "https://dist.fiveprotect.dev/setup.exe".to_owned(),
            channel: "stable".to_owned(),
            rollout_percent: 100,
            signature: String::new(),
        };

        assert_eq!(verify_download(contents, &manifest), Ok(()));
        assert_eq!(
            verify_download(b"a different installer", &manifest),
            Err(UpdateError::HashMismatch)
        );

        manifest.sha256 = manifest.sha256.to_uppercase();
        assert_eq!(
            verify_download(contents, &manifest),
            Ok(()),
            "hex case must not matter"
        );
    }

    #[test]
    fn rejects_an_unparseable_version() {
        let key = signing_key();
        let manifest = manifest(&key, "next");
        assert!(matches!(
            evaluate_manifest(&manifest, &policy(), &key.verifying_key()),
            Err(UpdateError::MalformedVersion(_))
        ));
    }

    #[test]
    fn compares_versions_numerically_not_lexically() {
        assert_eq!(parse_version("0.10.0").unwrap(), (0, 10, 0));
        assert!(parse_version("0.10.0").unwrap() > parse_version("0.9.0").unwrap());
        assert_eq!(parse_version("1.2.3-beta.1").unwrap(), (1, 2, 3));
    }

    fn base64_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let value = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for index in 0..4 {
                if index <= chunk.len() {
                    out.push(ALPHABET[((value >> (18 - index * 6)) & 0x3F) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }
}
