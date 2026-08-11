//! Rust half of the protocol contract tests.
//!
//! Reads the same fixtures TypeScript, C++ and Lua read. Deserialization proves the shape
//! and `validate()` proves the content; a fixture must be accepted or rejected here exactly
//! as it is in the other three languages.

// The workspace warns on these so the shipped companion has no hidden panic paths. A test
// that cannot read its own fixtures has nothing useful to do but fail loudly.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(missing_debug_implementations)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use fiveprotect_protocol as protocol;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures")
}

fn read_fixture(relative: &str) -> Value {
    let path = fixtures_dir().join(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not valid JSON: {error}", path.display()))
}

#[derive(Debug)]
struct Entry {
    schema: String,
    file: String,
    note: String,
}

fn entries(key: &str) -> Vec<Entry> {
    let index = read_fixture("index.json");
    index[key]
        .as_array()
        .unwrap_or_else(|| panic!("fixtures/index.json has no array named {key}"))
        .iter()
        .map(|item| Entry {
            schema: item["schema"].as_str().unwrap_or_default().to_owned(),
            file: item["file"].as_str().unwrap_or_default().to_owned(),
            note: item["note"]
                .as_str()
                .or_else(|| item["reason"].as_str())
                .unwrap_or_default()
                .to_owned(),
        })
        .collect()
}

/// Outcome of feeding one payload through deserialization and validation.
enum Outcome {
    Accepted(Value),
    Rejected(String),
}

/// Deserialize, validate, then serialize back so the round trip is part of the check.
fn run<T>(input: &Value) -> Outcome
where
    T: DeserializeOwned + serde::Serialize + Validated,
{
    let parsed: T = match serde_json::from_value(input.clone()) {
        Ok(parsed) => parsed,
        Err(error) => return Outcome::Rejected(error.to_string()),
    };
    if let Err(error) = parsed.validate_self() {
        return Outcome::Rejected(error);
    }
    match serde_json::to_value(&parsed) {
        Ok(value) => Outcome::Accepted(value),
        Err(error) => Outcome::Rejected(error.to_string()),
    }
}

/// Lets the dispatch table treat every message uniformly. The generated `validate` methods
/// are inherent rather than trait methods, so this thin trait adapts them.
trait Validated {
    fn validate_self(&self) -> Result<(), String>;
}

macro_rules! validated {
    ($($type:ty),* $(,)?) => {
        $(impl Validated for $type {
            fn validate_self(&self) -> Result<(), String> { self.validate() }
        })*
    };
}

validated!(
    protocol::SystemSnapshot,
    protocol::NonceRequest,
    protocol::NonceResponse,
    protocol::AttestationRequest,
    protocol::AttestationAck,
    protocol::Verdict,
    protocol::LocalAttestCommand,
    protocol::LocalAttestAck,
    protocol::HeartbeatRequest,
    protocol::HeartbeatResponse,
    protocol::LivenessResponse,
    protocol::CompanionOutcomeRequest,
    protocol::CompanionPollRequest,
    protocol::CompanionPollResponse,
    protocol::ProtocolError,
);

fn dispatch(schema: &str, input: &Value) -> Option<Outcome> {
    Some(match schema {
        "SystemSnapshot" => run::<protocol::SystemSnapshot>(input),
        "NonceRequest" => run::<protocol::NonceRequest>(input),
        "NonceResponse" => run::<protocol::NonceResponse>(input),
        "AttestationRequest" => run::<protocol::AttestationRequest>(input),
        "AttestationAck" => run::<protocol::AttestationAck>(input),
        "Verdict" => run::<protocol::Verdict>(input),
        "LocalAttestCommand" => run::<protocol::LocalAttestCommand>(input),
        "LocalAttestAck" => run::<protocol::LocalAttestAck>(input),
        "HeartbeatRequest" => run::<protocol::HeartbeatRequest>(input),
        "HeartbeatResponse" => run::<protocol::HeartbeatResponse>(input),
        "LivenessResponse" => run::<protocol::LivenessResponse>(input),
        "ProtocolError" => run::<protocol::ProtocolError>(input),
        "CompanionOutcomeRequest" => run::<protocol::CompanionOutcomeRequest>(input),
        "CompanionPollRequest" => run::<protocol::CompanionPollRequest>(input),
        "CompanionPollResponse" => run::<protocol::CompanionPollResponse>(input),
        // Nested-only structs are exercised through their parent message.
        _ => return None,
    })
}

#[test]
fn valid_fixtures_are_accepted_and_round_trip_unchanged() {
    for entry in entries("valid") {
        let input = read_fixture(&entry.file);
        let Some(outcome) = dispatch(&entry.schema, &input) else {
            continue;
        };
        match outcome {
            Outcome::Accepted(output) => assert_eq!(
                output, input,
                "{} changed while round tripping through Rust",
                entry.file
            ),
            Outcome::Rejected(error) => {
                panic!("{} should be valid ({}) but was rejected: {error}", entry.file, entry.note)
            }
        }
    }
}

#[test]
fn invalid_fixtures_are_rejected() {
    for entry in entries("invalid") {
        let input = read_fixture(&entry.file);
        let Some(outcome) = dispatch(&entry.schema, &input) else {
            continue;
        };
        match outcome {
            Outcome::Rejected(error) => assert!(
                !error.is_empty(),
                "{} must explain the rejection",
                entry.file
            ),
            Outcome::Accepted(_) => {
                panic!("{} should have been rejected — {}", entry.file, entry.note)
            }
        }
    }
}

#[test]
fn a_snapshot_cannot_smuggle_a_judgement() {
    // ADR 0004 in executable form: `deny_unknown_fields` means an invented field is an
    // error rather than something serde quietly drops.
    let mut snapshot = read_fixture("valid/system-snapshot-full.json");
    for smuggled in ["clean", "passed", "verdict", "isLegit", "trusted"] {
        snapshot[smuggled] = Value::Bool(true);
        let result: Result<protocol::SystemSnapshot, _> = serde_json::from_value(snapshot.clone());
        assert!(result.is_err(), "a companion never sends `{smuggled}`");
        snapshot.as_object_mut().expect("object").remove(smuggled);
    }
}

#[test]
fn enum_wire_names_match_the_schema() {
    for tier in protocol::PolicyTier::ALL {
        let encoded = serde_json::to_string(&tier).expect("serialize");
        assert_eq!(encoded, format!("\"{}\"", tier.as_wire_str()));
    }
    assert_eq!(protocol::FailMode::FailOpen.as_wire_str(), "fail_open");
    assert_eq!(protocol::DenyReason::NetworkOriginMismatch.as_wire_str(), "network_origin_mismatch");
}

#[test]
fn every_message_in_the_index_has_a_handler_or_is_nested() {
    // Guards against a new message arriving in the schemas without the Rust side learning
    // about it. Nested-only structs are listed explicitly so adding one is a deliberate act.
    let nested_only: BTreeSet<&str> = [
        "SecurityFeatures",
        "TpmInfo",
        "GameProcessEvidence",
        "AttestationQuote",
        "PlayerIdentifiers",
        "RequirementResult",
    ]
    .into_iter()
    .collect();

    for name in protocol::SCHEMA_NAMES {
        let handled = dispatch(name, &read_fixture("valid/local-attest-ack.json")).is_some();
        assert!(
            handled || nested_only.contains(name),
            "{name} has neither a handler nor an entry in the nested-only list"
        );
    }
}

#[test]
fn validate_rejects_what_the_type_system_cannot() {
    let mut response: protocol::NonceResponse =
        serde_json::from_value(read_fixture("valid/nonce-response.json")).expect("fixture parses");
    assert!(response.validate().is_ok());

    response.nonce = "abcd".to_owned();
    let error = response.validate().expect_err("short nonce is refused");
    assert!(error.contains("shorter than 64"), "unexpected message: {error}");

    response.nonce = "z".repeat(64);
    let error = response.validate().expect_err("non-hex nonce is refused");
    assert!(error.contains("hex"), "unexpected message: {error}");
}
