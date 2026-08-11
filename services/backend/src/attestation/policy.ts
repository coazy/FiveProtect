import type {
  DenyReason,
  FeatureState,
  PolicyTier,
  RequirementId,
  RequirementResult,
  RequirementStatus,
  SystemSnapshot,
} from '@fiveprotect/protocol';

/**
 * The policy table from design document 7, as code.
 *
 * Pure on purpose: no database, no clock, no network. Everything that decides whether a
 * player may connect is a function of its arguments, so the interesting cases are unit
 * tests rather than a staging environment and a spare machine.
 */

/** What a failed requirement does at a given tier. */
export type Enforcement = 'block' | 'warn' | 'skip';

/**
 * Design document 7, one row per requirement.
 *
 * `game_process_present` and `network_origin_matches` are not in the printed table; they
 * come from the relay countermeasures in 5.4 and block at every tier, because without them
 * the whole co-location argument collapses.
 */
export const TARGET_POLICY_TABLE: Record<RequirementId, Record<PolicyTier, Enforcement>> = {
  companion_attested: { relaxed: 'block', standard: 'block', strict: 'block' },
  test_signing_disabled: { relaxed: 'block', standard: 'block', strict: 'block' },
  kernel_debugging_disabled: { relaxed: 'block', standard: 'block', strict: 'block' },
  vulnerable_drivers_absent: { relaxed: 'warn', standard: 'block', strict: 'block' },
  secure_boot_enabled: { relaxed: 'skip', standard: 'block', strict: 'block' },
  tpm_attestation_valid: { relaxed: 'skip', standard: 'block', strict: 'block' },
  hvci_enabled: { relaxed: 'skip', standard: 'block', strict: 'block' },
  driver_blocklist_enabled: { relaxed: 'skip', standard: 'block', strict: 'block' },
  iommu_enabled: { relaxed: 'skip', standard: 'warn', strict: 'block' },
  game_process_present: { relaxed: 'block', standard: 'block', strict: 'block' },
  network_origin_matches: { relaxed: 'block', standard: 'block', strict: 'block' },
};

/**
 * Where the running implementation cannot yet enforce the target table.
 *
 * Kept as an explicit, testable list rather than by quietly editing the table above. A
 * requirement the engine cannot evaluate must not block — an unevaluable check that denies
 * everyone is worse than an honest gap — but the gap has to be visible, not implied.
 *
 * Every entry names the phase that removes it. The list is expected to be empty after
 * phase 3.
 */
export const PHASE_1_OVERRIDES: Partial<Record<RequirementId, Enforcement>> = {
  // TODO(phase-3): the vulnerable driver list from loldrivers.io needs the scan engine to
  // report loaded kernel modules first. Until then there is nothing to compare against.
  vulnerable_drivers_absent: 'skip',
};

/** The table actually in force, target values with the phase 1 gaps applied. */
export const POLICY_TABLE: Record<
  RequirementId,
  Record<PolicyTier, Enforcement>
> = Object.fromEntries(
  Object.entries(TARGET_POLICY_TABLE).map(([id, tiers]) => {
    const override = PHASE_1_OVERRIDES[id as RequirementId];
    return [
      id,
      override === undefined ? tiers : { relaxed: override, standard: override, strict: override },
    ];
  }),
) as Record<RequirementId, Record<PolicyTier, Enforcement>>;

/** Order in which requirements are reported. Matches the policy table for readability. */
const REPORT_ORDER: RequirementId[] = [
  'companion_attested',
  'test_signing_disabled',
  'kernel_debugging_disabled',
  'game_process_present',
  'network_origin_matches',
  'secure_boot_enabled',
  'tpm_attestation_valid',
  'hvci_enabled',
  'driver_blocklist_enabled',
  'vulnerable_drivers_absent',
  'iommu_enabled',
];

export interface PolicyInput {
  tier: PolicyTier;
  snapshot: SystemSnapshot;
  /** Address of the game connection, as reported by the FiveM server. */
  gameIp: string;
  /** Address the attestation arrived from. */
  attestationIp: string;
  /** Whether the reported build hash is on the accepted list (design document 10). */
  buildAccepted: boolean;
}

export interface PolicyOutcome {
  decision: 'allow' | 'deny';
  reasons: DenyReason[];
  requirements: RequirementResult[];
}

/** Outcome of one probe: met, not met, or the evidence was missing. */
type Finding = { met: boolean | 'unknown'; detail?: string };

export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const findings = collectFindings(input);
  const requirements: RequirementResult[] = [];
  const reasons = new Set<DenyReason>();

  for (const id of REPORT_ORDER) {
    const enforcement = POLICY_TABLE[id][input.tier];
    const finding = findings[id];

    if (enforcement === 'skip') {
      requirements.push(result(id, 'skipped', finding.detail));
      continue;
    }

    if (finding.met === true) {
      requirements.push(result(id, 'pass', finding.detail));
      continue;
    }

    // "unknown" is never treated as a pass. A probe that could not answer is a gap in the
    // evidence, and at a blocking tier a gap is a denial — it is reported as `unknown` so
    // the block screen can say "could not be determined" rather than "is switched off".
    const status: RequirementStatus =
      finding.met === 'unknown' ? 'unknown' : enforcement === 'warn' ? 'warn' : 'fail';
    requirements.push(result(id, status, finding.detail));

    if (enforcement === 'block') {
      reasons.add(reasonFor(id));
    }
  }

  if (!input.buildAccepted) {
    reasons.add('companion_outdated');
  }

  return {
    decision: reasons.size === 0 ? 'allow' : 'deny',
    reasons: [...reasons],
    requirements,
  };
}

function collectFindings(input: PolicyInput): Record<RequirementId, Finding> {
  const { snapshot } = input;
  const features = snapshot.features;

  return {
    // Reaching this function at all means a snapshot arrived against a live nonce.
    companion_attested: { met: true },

    test_signing_disabled: expect(features.testSigning, 'disabled'),
    kernel_debugging_disabled: expect(features.kernelDebugging, 'disabled'),
    secure_boot_enabled: expect(features.secureBoot, 'enabled'),
    hvci_enabled: hvciFinding(features.hvci, snapshot),
    driver_blocklist_enabled: expect(features.driverBlocklist, 'enabled'),
    iommu_enabled: expect(features.iommu, 'enabled'),

    tpm_attestation_valid: tpmFinding(snapshot),

    // TODO(phase-3): needs the vulnerable driver list from loldrivers.io, synchronised by
    // the backend. Until the scan engine reports loaded drivers there is nothing to check,
    // and claiming a pass would be a lie the evidence does not support.
    vulnerable_drivers_absent: {
      met: 'unknown',
      detail: 'Treiberprüfung folgt in Phase 3',
    },

    game_process_present: gameProcessFinding(snapshot),
    network_origin_matches: originFinding(input.gameIp, input.attestationIp),
  };
}

function expect(actual: FeatureState, wanted: FeatureState): Finding {
  if (actual === wanted) return { met: true };
  if (actual === 'unknown')
    return { met: 'unknown', detail: 'Zustand konnte nicht ermittelt werden' };
  return { met: false };
}

function hvciFinding(state: FeatureState, snapshot: SystemSnapshot): Finding {
  if (state === 'enabled') return { met: true };
  if (state === 'unknown') {
    return { met: 'unknown', detail: 'Zustand konnte nicht ermittelt werden' };
  }
  // Design document 7.4: naming the blocking driver is the difference between a support
  // ticket and none. The companion reports it as a probe note when Windows exposes it.
  const blocking = snapshot.probeErrors.find((entry) => entry.startsWith('hvci_blocked_by:'));
  return blocking === undefined
    ? { met: false }
    : { met: false, detail: `blockiert durch ${blocking.slice('hvci_blocked_by:'.length)}` };
}

function tpmFinding(snapshot: SystemSnapshot): Finding {
  // TODO(phase-2): phase 1 establishes presence only. Quote verification against the AK,
  // the EK certificate chain and the TCG event log is the core of phase 2 (design
  // document 6) — until then a present TPM is the most this can honestly assert.
  if (!snapshot.tpm.present) return { met: false, detail: 'kein TPM 2.0 gefunden' };
  return { met: true, detail: 'Präsenz geprüft, Quote-Validierung folgt in Phase 2' };
}

function gameProcessFinding(snapshot: SystemSnapshot): Finding {
  if (snapshot.gameProcess === undefined) {
    return { met: false, detail: 'kein lokaler FiveM-Prozess beobachtet' };
  }
  return { met: true };
}

/**
 * Relay countermeasure from design document 5.4.
 *
 * Compares the address the attestation came from with the address of the game connection.
 * Two machines behind the same public address still pass — that residual risk is carried
 * knowingly, and the server-authoritative detection covers it.
 */
function originFinding(gameIp: string, attestationIp: string): Finding {
  if (normaliseIp(gameIp) === normaliseIp(attestationIp)) return { met: true };
  return {
    met: false,
    detail: 'Attestation kam von einer anderen Adresse als die Spielverbindung',
  };
}

/**
 * Makes IPv4-mapped IPv6 addresses comparable with their IPv4 form.
 *
 * A FiveM server on a dual-stack host reports `203.0.113.42` while the same client reaches
 * the backend as `::ffff:203.0.113.42`. Without this the relay check would deny an entirely
 * ordinary setup.
 */
export function normaliseIp(address: string): string {
  const lowered = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lowered);
  return mapped?.[1] ?? lowered;
}

function reasonFor(id: RequirementId): DenyReason {
  switch (id) {
    case 'game_process_present':
      return 'game_process_missing';
    case 'network_origin_matches':
      return 'network_origin_mismatch';
    default:
      return 'policy_not_met';
  }
}

function result(
  requirement: RequirementId,
  status: RequirementStatus,
  detail?: string,
): RequirementResult {
  return detail === undefined ? { requirement, status } : { requirement, status, detail };
}
