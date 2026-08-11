//! The localhost endpoint.
//!
//! ADR 0003. The companion binds `127.0.0.1` on a port from a fixed range and the FiveM NUI
//! finds it. This module holds the contract — what the endpoint accepts, what it answers,
//! and what it refuses — separately from the HTTP server that serves it, so the interesting
//! decisions are testable without opening a socket.
//!
//! The endpoint is built to be useless to anyone but the game client. Any local process can
//! reach `127.0.0.1`; CORS protects browsers, not native code. So it accepts exactly one
//! command, answers with an acknowledgement, and returns no data at all. A hostile local
//! program can trigger an attestation and learn nothing from it.

use fiveprotect_protocol::{LocalAttestAck, LocalAttestCommand, PROTOCOL_VERSION};
use thiserror::Error;

/// Why a request to the localhost endpoint was refused.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RejectReason {
    #[error("only POST /attest is accepted")]
    WrongRoute,

    #[error("the body was not valid JSON: {0}")]
    Malformed(String),

    #[error("the command did not satisfy the protocol: {0}")]
    Invalid(String),

    #[error("protocol version {theirs} is not supported, this build speaks {ours}")]
    VersionMismatch { theirs: i64, ours: i64 },

    #[error("the backend URL is not one this build will talk to")]
    UntrustedBackend,
}

/// What the endpoint should do with a request.
#[derive(Debug, PartialEq)]
pub enum Accepted {
    /// Start an attestation for this command.
    Attest(Box<LocalAttestCommand>),
}

/// Decides what to do with a request to the endpoint.
///
/// Pure: no socket, no clock, no filesystem. Every refusal path below is a case a hostile
/// local process will eventually try.
pub fn handle_request(
    method: &str,
    path: &str,
    body: &str,
    allowed_backends: &[String],
) -> Result<Accepted, RejectReason> {
    // One route, one method. Anything else is either a mistake or a probe.
    if !method.eq_ignore_ascii_case("POST") || path.trim_end_matches('/') != "/attest" {
        return Err(RejectReason::WrongRoute);
    }

    let command: LocalAttestCommand =
        serde_json::from_str(body).map_err(|error| RejectReason::Malformed(error.to_string()))?;

    // Shape first, then content. `validate` is generated from the same schema the backend
    // validates against, so a nonce that would be rejected there is rejected here too —
    // before it costs a scan.
    command.validate().map_err(RejectReason::Invalid)?;

    if command.protocol_version != i64::from(PROTOCOL_VERSION) {
        return Err(RejectReason::VersionMismatch {
            theirs: command.protocol_version,
            ours: i64::from(PROTOCOL_VERSION),
        });
    }

    // The backend URL arrives from the game client, which is untrusted. Without this check a
    // local process could point the companion — and with it the system snapshot — at a
    // server of its choosing.
    if !is_allowed_backend(&command.backend_url, allowed_backends) {
        return Err(RejectReason::UntrustedBackend);
    }

    Ok(Accepted::Attest(Box::new(command)))
}

/// The acknowledgement, which is the only thing the endpoint ever returns.
///
/// Deliberately free of any result: telling the caller whether the check passed would hand
/// an attacker a local oracle to test modifications against.
pub fn acknowledgement(companion_version: &str) -> LocalAttestAck {
    LocalAttestAck {
        accepted: true,
        companion_version: companion_version.to_owned(),
        protocol_version: i64::from(PROTOCOL_VERSION),
    }
}

/// Whether a backend URL is one this build will send a snapshot to.
///
/// Exact origin match, not a prefix: `https://api.fiveprotect.dev.attacker.example` starts with
/// the trusted origin and must not pass.
fn is_allowed_backend(candidate: &str, allowed: &[String]) -> bool {
    let Some(origin) = origin_of(candidate) else {
        return false;
    };
    allowed
        .iter()
        .filter_map(|entry| origin_of(entry))
        .any(|trusted| trusted == origin)
}

/// Scheme, host and port of a URL, lowercased. `None` when it is not an absolute http URL.
fn origin_of(url: &str) -> Option<String> {
    let lowered = url.trim().to_ascii_lowercase();
    let rest = lowered
        .strip_prefix("https://")
        .map(|rest| ("https", rest))
        .or_else(|| lowered.strip_prefix("http://").map(|rest| ("http", rest)));

    let (scheme, rest) = rest?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn trusted() -> Vec<String> {
        vec!["https://api.fiveprotect.dev".to_owned()]
    }

    fn command_json(nonce: &str, backend: &str, version: i64) -> String {
        format!(r#"{{"nonce":"{nonce}","backendUrl":"{backend}","protocolVersion":{version}}}"#)
    }

    fn valid_nonce() -> String {
        "a".repeat(64)
    }

    #[test]
    fn accepts_a_well_formed_command() {
        let body = command_json(&valid_nonce(), "https://api.fiveprotect.dev", 1);
        let result = handle_request("POST", "/attest", &body, &trusted());
        assert!(matches!(result, Ok(Accepted::Attest(_))), "{result:?}");
    }

    #[test]
    fn accepts_a_trailing_slash_but_nothing_else() {
        let body = command_json(&valid_nonce(), "https://api.fiveprotect.dev", 1);
        assert!(handle_request("POST", "/attest/", &body, &trusted()).is_ok());
        assert_eq!(
            handle_request("POST", "/attest/extra", &body, &trusted()),
            Err(RejectReason::WrongRoute)
        );
    }

    #[test]
    fn refuses_every_other_route_and_method() {
        let body = command_json(&valid_nonce(), "https://api.fiveprotect.dev", 1);
        for (method, path) in [
            ("GET", "/attest"),
            ("GET", "/"),
            ("POST", "/status"),
            ("POST", "/snapshot"),
            ("DELETE", "/attest"),
            ("OPTIONS", "/attest"),
        ] {
            assert_eq!(
                handle_request(method, path, &body, &trusted()),
                Err(RejectReason::WrongRoute),
                "{method} {path} should be refused"
            );
        }
    }

    #[test]
    fn refuses_a_body_that_is_not_json() {
        let result = handle_request("POST", "/attest", "not json", &trusted());
        assert!(
            matches!(result, Err(RejectReason::Malformed(_))),
            "{result:?}"
        );
    }

    #[test]
    fn refuses_a_nonce_that_is_the_wrong_shape() {
        // The same check the backend runs, run here first so a malformed nonce does not cost
        // a full system scan.
        for nonce in ["short", &"z".repeat(64), &"a".repeat(63)] {
            let body = command_json(nonce, "https://api.fiveprotect.dev", 1);
            let result = handle_request("POST", "/attest", &body, &trusted());
            assert!(
                matches!(result, Err(RejectReason::Invalid(_))),
                "nonce {nonce:?} should be refused, got {result:?}"
            );
        }
    }

    #[test]
    fn refuses_a_protocol_version_it_does_not_speak() {
        let body = command_json(&valid_nonce(), "https://api.fiveprotect.dev", 99);
        assert_eq!(
            handle_request("POST", "/attest", &body, &trusted()),
            Err(RejectReason::VersionMismatch {
                theirs: 99,
                ours: 1
            })
        );
    }

    #[test]
    fn refuses_a_backend_the_build_does_not_trust() {
        // The URL comes from the game client, which is untrusted. Without this a local
        // process could point the snapshot at a server of its choosing.
        for backend in [
            "https://evil.example",
            "http://api.fiveprotect.dev",
            "https://api.fiveprotect.dev.evil.example",
            "https://evil.example/?x=https://api.fiveprotect.dev",
            "",
            "not a url",
        ] {
            let body = command_json(&valid_nonce(), backend, 1);
            assert_eq!(
                handle_request("POST", "/attest", &body, &trusted()),
                Err(RejectReason::UntrustedBackend),
                "backend {backend:?} should be refused"
            );
        }
    }

    #[test]
    fn matches_a_trusted_backend_regardless_of_path_or_case() {
        for backend in [
            "https://api.fiveprotect.dev",
            "https://API.fiveprotect.dev",
            "https://api.fiveprotect.dev/",
            "https://api.fiveprotect.dev/v1/attest",
        ] {
            let body = command_json(&valid_nonce(), backend, 1);
            assert!(
                handle_request("POST", "/attest", &body, &trusted()).is_ok(),
                "backend {backend:?} should be accepted"
            );
        }
    }

    #[test]
    fn distinguishes_ports() {
        let allowed = vec!["http://127.0.0.1:8080".to_owned()];
        let ok = command_json(&valid_nonce(), "http://127.0.0.1:8080", 1);
        let wrong = command_json(&valid_nonce(), "http://127.0.0.1:9090", 1);

        assert!(handle_request("POST", "/attest", &ok, &allowed).is_ok());
        assert_eq!(
            handle_request("POST", "/attest", &wrong, &allowed),
            Err(RejectReason::UntrustedBackend)
        );
    }

    #[test]
    fn the_acknowledgement_carries_no_result() {
        let ack = acknowledgement("0.1.0");
        let json = serde_json::to_value(&ack).expect("serializes");
        let object = json.as_object().expect("is an object");

        // ADR 0004 in executable form. If a field is ever added here that implies an
        // outcome, this fails.
        let mut fields: Vec<&str> = object.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(fields, ["accepted", "companionVersion", "protocolVersion"]);
    }

    #[test]
    fn the_port_range_matches_the_protocol() {
        assert_eq!(crate::PORT_RANGE_START, 52800);
        assert_eq!(crate::PORT_RANGE_END, 52899);
        assert_eq!(crate::port_range().count(), 100);
    }
}
