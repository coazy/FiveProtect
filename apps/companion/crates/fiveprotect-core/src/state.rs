//! The window's state machine.
//!
//! Four states and no more (design document 12.1). This module owns which one the window
//! shows; the window itself only renders. Keeping the transitions here rather than in
//! JavaScript means the rule that matters — a client cannot put itself into `Ready` —
//! is enforced in the same place that talks to the backend.

use fiveprotect_protocol::{RequirementId, RequirementStatus};
use serde::{Deserialize, Serialize};

/// What the window shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowState {
    /// Waiting for a server. Nothing to do.
    Idle,
    /// A scan is running. Indeterminate progress — there is no honest percentage.
    Checking,
    /// The backend accepted the attestation and the player may connect.
    Ready,
    /// The backend refused. The window shows the reason and what to do about it.
    Blocked,
}

/// Things that can happen to the companion.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The NUI delivered a nonce.
    AttestRequested,
    /// The backend acknowledged the attestation.
    AttestationAccepted,
    /// The backend refused the attestation, or it never completed.
    Refused { remediation: Option<String> },
    /// The session ended, or the player disconnected.
    SessionEnded,
    /// The attestation could not be delivered at all.
    Failed { remediation: Option<String> },
}

/// One line of the window's list of checks.
///
/// These are the companion's own measurements, not the server's judgement of them. The
/// distinction matters: the companion is never told which requirements the server applied or
/// how it weighed them (ADR 0004), and everything shown here is state a local process could
/// read from the registry anyway. It is here so a blocked player can see *which* setting is
/// off instead of being told only that something is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCheck {
    pub requirement: RequirementId,
    pub status: RequirementStatus,
}

/// The window model, as sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowView {
    pub state: WindowState,
    /// Local measurements, in the order the window lists them. Empty until a scan has run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requirements: Vec<WindowCheck>,
    /// Whether a FiveM process was seen on this machine at the last look.
    ///
    /// Only meaningful while idle, where it is the difference between "nothing is happening"
    /// and "the game is not running yet". It is an observation, not a permission — the
    /// backend re-derives it from the snapshot and never takes this field's word for it.
    #[serde(default)]
    pub game_present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    pub version: String,
    pub protocol_version: i64,
}

impl WindowView {
    /// Attaches the measurements from the most recent scan.
    #[must_use]
    pub fn with_checks(mut self, checks: Vec<WindowCheck>) -> Self {
        self.requirements = checks;
        self
    }

    /// Records whether the game was running when this view was built.
    #[must_use]
    pub fn with_game_present(mut self, present: bool) -> Self {
        self.game_present = present;
        self
    }
}

/// Applies an event.
///
/// Note what is missing: there is no event a *client* can raise that reaches `Ready`.
/// `AttestationAccepted` is emitted by the code that received the backend's acknowledgement,
/// and nothing on the localhost endpoint can produce it (ADR 0004).
pub fn next_state(current: WindowState, event: &Event) -> WindowState {
    match (current, event) {
        (_, Event::AttestRequested) => WindowState::Checking,
        (WindowState::Checking, Event::AttestationAccepted) => WindowState::Ready,
        (_, Event::Refused { .. } | Event::Failed { .. }) => WindowState::Blocked,
        (_, Event::SessionEnded) => WindowState::Idle,

        // An acknowledgement that arrives while no check is running belongs to a session
        // that has already ended. Ignoring it keeps a late reply from reviving a window the
        // player has moved on from.
        (state, Event::AttestationAccepted) => state,
    }
}

/// Builds the view the window renders.
pub fn view(
    state: WindowState,
    remediation: Option<String>,
    server_name: Option<String>,
    version: &str,
    protocol_version: i64,
) -> WindowView {
    WindowView {
        state,
        requirements: Vec::new(),
        game_present: false,
        // Remediation only belongs on the blocked screen. Carrying it into Ready would let
        // a stale message sit under a green heading.
        remediation: if state == WindowState::Blocked {
            remediation
        } else {
            None
        },
        server_name,
        version: version.to_owned(),
        protocol_version,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn a_connect_walks_idle_checking_ready() {
        let mut state = WindowState::Idle;
        state = next_state(state, &Event::AttestRequested);
        assert_eq!(state, WindowState::Checking);
        state = next_state(state, &Event::AttestationAccepted);
        assert_eq!(state, WindowState::Ready);
    }

    #[test]
    fn a_refusal_blocks_from_anywhere() {
        for start in [
            WindowState::Idle,
            WindowState::Checking,
            WindowState::Ready,
            WindowState::Blocked,
        ] {
            let event = Event::Refused { remediation: None };
            assert_eq!(next_state(start, &event), WindowState::Blocked);
        }
    }

    #[test]
    fn nothing_reaches_ready_without_a_check_first() {
        // The rule that matters. Ready is only *entered* from Checking, and Checking is only
        // entered when a nonce arrived — so no sequence of local events can fake it.
        for start in [WindowState::Idle, WindowState::Blocked] {
            assert_ne!(
                next_state(start, &Event::AttestationAccepted),
                WindowState::Ready,
                "state {start:?} must not jump to Ready"
            );
        }
    }

    #[test]
    fn a_late_acknowledgement_leaves_the_state_alone() {
        // Staying Ready is not the same as entering it. An acknowledgement that arrives twice
        // — a retried request, a slow reply — must be harmless rather than a transition.
        assert_eq!(
            next_state(WindowState::Ready, &Event::AttestationAccepted),
            WindowState::Ready
        );
        assert_eq!(
            next_state(WindowState::Idle, &Event::AttestationAccepted),
            WindowState::Idle
        );
    }

    #[test]
    fn a_new_connect_restarts_the_check_even_from_blocked() {
        // A player who fixed the problem and reconnects must see the check run again rather
        // than the old blocked screen.
        assert_eq!(
            next_state(WindowState::Blocked, &Event::AttestRequested),
            WindowState::Checking
        );
    }

    #[test]
    fn the_session_ending_returns_to_idle() {
        assert_eq!(
            next_state(WindowState::Ready, &Event::SessionEnded),
            WindowState::Idle
        );
    }

    #[test]
    fn remediation_is_only_shown_on_the_blocked_screen() {
        let text = Some("Aktiviere die Speicherintegrität.".to_owned());

        let blocked = view(WindowState::Blocked, text.clone(), None, "0.1.0", 1);
        assert_eq!(blocked.remediation, text);

        for state in [WindowState::Idle, WindowState::Checking, WindowState::Ready] {
            let view = view(state, text.clone(), None, "0.1.0", 1);
            assert_eq!(
                view.remediation, None,
                "{state:?} must not carry remediation"
            );
        }
    }

    #[test]
    fn the_view_serializes_to_what_the_window_expects() {
        let view = view(
            WindowState::Ready,
            None,
            Some("Nordstadt Roleplay".to_owned()),
            "0.1.0",
            1,
        );
        let json = serde_json::to_value(&view).expect("serializes");

        assert_eq!(json["state"], "ready");
        assert_eq!(json["serverName"], "Nordstadt Roleplay");
        assert_eq!(json["protocolVersion"], 1);
        assert!(json.get("remediation").is_none(), "absent rather than null");
    }
}
