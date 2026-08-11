//! What the companion does, in order.
//!
//! Collect a nonce, scan, report, then report in every so often until the session ends. The
//! state machine that decides what the window shows lives in `fiveprotect_core::state`; this file
//! is what feeds it events.
//!
//! There is no branch here that reads a verdict, because none is ever sent (ADR 0004). The
//! window turns green when the backend acknowledged the attestation, which means "we filed
//! it", not "you passed". Whether the player actually gets in is decided by the FiveM
//! resource pulling the verdict, on a path the companion never sees.

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use fiveprotect_core::state::{next_state, view, Event, WindowCheck, WindowState, WindowView};
use fiveprotect_protocol::{
    AttestationRequest, FeatureState, HeartbeatRequest, RequirementId, RequirementResult,
    RequirementStatus, SecurityFeatures, SystemSnapshot, VerdictDecision,
    COMPANION_POLL_TIMEOUT_SECONDS, PROTOCOL_VERSION,
};

use crate::backend::{BackendError, Client, Pending};
use crate::engine;
use crate::identity;

/// Where a nonce came from. Both paths end in the same scan; the distinction is for logging.
#[derive(Debug, Clone)]
pub enum Job {
    /// Collected from the backend (ADR 0010). The ordinary path.
    Collected(Pending),
    /// Delivered by the game client over the localhost endpoint (ADR 0003).
    Local(Box<fiveprotect_protocol::LocalAttestCommand>),
    /// The player pressed "check again".
    Recheck,
    /// The program is exiting. Carries the channel to signal once the backend has been told.
    Shutdown(Sender<()>),
}

impl Job {
    fn nonce(&self) -> Option<&str> {
        match self {
            Self::Collected(pending) => Some(&pending.nonce),
            Self::Local(command) => Some(&command.nonce),
            Self::Recheck | Self::Shutdown(_) => None,
        }
    }

    fn server_name(&self) -> Option<String> {
        match self {
            Self::Collected(pending) => pending.server_name.clone(),
            Self::Local(command) => command.server_name.clone(),
            Self::Recheck | Self::Shutdown(_) => None,
        }
    }
}

/// A session the backend has acknowledged and that is being kept alive.
#[derive(Debug)]
struct Active {
    session_id: String,
    interval: Duration,
    next_beat: Instant,
}

#[derive(Debug)]
pub struct Worker {
    client: Client,
    version: String,
    build_hash: String,
    started: Instant,
}

/// Text the window shows when something went wrong before the backend ever saw the snapshot.
///
/// Deliberately not a diagnosis of the machine — the companion does not know the server's
/// policy, so it must not claim to know why a server would refuse. It says what failed here.
const SCAN_FAILED: &str =
    "Die Systemprüfung konnte nicht durchgeführt werden. Starte FiveProtect neu und versuche es erneut.";
const BACKEND_UNREACHABLE: &str =
    "Der Anticheat-Dienst ist nicht erreichbar. Prüfe deine Internetverbindung und versuche es erneut.";
const REPORT_REFUSED: &str =
    "Die Systemprüfung wurde nicht angenommen. Verbinde dich erneut mit dem Server.";

/// How often the window looks for the game while nothing else is going on.
///
/// Short enough that starting FiveM is reflected before the player wonders, long enough that
/// the scan is not worth measuring.
const IDLE_WATCH: Duration = Duration::from_secs(3);

/// How long to wait for the verdict after filing the attestation.
///
/// The backend usually has it immediately — it is decided while the attestation is being
/// processed — so this covers the race with the resource's own poll and nothing more.
const OUTCOME_WAIT_SECONDS: i64 = 5;

impl Worker {
    pub fn new(client: Client, version: &str, build_hash: &str) -> Self {
        Self {
            client,
            version: version.to_owned(),
            build_hash: build_hash.to_owned(),
            started: Instant::now(),
        }
    }

    /// Runs until the job channel closes, which happens when the window is closed.
    pub fn run(&self, jobs: &Receiver<Job>, views: &Sender<WindowView>) {
        let mut shown = Presentation::new();
        let mut active: Option<Active> = None;
        let mut last_nonce: Option<String> = None;

        shown.game_present = self.game_running();
        self.publish(views, &shown);

        loop {
            // Wake for whichever comes first: a job, the next heartbeat, or the next look for
            // the game. A heartbeat that waited for a job would strand the session; a job
            // that waited for a heartbeat would leave the player looking at a stale window.
            let wait = active
                .as_ref()
                .map_or(IDLE_WATCH, |session| {
                    session.next_beat.saturating_duration_since(Instant::now())
                });

            let job = match jobs.recv_timeout(wait) {
                Ok(job) => Some(job),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };

            let Some(job) = job else {
                let Some(session) = active.as_mut() else {
                    // Idle. Look for the game, so the window can say whether it is waiting
                    // for FiveM to start or for a server to ask something. Published only on
                    // a change — a view every three seconds would repaint the window for no
                    // reason.
                    let running = self.game_running();
                    if running != shown.game_present {
                        shown.game_present = running;
                        self.publish(views, &shown);
                    }
                    continue;
                };

                match self.beat(&session.session_id) {
                    Ok(Some(interval)) => {
                        session.interval = interval;
                        session.next_beat = Instant::now() + interval;
                    }
                    Ok(None) => {
                        // The backend ended the session.
                        active = None;
                        shown.state = next_state(shown.state, &Event::SessionEnded);
                        shown.checks.clear();
                        shown.server_name = None;
                        shown.game_present = self.game_running();
                        self.publish(views, &shown);
                    }
                    Err(error) => {
                        // A missed heartbeat is not a reason to change what the player sees:
                        // the backend's grace period exists precisely so a short network
                        // drop does not throw anyone out.
                        crate::log::logline!("Heartbeat fehlgeschlagen: {error}");
                        session.next_beat = Instant::now() + session.interval;
                    }
                }
                continue;
            };

            // Handled before anything else: the program is waiting on this to exit.
            if let Job::Shutdown(done) = &job {
                if let Some(session) = active.as_ref() {
                    self.announce_close(&session.session_id);
                }
                done.send(()).ok();
                return;
            }

            // A nonce already answered is one the NUI resent, or a poll that raced with the
            // localhost hop. Answering it twice would burn the second attempt on a session
            // that is already attested.
            if let Some(nonce) = job.nonce() {
                if last_nonce.as_deref() == Some(nonce) {
                    continue;
                }
            }

            let Some(nonce) = job.nonce().map(str::to_owned) else {
                // "Erneut prüfen" with no nonce in hand, which is the usual case: the player
                // just changed a Windows setting and wants to see whether it took.
                //
                // There is nothing to attest against — a nonce comes from a server, and this
                // one is over. So the machine is measured again and the window shows the new
                // reading. Going back to idle is the honest end state: the old refusal
                // belongs to a connect attempt that has finished, and leaving it on screen
                // would tell a player who has just fixed their machine that it is still broken.
                crate::log::logline!("Erneute Prüfung angefordert");

                match self.scan() {
                    Ok(snapshot) => {
                        shown.game_present = snapshot.game_process.is_some();
                        shown.checks = checks_from(&snapshot);
                        crate::log::logline!("Erneute Prüfung: {}", summarise(&shown.checks));
                    }
                    Err(error) => {
                        crate::log::logline!("Erneute Prüfung fehlgeschlagen: {error}");
                    }
                }

                if active.is_none() {
                    shown.state = next_state(shown.state, &Event::SessionEnded);
                    shown.remediation = None;
                    shown.server_name = None;
                }

                self.publish(views, &shown);
                continue;
            };

            if let Some(name) = job.server_name() {
                shown.server_name = Some(name);
            }

            // The nonce itself is never logged. It is a bearer secret for its thirty
            // seconds, and a log file is the one artefact a player will paste in public.
            crate::log::logline!(
                "Nonce erhalten ({}), Server {}",
                match job {
                    Job::Collected(_) => "abgeholt",
                    Job::Local(_) => "vom Spielclient",
                    // Shutdown returns above, before any of this runs.
                    Job::Recheck | Job::Shutdown(_) => "erneute Prüfung",
                },
                shown.server_name.as_deref().unwrap_or("unbekannt")
            );

            shown.state = next_state(shown.state, &Event::AttestRequested);
            shown.remediation = None;
            self.publish(views, &shown);

            let snapshot = match self.scan() {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    crate::log::logline!("Scan fehlgeschlagen: {error}");
                    shown.state = next_state(
                        shown.state,
                        &Event::Failed {
                            remediation: Some(SCAN_FAILED.to_owned()),
                        },
                    );
                    shown.remediation = Some(SCAN_FAILED.to_owned());
                    self.publish(views, &shown);
                    continue;
                }
            };

            shown.game_present = snapshot.game_process.is_some();
            shown.checks = checks_from(&snapshot);
            crate::log::logline!(
                "Systemprüfung fertig: {} (Windows {}, TPM {}, FiveM {})",
                summarise(&shown.checks),
                snapshot.os_build,
                if snapshot.tpm.present { "ja" } else { "nein" },
                if snapshot.game_process.is_some() {
                    "läuft"
                } else {
                    "nicht gefunden"
                }
            );
            self.publish(views, &shown);

            let request = AttestationRequest {
                nonce: nonce.clone(),
                snapshot,
                quote: None,
                protocol_version: i64::from(PROTOCOL_VERSION),
            };

            match self.client.attest(&request) {
                Ok(ack) => {
                    // "Angenommen" means filed, not passed. The backend never tells the
                    // companion which way the verdict went (ADR 0004), and this line must
                    // not read as though it did.
                    //
                    // Only the first eight characters of the session id. Whoever holds the
                    // whole one can send a heartbeat claiming the game is gone and have the
                    // player thrown out — and this log is exported for support, which means
                    // it gets forwarded. Eight characters still correlate with the backend's
                    // own logs for anyone who already has access to them.
                    crate::log::logline!(
                        "Meldung angenommen und abgelegt (Sitzung {}…)",
                        short_session(&ack.session_id)
                    );
                    last_nonce = Some(nonce);
                    let interval = Duration::from_secs(
                        u64::try_from(ack.heartbeat_interval_seconds).unwrap_or(120),
                    );

                    shown.state = next_state(shown.state, &Event::AttestationAccepted);
                    self.publish(views, &shown);

                    // Ask how it was judged. ADR 0011: the connect screen tells the player
                    // this anyway, and a window that says "Bereit" while the server is
                    // refusing the connection is worse than useless.
                    match self.client.outcome(&ack.session_id, OUTCOME_WAIT_SECONDS) {
                        Ok(Some(verdict)) if verdict.decision == VerdictDecision::Deny => {
                            crate::log::logline!(
                                "Server hat abgelehnt: {}",
                                verdict
                                    .reasons
                                    .iter()
                                    .map(|reason| format!("{reason:?}"))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            );
                            shown.remediation = verdict.remediation.clone();
                            shown.checks = merge_server_view(&shown.checks, &verdict.requirements);
                            shown.state = next_state(
                                shown.state,
                                &Event::Refused {
                                    remediation: shown.remediation.clone(),
                                },
                            );
                        }
                        Ok(Some(_)) => {
                            // Allowed. The session is live and worth keeping alive.
                            active = Some(Active {
                                session_id: ack.session_id,
                                interval,
                                next_beat: Instant::now() + interval,
                            });
                        }
                        outcome => {
                            // No answer yet, or none to be had. The window stays on the
                            // accepted screen; the connect dialogue is what decides either
                            // way, and inventing a refusal here would be a lie of its own.
                            if let Err(error) = outcome {
                                crate::log::logline!("Ergebnis nicht abrufbar: {error}");
                            }
                            active = Some(Active {
                                session_id: ack.session_id,
                                interval,
                                next_beat: Instant::now() + interval,
                            });
                        }
                    }
                }
                Err(error) => {
                    crate::log::logline!("Meldung abgelehnt: {error}");
                    let text = match error {
                        BackendError::Unreachable(_) => BACKEND_UNREACHABLE,
                        _ => REPORT_REFUSED,
                    };
                    shown.remediation = Some(text.to_owned());
                    shown.state = next_state(
                        shown.state,
                        &Event::Refused {
                            remediation: shown.remediation.clone(),
                        },
                    );
                }
            }

            self.publish(views, &shown);
        }
    }

    fn scan(&self) -> Result<SystemSnapshot, engine::ScanError> {
        engine::scan(&self.version, &self.build_hash, &identity::now_iso())
    }

    /// Tells the backend this companion is exiting, so the player is dropped now rather
    /// than after the grace period.
    ///
    /// Best effort by construction: a companion that is killed rather than closed never gets
    /// here, and that case is exactly what the heartbeat timeout is for.
    pub fn announce_close(&self, session_id: &str) {
        let request = HeartbeatRequest {
            session_id: session_id.to_owned(),
            companion_build_hash: self.build_hash.clone(),
            uptime_seconds: i64::try_from(self.started.elapsed().as_secs()).unwrap_or(i64::MAX),
            // Not re-scanned. The machine is about to lose its companion either way, and a
            // scan here would delay the exit for an answer nobody acts on.
            game_process_present: true,
            closing: Some(true),
            protocol_version: i64::from(PROTOCOL_VERSION),
        };

        match self.client.heartbeat(&request) {
            Ok(_) => crate::log::logline!("Sitzung beim Beenden abgemeldet"),
            Err(error) => crate::log::logline!("Abmeldung fehlgeschlagen: {error}"),
        }
    }

    /// Sends one heartbeat. `Ok(None)` means the backend ended the session.
    fn beat(&self, session_id: &str) -> Result<Option<Duration>, BackendError> {
        // Re-scanned rather than remembered: the point of the heartbeat is that the game is
        // still running on this machine, and a remembered answer would keep saying yes long
        // after FiveM was closed.
        let game_present = self
            .scan()
            .map(|snapshot| snapshot.game_process.is_some())
            .unwrap_or(false);

        let request = HeartbeatRequest {
            session_id: session_id.to_owned(),
            companion_build_hash: self.build_hash.clone(),
            uptime_seconds: i64::try_from(self.started.elapsed().as_secs()).unwrap_or(i64::MAX),
            game_process_present: game_present,
            closing: None,
            protocol_version: i64::from(PROTOCOL_VERSION),
        };

        let response = self.client.heartbeat(&request)?;
        if response.terminate {
            return Ok(None);
        }

        Ok(Some(Duration::from_secs(
            u64::try_from(response.next_interval_seconds).unwrap_or(120),
        )))
    }

    fn publish(&self, views: &Sender<WindowView>, shown: &Presentation) {
        let model = view(
            shown.state,
            shown.remediation.clone(),
            shown.server_name.clone(),
            &self.version,
            i64::from(PROTOCOL_VERSION),
        )
        .with_checks(shown.checks.clone())
        .with_game_present(shown.game_present);

        views.send(model).ok();
    }

    /// Whether a FiveM process is running right now.
    ///
    /// The full scan, because the engine has one entry point and the whole thing takes
    /// single-digit milliseconds — a second, narrower probe would be a second thing to keep
    /// truthful. A failed scan reads as "not running", which is the safe direction: the
    /// window says it is still waiting rather than claiming to have found something.
    fn game_running(&self) -> bool {
        self.scan()
            .map(|snapshot| snapshot.game_process.is_some())
            .unwrap_or(false)
    }
}

/// Everything the window is currently showing.
///
/// One struct rather than six locals threaded through every call: the bug this prevents is
/// updating one of them and publishing before the others catch up.
#[derive(Debug)]
struct Presentation {
    state: WindowState,
    checks: Vec<WindowCheck>,
    server_name: Option<String>,
    remediation: Option<String>,
    game_present: bool,
}

impl Presentation {
    fn new() -> Self {
        Self {
            state: WindowState::Idle,
            checks: Vec::new(),
            server_name: None,
            remediation: None,
            game_present: false,
        }
    }
}

/// Replaces the companion's own reading of a requirement with the server's, where it has one.
///
/// The companion measures the machine; the server decides what that means at its tier. On the
/// blocked screen the server's view is the one that explains the refusal — a line the
/// companion called `fail` may well be `skipped` on this server, and showing it as a problem
/// would send the player to fix something nobody asked for.
fn merge_server_view(local: &[WindowCheck], server: &[RequirementResult]) -> Vec<WindowCheck> {
    let mut merged: Vec<WindowCheck> = server
        .iter()
        .map(|result| WindowCheck {
            requirement: result.requirement,
            status: result.status,
        })
        .collect();

    // Anything the server did not mention stays as the companion measured it.
    for entry in local {
        if !merged.iter().any(|row| row.requirement == entry.requirement) {
            merged.push(*entry);
        }
    }

    merged
}

/// Long-polls the backend for a nonce meant for this machine.
///
/// Runs on its own thread so a 25-second wait never delays a command arriving over the
/// localhost endpoint. Errors are printed and retried — the player's network is not
/// something the companion gets to have an opinion about.
pub fn collect_nonces(client: &Client, jobs: &Sender<Job>) {
    /// After a failure. Long enough not to hammer a backend that is down, short enough that
    /// a player who fixes their connection does not wait noticeably.
    const RETRY: Duration = Duration::from_secs(5);

    crate::log::logline!("Holt Nonces von {}", client.base_url());

    loop {
        match client.poll_pending(i64::from(COMPANION_POLL_TIMEOUT_SECONDS)) {
            Ok(Some(pending)) => {
                if jobs.send(Job::Collected(pending)).is_err() {
                    return;
                }
            }
            Ok(None) => {}
            Err(error) => {
                crate::log::logline!("Abholung fehlgeschlagen: {error}");
                std::thread::sleep(RETRY);
            }
        }
    }
}

/// Turns the snapshot into the lines the window shows.
///
/// Only what the companion measured itself. There is no entry for anything that depends on
/// the server's policy, because the companion is not told what that policy is.
#[must_use]
pub fn checks_from(snapshot: &SystemSnapshot) -> Vec<WindowCheck> {
    let SecurityFeatures {
        secure_boot,
        hvci,
        test_signing,
        kernel_debugging,
        driver_blocklist,
        iommu,
        ..
    } = &snapshot.features;

    let mut checks = vec![
        check(RequirementId::SecureBootEnabled, enabled_is_pass(*secure_boot)),
        check(RequirementId::HvciEnabled, enabled_is_pass(*hvci)),
        check(
            RequirementId::DriverBlocklistEnabled,
            enabled_is_pass(*driver_blocklist),
        ),
        check(RequirementId::IommuEnabled, enabled_is_pass(*iommu)),
        // Inverted: these two are failures when they are on.
        check(
            RequirementId::TestSigningDisabled,
            enabled_is_fail(*test_signing),
        ),
        check(
            RequirementId::KernelDebuggingDisabled,
            enabled_is_fail(*kernel_debugging),
        ),
        check(
            RequirementId::TpmAttestationValid,
            if snapshot.tpm.present {
                RequirementStatus::Pass
            } else {
                RequirementStatus::Fail
            },
        ),
    ];

    checks.push(check(
        RequirementId::GameProcessPresent,
        if snapshot.game_process.is_some() {
            RequirementStatus::Pass
        } else {
            RequirementStatus::Fail
        },
    ));

    checks
}

/// As much of a session id as may be written down.
///
/// Whoever holds a whole one can send a heartbeat for it claiming the game is no longer
/// running, and the backend will end the session — so it is a capability, not just a name.
/// The log is exported for support and forwarded from there, which is exactly the trip a
/// capability must not survive. Eight characters still correlate with the backend's own logs
/// for anyone who already has access to them.
#[must_use]
pub fn short_session(session_id: &str) -> &str {
    let cut = session_id
        .char_indices()
        .nth(8)
        .map_or(session_id.len(), |(index, _)| index);
    &session_id[..cut]
}

/// "6 ok, 1 nicht erfüllt, 1 unklar" — enough for a support log without listing everything.
fn summarise(checks: &[WindowCheck]) -> String {
    let mut pass = 0;
    let mut fail = 0;
    let mut unknown = 0;
    for entry in checks {
        match entry.status {
            RequirementStatus::Pass => pass += 1,
            RequirementStatus::Unknown => unknown += 1,
            _ => fail += 1,
        }
    }
    format!("{pass} ok, {fail} nicht erfüllt, {unknown} unklar")
}

fn check(requirement: RequirementId, status: RequirementStatus) -> WindowCheck {
    WindowCheck {
        requirement,
        status,
    }
}

/// `unknown` is never a pass. A probe that could not read the setting has not shown it to be
/// on, and treating "we could not tell" as "it is fine" is exactly the gap a rootkit wants.
fn enabled_is_pass(state: FeatureState) -> RequirementStatus {
    match state {
        FeatureState::Enabled => RequirementStatus::Pass,
        FeatureState::Disabled => RequirementStatus::Fail,
        FeatureState::Unknown => RequirementStatus::Unknown,
    }
}

fn enabled_is_fail(state: FeatureState) -> RequirementStatus {
    match state {
        FeatureState::Enabled => RequirementStatus::Fail,
        FeatureState::Disabled => RequirementStatus::Pass,
        FeatureState::Unknown => RequirementStatus::Unknown,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use fiveprotect_protocol::{GameProcessEvidence, TpmInfo};

    fn snapshot(features: SecurityFeatures, tpm_present: bool, game: bool) -> SystemSnapshot {
        SystemSnapshot {
            schema_version: 1,
            collected_at: "2026-08-04T12:00:00.000Z".to_owned(),
            companion_version: "0.1.0".to_owned(),
            companion_build_hash: "a".repeat(64),
            os_build: "10.0.26200".to_owned(),
            features,
            tpm: TpmInfo {
                present: tpm_present,
                manufacturer: None,
                spec_version: None,
                attestation_key_id: None,
            },
            game_process: game.then(|| GameProcessEvidence {
                pid: 4242,
                started_at_unix_ms: 1_754_000_000_000,
                image_name: "FiveM.exe".to_owned(),
                main_window_present: true,
            }),
            probe_errors: Vec::new(),
        }
    }

    fn all(state: FeatureState) -> SecurityFeatures {
        SecurityFeatures {
            secure_boot: state,
            hvci: state,
            test_signing: state,
            kernel_debugging: state,
            driver_blocklist: state,
            iommu: state,
            virtualization_based_security: state,
        }
    }

    fn status_of(checks: &[WindowCheck], id: RequirementId) -> RequirementStatus {
        checks
            .iter()
            .find(|entry| entry.requirement == id)
            .map(|entry| entry.status)
            .expect("requirement is listed")
    }

    #[test]
    fn an_unknown_feature_is_never_shown_as_passing() {
        // The rule that matters. "We could not read it" and "it is on" must not look the
        // same to a player deciding whether they have anything to fix.
        let checks = checks_from(&snapshot(all(FeatureState::Unknown), false, false));
        for entry in &checks {
            if entry.requirement == RequirementId::TpmAttestationValid
                || entry.requirement == RequirementId::GameProcessPresent
            {
                continue;
            }
            assert_eq!(
                entry.status,
                RequirementStatus::Unknown,
                "{:?} must not pass on an unknown probe",
                entry.requirement
            );
        }
    }

    #[test]
    fn test_signing_and_kernel_debugging_read_the_other_way_round() {
        // Enabled is a failure for these two. Getting the polarity wrong here would show a
        // green line to exactly the machine that is set up for cheating.
        let on = checks_from(&snapshot(all(FeatureState::Enabled), true, true));
        assert_eq!(
            status_of(&on, RequirementId::TestSigningDisabled),
            RequirementStatus::Fail
        );
        assert_eq!(
            status_of(&on, RequirementId::KernelDebuggingDisabled),
            RequirementStatus::Fail
        );
        assert_eq!(
            status_of(&on, RequirementId::SecureBootEnabled),
            RequirementStatus::Pass
        );

        let off = checks_from(&snapshot(all(FeatureState::Disabled), true, true));
        assert_eq!(
            status_of(&off, RequirementId::TestSigningDisabled),
            RequirementStatus::Pass
        );
        assert_eq!(
            status_of(&off, RequirementId::SecureBootEnabled),
            RequirementStatus::Fail
        );
    }

    #[test]
    fn the_window_never_carries_a_requirement_the_companion_cannot_measure() {
        // `network_origin_matches` and `companion_attested` are the backend's to decide.
        // Listing either would be the companion claiming to know the verdict (ADR 0004).
        let checks = checks_from(&snapshot(all(FeatureState::Enabled), true, true));
        for entry in &checks {
            assert!(
                !matches!(
                    entry.requirement,
                    RequirementId::NetworkOriginMatches
                        | RequirementId::CompanionAttested
                        | RequirementId::VulnerableDriversAbsent
                ),
                "{:?} is not something the companion measures",
                entry.requirement
            );
        }
    }

    #[test]
    fn a_logged_session_id_is_never_a_whole_one() {
        // The log is what the diagnostics export forwards. A whole session id in it is a
        // capability to end the player's session, handed to whoever the file reaches.
        let full = "1cda7543-82a1-405e-a8eb-2e03db4fc54e";
        let short = short_session(full);

        assert_eq!(short, "1cda7543");
        assert!(full.starts_with(short), "must stay a prefix, for correlation");
        assert!(short.len() < full.len(), "must actually be shorter");

        // Not a panic on anything shorter than the cut, which is what a malformed answer
        // from a backend that is not ours would produce.
        assert_eq!(short_session("abc"), "abc");
        assert_eq!(short_session(""), "");
    }

    #[test]
    fn a_missing_game_process_is_reported_as_missing() {
        let without = checks_from(&snapshot(all(FeatureState::Enabled), true, false));
        assert_eq!(
            status_of(&without, RequirementId::GameProcessPresent),
            RequirementStatus::Fail
        );
    }

    #[test]
    fn the_published_view_carries_no_field_that_implies_an_outcome() {
        // The window model crosses into JavaScript. If a field named like a verdict ever
        // appears there, the page could render it and the companion would have become an
        // oracle for whether a modification passed.
        let model = view(
            WindowState::Ready,
            None,
            Some("Test".to_owned()),
            "0.1.0",
            1,
        )
        .with_checks(checks_from(&snapshot(all(FeatureState::Enabled), true, true)));

        let json = serde_json::to_string(&model).expect("serializes");
        for forbidden in ["\"clean\"", "\"passed\"", "\"verdict\"", "\"decision\""] {
            assert!(!json.contains(forbidden), "{forbidden} in {json}");
        }
    }
}
