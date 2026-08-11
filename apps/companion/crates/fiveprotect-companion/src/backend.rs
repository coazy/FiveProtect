//! Everything the companion says to the backend.
//!
//! Three calls and no more: collect a nonce, report a snapshot, report in. None of them
//! returns a verdict — the companion is a sensor, and a sensor that could read its own
//! result would be an oracle an attacker could test modifications against (ADR 0004).

use std::time::Duration;

use fiveprotect_protocol::{
    AttestationAck, AttestationRequest, CompanionOutcomeRequest, CompanionPollRequest,
    CompanionPollResponse, HeartbeatRequest, HeartbeatResponse, Verdict,
    COMPANION_POLL_TIMEOUT_SECONDS, PROTOCOL_VERSION,
};

/// Headroom over the long poll, so the client gives up after the server does rather than
/// before it — a client that times out first turns every idle wait into a failed request.
const READ_TIMEOUT_HEADROOM: Duration = Duration::from_secs(10);

/// Short, because a backend that has not accepted a connection by now is not going to.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug)]
pub enum BackendError {
    /// The backend could not be reached at all.
    Unreachable(String),
    /// The backend answered with a status this call does not expect.
    Status { code: u16, code_text: String },
    /// The answer did not match the protocol.
    Malformed(String),
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(detail) => write!(f, "backend unreachable: {detail}"),
            Self::Status { code, code_text } => write!(f, "backend answered {code} ({code_text})"),
            Self::Malformed(detail) => write!(f, "backend answer did not parse: {detail}"),
        }
    }
}

impl std::error::Error for BackendError {}

/// A nonce waiting for this machine.
///
/// The policy tier the backend also returns is deliberately dropped here. The companion
/// scans the same way regardless of tier — which measurements matter is the backend's
/// question, and a companion that knew the answer could tailor what it reports.
#[derive(Debug, Clone)]
pub struct Pending {
    pub nonce: String,
    pub server_name: Option<String>,
}

#[derive(Debug)]
pub struct Client {
    base_url: String,
    agent: ureq::Agent,
    companion_version: String,
}

impl Client {
    #[must_use]
    pub fn new(base_url: &str, companion_version: &str) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(CONNECT_TIMEOUT)
            .timeout_read(
                Duration::from_secs(u64::from(COMPANION_POLL_TIMEOUT_SECONDS))
                    + READ_TIMEOUT_HEADROOM,
            )
            .user_agent(&format!("FiveProtect/{companion_version}"))
            .build();

        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            agent,
            companion_version: companion_version.to_owned(),
        }
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Asks whether a player on this machine is connecting somewhere.
    ///
    /// The backend holds the request open for up to `wait_seconds`, so an ordinary idle call
    /// takes that long and returns nothing. `Ok(None)` is the common case, not a failure.
    pub fn poll_pending(&self, wait_seconds: i64) -> Result<Option<Pending>, BackendError> {
        let body = CompanionPollRequest {
            companion_version: self.companion_version.clone(),
            wait_seconds,
            protocol_version: i64::from(PROTOCOL_VERSION),
        };

        let answer: CompanionPollResponse = self.post("/v1/companion/pending", &body)?;
        answer.validate().map_err(BackendError::Malformed)?;

        match answer.nonce {
            Some(nonce) if answer.pending => Ok(Some(Pending {
                nonce,
                server_name: answer.server_name,
            })),
            _ => Ok(None),
        }
    }

    /// Reports the snapshot. The answer confirms receipt and says nothing about the outcome.
    pub fn attest(&self, request: &AttestationRequest) -> Result<AttestationAck, BackendError> {
        let ack: AttestationAck = self.post("/v1/attest", request)?;
        ack.validate().map_err(BackendError::Malformed)?;
        Ok(ack)
    }

    /// How the attestation this companion filed was judged.
    ///
    /// `Ok(None)` means the verdict is still forming — the resource's own poll decides it,
    /// and this call simply arrived first. ADR 0011 explains why the companion is allowed to
    /// ask at all: the same text is put in front of the player by the connect screen anyway.
    pub fn outcome(&self, session_id: &str, wait_seconds: i64) -> Result<Option<Verdict>, BackendError> {
        let body = CompanionOutcomeRequest {
            session_id: session_id.to_owned(),
            wait_seconds,
            protocol_version: i64::from(PROTOCOL_VERSION),
        };

        let (status, value) = self.post_raw("/v1/companion/outcome", &body)?;

        // 202 carries a ProtocolError, not a verdict, so the shape has to be decided by the
        // status before anything is parsed into a Verdict.
        if status == 202 {
            return Ok(None);
        }

        let verdict: Verdict =
            serde_json::from_value(value).map_err(|error| BackendError::Malformed(error.to_string()))?;
        verdict.validate().map_err(BackendError::Malformed)?;
        Ok(Some(verdict))
    }

    /// Keeps a session alive while the player is in game.
    pub fn heartbeat(&self, request: &HeartbeatRequest) -> Result<HeartbeatResponse, BackendError> {
        let response: HeartbeatResponse = self.post("/v1/sessions/heartbeat", request)?;
        response.validate().map_err(BackendError::Malformed)?;
        Ok(response)
    }

    fn post<B: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<R, BackendError> {
        let (_, value) = self.post_raw(path, body)?;
        serde_json::from_value(value).map_err(|error| BackendError::Malformed(error.to_string()))
    }

    /// The status alongside the body, for the one call whose answer shape depends on it.
    fn post_raw<B: serde::Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<(u16, serde_json::Value), BackendError> {
        let url = format!("{}{path}", self.base_url);

        match self.agent.post(&url).send_json(body) {
            Ok(response) => {
                let status = response.status();
                let value = response
                    .into_json::<serde_json::Value>()
                    .map_err(|error| BackendError::Malformed(error.to_string()))?;
                Ok((status, value))
            }
            Err(ureq::Error::Status(code, response)) => {
                // The body carries a ProtocolError. Its code is worth keeping for the log;
                // its message is for operators and is not shown to the player.
                let code_text = response
                    .into_json::<serde_json::Value>()
                    .ok()
                    .and_then(|value| {
                        value.get("code").and_then(|code| code.as_str().map(str::to_owned))
                    })
                    .unwrap_or_else(|| "unknown".to_owned());
                Err(BackendError::Status { code, code_text })
            }
            Err(transport) => Err(BackendError::Unreachable(transport.to_string())),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_base_url_loses_its_trailing_slash() {
        // Otherwise every request would be built as `https://host//v1/attest`, which some
        // proxies normalise and some answer with a redirect the client will not follow.
        let client = Client::new("https://api.fiveprotect.dev/", "0.1.0");
        assert_eq!(client.base_url(), "https://api.fiveprotect.dev");
    }

    #[test]
    fn an_unreachable_backend_is_an_error_and_not_a_panic() {
        // Port 1 on loopback refuses immediately. The companion runs on a machine where the
        // network is whatever the player's router feels like today, so every path out of
        // here has to be a value.
        let client = Client::new("http://127.0.0.1:1", "0.1.0");
        let result = client.poll_pending(0);
        assert!(matches!(result, Err(BackendError::Unreachable(_))), "{result:?}");
    }
}
