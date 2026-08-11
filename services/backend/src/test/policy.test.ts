import type { PolicyTier, SystemSnapshot } from '@fiveprotect/protocol';
import { describe, expect, it } from 'vitest';

import {
  PHASE_1_OVERRIDES,
  POLICY_TABLE,
  TARGET_POLICY_TABLE,
  evaluatePolicy,
  normaliseIp,
  type PolicyInput,
} from '../attestation/policy.js';

/**
 * The policy engine is the only thing standing between a cheater and a server, and it is a
 * pure function. That is the point: every case below is a scenario a customer will
 * eventually hit, and none of them needs a database or a spare machine to reproduce.
 */

const CLEAN_SNAPSHOT: SystemSnapshot = {
  schemaVersion: 1,
  collectedAt: '2026-08-04T14:22:31.412Z',
  companionVersion: '0.1.0',
  companionBuildHash: 'a'.repeat(64),
  osBuild: '10.0.26100',
  features: {
    secureBoot: 'enabled',
    hvci: 'enabled',
    testSigning: 'disabled',
    kernelDebugging: 'disabled',
    driverBlocklist: 'enabled',
    iommu: 'enabled',
    virtualizationBasedSecurity: 'enabled',
  },
  tpm: { present: true, manufacturer: 'IFX', specVersion: '2.0' },
  gameProcess: {
    pid: 14872,
    startedAtUnixMs: 1786000951000,
    imageName: 'FiveM_GTAProcess.exe',
    mainWindowPresent: true,
  },
  probeErrors: [],
};

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tier: 'standard',
    snapshot: CLEAN_SNAPSHOT,
    gameIp: '203.0.113.42',
    attestationIp: '203.0.113.42',
    buildAccepted: true,
    ...overrides,
  };
}

function withFeatures(patch: Partial<SystemSnapshot['features']>): SystemSnapshot {
  return { ...CLEAN_SNAPSHOT, features: { ...CLEAN_SNAPSHOT.features, ...patch } };
}

function statusOf(outcome: ReturnType<typeof evaluatePolicy>, requirement: string): string {
  return (
    outcome.requirements.find((entry) => entry.requirement === requirement)?.status ?? 'absent'
  );
}

describe('a clean machine', () => {
  for (const tier of ['relaxed', 'standard', 'strict'] as PolicyTier[]) {
    it(`is allowed at tier ${tier}`, () => {
      const outcome = evaluatePolicy(input({ tier }));
      expect(outcome.decision, JSON.stringify(outcome.reasons)).toBe('allow');
      expect(outcome.reasons).toEqual([]);
    });
  }
});

describe('the tier decides what blocks', () => {
  it('lets a machine without Secure Boot in at relaxed', () => {
    const snapshot = withFeatures({ secureBoot: 'disabled', hvci: 'disabled' });
    const outcome = evaluatePolicy(input({ tier: 'relaxed', snapshot }));
    expect(outcome.decision).toBe('allow');
    expect(statusOf(outcome, 'secure_boot_enabled')).toBe('skipped');
  });

  it('refuses the same machine at standard', () => {
    const snapshot = withFeatures({ secureBoot: 'disabled', hvci: 'disabled' });
    const outcome = evaluatePolicy(input({ tier: 'standard', snapshot }));
    expect(outcome.decision).toBe('deny');
    expect(outcome.reasons).toContain('policy_not_met');
    expect(statusOf(outcome, 'secure_boot_enabled')).toBe('fail');
  });

  it('warns about IOMMU at standard but blocks at strict', () => {
    const snapshot = withFeatures({ iommu: 'disabled' });

    const standard = evaluatePolicy(input({ tier: 'standard', snapshot }));
    expect(standard.decision).toBe('allow');
    expect(statusOf(standard, 'iommu_enabled')).toBe('warn');

    const strict = evaluatePolicy(input({ tier: 'strict', snapshot }));
    expect(strict.decision).toBe('deny');
    expect(statusOf(strict, 'iommu_enabled')).toBe('fail');
  });

  it('blocks test signing at every tier', () => {
    const snapshot = withFeatures({ testSigning: 'enabled' });
    for (const tier of ['relaxed', 'standard', 'strict'] as PolicyTier[]) {
      expect(evaluatePolicy(input({ tier, snapshot })).decision, tier).toBe('deny');
    }
  });

  it('blocks an attached kernel debugger at every tier', () => {
    const snapshot = withFeatures({ kernelDebugging: 'enabled' });
    for (const tier of ['relaxed', 'standard', 'strict'] as PolicyTier[]) {
      expect(evaluatePolicy(input({ tier, snapshot })).decision, tier).toBe('deny');
    }
  });
});

describe('unknown is never a pass', () => {
  // A probe that could not answer is a gap in the evidence. Treating it as "fine" would
  // hand an attacker a way to pass by breaking the probe rather than fixing the machine.
  it('denies at a blocking tier and says so', () => {
    const snapshot = withFeatures({ hvci: 'unknown' });
    const outcome = evaluatePolicy(input({ tier: 'standard', snapshot }));
    expect(outcome.decision).toBe('deny');
    expect(statusOf(outcome, 'hvci_enabled')).toBe('unknown');
  });

  it('reports unknown rather than warn where the tier only warns', () => {
    const snapshot = withFeatures({ iommu: 'unknown' });
    const outcome = evaluatePolicy(input({ tier: 'standard', snapshot }));
    expect(outcome.decision).toBe('allow');
    expect(statusOf(outcome, 'iommu_enabled')).toBe('unknown');
  });
});

describe('HVCI names the driver that blocks it', () => {
  // Design document 7.4: players whose HVCI is off because of an audio interface never
  // cheated. Naming the driver is the difference between a support ticket and none.
  it('carries the driver name into the requirement detail', () => {
    const snapshot: SystemSnapshot = {
      ...withFeatures({ hvci: 'disabled' }),
      probeErrors: ['hvci_blocked_by:rtcore64.sys'],
    };
    const outcome = evaluatePolicy(input({ tier: 'standard', snapshot }));
    const requirement = outcome.requirements.find((entry) => entry.requirement === 'hvci_enabled');
    expect(requirement?.detail).toContain('rtcore64.sys');
  });
});

describe('relay countermeasures', () => {
  it('denies when the attestation came from a different address', () => {
    const outcome = evaluatePolicy(input({ attestationIp: '198.51.100.7' }));
    expect(outcome.decision).toBe('deny');
    expect(outcome.reasons).toContain('network_origin_mismatch');
  });

  it('accepts an IPv4-mapped IPv6 address as the same host', () => {
    // A dual-stack FiveM server reports 203.0.113.42 while the same client reaches the
    // backend as ::ffff:203.0.113.42. Denying that would break an ordinary setup.
    const outcome = evaluatePolicy(input({ attestationIp: '::ffff:203.0.113.42' }));
    expect(outcome.decision).toBe('allow');
  });

  it('denies when no local FiveM process was seen', () => {
    const snapshot: SystemSnapshot = { ...CLEAN_SNAPSHOT };
    delete (snapshot as { gameProcess?: unknown }).gameProcess;
    const outcome = evaluatePolicy(input({ snapshot }));
    expect(outcome.decision).toBe('deny');
    expect(outcome.reasons).toContain('game_process_missing');
  });

  it('normalises addresses consistently', () => {
    expect(normaliseIp('::FFFF:203.0.113.42')).toBe('203.0.113.42');
    expect(normaliseIp(' 203.0.113.42 ')).toBe('203.0.113.42');
    expect(normaliseIp('2001:DB8::1')).toBe('2001:db8::1');
  });
});

describe('build pinning', () => {
  it('denies an unrecognised companion build', () => {
    const outcome = evaluatePolicy(input({ buildAccepted: false }));
    expect(outcome.decision).toBe('deny');
    expect(outcome.reasons).toContain('companion_outdated');
  });
});

describe('TPM in phase 1', () => {
  it('denies at standard when no TPM is present', () => {
    const snapshot: SystemSnapshot = { ...CLEAN_SNAPSHOT, tpm: { present: false } };
    const outcome = evaluatePolicy(input({ tier: 'standard', snapshot }));
    expect(outcome.decision).toBe('deny');
    expect(statusOf(outcome, 'tpm_attestation_valid')).toBe('fail');
  });

  it('says out loud that only presence was checked', () => {
    // Honesty in the evidence: phase 1 cannot verify a quote, and the requirement detail
    // must not imply otherwise.
    const outcome = evaluatePolicy(input({ tier: 'standard' }));
    const requirement = outcome.requirements.find(
      (entry) => entry.requirement === 'tpm_attestation_valid',
    );
    expect(requirement?.status).toBe('pass');
    expect(requirement?.detail).toContain('Phase 2');
  });
});

describe('the gap between the target policy and what phase 1 enforces', () => {
  // The overrides exist so a requirement the engine cannot evaluate does not deny everyone.
  // Keeping them as data — rather than quietly editing the table — makes the gap reviewable
  // and gives phase 3 a checklist.
  it('lists exactly the requirements phase 1 cannot evaluate', () => {
    expect(Object.keys(PHASE_1_OVERRIDES)).toEqual(['vulnerable_drivers_absent']);
  });

  it('leaves every other requirement at its target enforcement', () => {
    for (const [id, tiers] of Object.entries(TARGET_POLICY_TABLE)) {
      if (id in PHASE_1_OVERRIDES) continue;
      expect(POLICY_TABLE[id as keyof typeof POLICY_TABLE], id).toEqual(tiers);
    }
  });

  it('does not let an unevaluable requirement deny a clean machine', () => {
    const outcome = evaluatePolicy(input({ tier: 'strict' }));
    expect(statusOf(outcome, 'vulnerable_drivers_absent')).toBe('skipped');
    expect(outcome.decision).toBe('allow');
  });
});

describe('the report', () => {
  it('covers every requirement in the table', () => {
    const outcome = evaluatePolicy(input());
    const reported = outcome.requirements.map((entry) => entry.requirement).sort();
    expect(reported).toEqual(Object.keys(TARGET_POLICY_TABLE).sort());
  });

  it('collapses several failures into one reason each, without duplicates', () => {
    const snapshot = withFeatures({
      secureBoot: 'disabled',
      hvci: 'disabled',
      driverBlocklist: 'disabled',
    });
    const outcome = evaluatePolicy(input({ tier: 'standard', snapshot }));
    expect(outcome.reasons).toEqual(['policy_not_met']);
  });
});
