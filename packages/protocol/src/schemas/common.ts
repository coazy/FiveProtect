import { defineConstant, defineEnum } from '../ir.js';

export const PROTOCOL_VERSION = defineConstant({
  name: 'PROTOCOL_VERSION',
  value: 1,
  doc: 'Wire protocol version. Incremented on any breaking change to a message shape.',
});

export const NONCE_TTL_SECONDS = defineConstant({
  name: 'NONCE_TTL_SECONDS',
  value: 30,
  doc: 'Lifetime of a connect nonce. Design document 5.4 — keeps the relay window narrow.',
});

export const HEARTBEAT_INTERVAL_SECONDS = defineConstant({
  name: 'HEARTBEAT_INTERVAL_SECONDS',
  value: 120,
  doc: 'Interval at which the companion must report in during a session.',
});

export const HEARTBEAT_GRACE_SECONDS = defineConstant({
  name: 'HEARTBEAT_GRACE_SECONDS',
  value: 90,
  doc: 'Grace period after a missed heartbeat. The player sees a warning before the kick.',
});

export const VERDICT_POLL_TIMEOUT_SECONDS = defineConstant({
  name: 'VERDICT_POLL_TIMEOUT_SECONDS',
  value: 20,
  doc: 'Upper bound for the long poll the resource uses to pull a verdict.',
});

export const COMPANION_POLL_TIMEOUT_SECONDS = defineConstant({
  name: 'COMPANION_POLL_TIMEOUT_SECONDS',
  value: 25,
  doc: 'Upper bound for the long poll the companion uses to collect a pending nonce. ADR 0010.',
});

export const LOCAL_PORT_RANGE_START = defineConstant({
  name: 'LOCAL_PORT_RANGE_START',
  value: 52800,
  doc: 'First port the companion tries to bind on 127.0.0.1.',
});

export const LOCAL_PORT_RANGE_END = defineConstant({
  name: 'LOCAL_PORT_RANGE_END',
  value: 52899,
  doc: 'Last port of the companion range, inclusive.',
});

export const PolicyTier = defineEnum({
  name: 'PolicyTier',
  doc: 'Environment policy tier chosen by the server operator. Design document 7.',
  values: [
    { value: 'relaxed', doc: 'Companion present, test signing and kernel debugging off.' },
    { value: 'standard', doc: 'Adds Secure Boot, TPM attestation, HVCI and the driver blocklist.' },
    { value: 'strict', doc: 'Adds IOMMU / kernel DMA protection as a hard requirement.' },
  ],
});

export const FailMode = defineEnum({
  name: 'FailMode',
  doc: 'What the resource does when the backend cannot be reached. ADR 0005.',
  values: [
    { value: 'fail_open', doc: 'Let the player in, log the incident, alert the operator.' },
    { value: 'fail_closed', doc: 'Refuse the connection while the backend is unreachable.' },
  ],
});

export const FeatureState = defineEnum({
  name: 'FeatureState',
  doc: 'Tri-state for an operating system security feature. "unknown" is a signal, not a pass.',
  values: [
    { value: 'enabled', doc: 'Feature is active.' },
    { value: 'disabled', doc: 'Feature is inactive.' },
    { value: 'unknown', doc: 'The probe could not determine the state. Never treated as enabled.' },
  ],
});

export const SessionState = defineEnum({
  name: 'SessionState',
  doc: 'Lifecycle of a single connect attempt and the session that follows it.',
  values: [
    { value: 'pending', doc: 'Nonce issued, attestation not yet received.' },
    { value: 'attested', doc: 'Attestation received and evaluated, verdict available.' },
    { value: 'active', doc: 'Player is in game and the companion is sending heartbeats.' },
    { value: 'expired', doc: 'Nonce ran out before an attestation arrived.' },
    { value: 'terminated', doc: 'Session ended — disconnect, kick or lost heartbeat.' },
  ],
});

export const VerdictDecision = defineEnum({
  name: 'VerdictDecision',
  doc: 'The only three answers the gate gives. Produced by the backend, never by the client.',
  values: [
    { value: 'allow', doc: 'Player may connect.' },
    { value: 'deny', doc: 'Player is refused; reasons carry the explanation.' },
    { value: 'pending', doc: 'No attestation yet. The resource keeps polling until timeout.' },
  ],
});

export const RequirementId = defineEnum({
  name: 'RequirementId',
  doc: 'One row of the policy table in design document 7, evaluated per attestation.',
  values: [
    { value: 'companion_attested', doc: 'Companion ran and produced a snapshot for this nonce.' },
    { value: 'test_signing_disabled', doc: 'Windows test signing is off.' },
    { value: 'kernel_debugging_disabled', doc: 'Kernel debugging is off.' },
    { value: 'secure_boot_enabled', doc: 'Secure Boot is active.' },
    { value: 'tpm_attestation_valid', doc: 'TPM 2.0 present with a valid attestation.' },
    { value: 'hvci_enabled', doc: 'Memory integrity (HVCI) is active.' },
    { value: 'driver_blocklist_enabled', doc: 'Microsoft vulnerable driver blocklist is active.' },
    { value: 'iommu_enabled', doc: 'IOMMU / kernel DMA protection is active.' },
    { value: 'vulnerable_drivers_absent', doc: 'No known vulnerable driver is loaded.' },
    { value: 'game_process_present', doc: 'A local FiveM process was observed by the companion.' },
    {
      value: 'network_origin_matches',
      doc: 'Attestation IP matches the IP of the game connection.',
    },
  ],
});

export const RequirementStatus = defineEnum({
  name: 'RequirementStatus',
  doc: 'Outcome of a single requirement under the active policy tier.',
  values: [
    { value: 'pass', doc: 'Requirement met.' },
    { value: 'fail', doc: 'Requirement not met and blocking at this tier.' },
    { value: 'warn', doc: 'Requirement not met but only advisory at this tier.' },
    { value: 'skipped', doc: 'Requirement does not apply at this tier.' },
    { value: 'unknown', doc: 'The evidence needed to decide was missing.' },
  ],
});

export const DenyReason = defineEnum({
  name: 'DenyReason',
  doc: 'Machine-readable cause of a denial. Each maps to player-facing text in the resource.',
  values: [
    { value: 'companion_missing', doc: 'No companion answered on 127.0.0.1.' },
    { value: 'companion_timeout', doc: 'Companion answered but no attestation arrived in time.' },
    { value: 'companion_outdated', doc: 'Companion build hash is not on the accepted list.' },
    { value: 'attestation_invalid', doc: 'Attestation was malformed or failed verification.' },
    { value: 'nonce_expired', doc: 'Nonce was older than its time to live.' },
    { value: 'nonce_reused', doc: 'Nonce had already been consumed.' },
    {
      value: 'network_origin_mismatch',
      doc: 'Attestation IP differed from the game connection IP.',
    },
    { value: 'game_process_missing', doc: 'Companion saw no local FiveM process.' },
    { value: 'policy_not_met', doc: 'One or more policy requirements failed. See requirements.' },
    { value: 'heartbeat_lost', doc: 'Companion stopped reporting during the session.' },
    { value: 'backend_unavailable', doc: 'Backend unreachable under fail_closed.' },
    { value: 'banned', doc: 'Player or hardware identity is banned.' },
  ],
});
