import type { RequirementResult } from '@fiveprotect/protocol';
import { describe, expect, it } from 'vitest';

import { buildRemediation } from '../attestation/remediation.js';

/**
 * Design document 12.2 calls the block screen the most important screen in the product.
 * These tests are about whether a player can act on what they read, which is why they
 * assert on content rather than on the presence of a string.
 */

function fail(requirement: RequirementResult['requirement'], detail?: string): RequirementResult {
  return detail === undefined
    ? { requirement, status: 'fail' }
    : { requirement, status: 'fail', detail };
}

describe('the text tells the player what to do', () => {
  it('names the concrete step for Secure Boot instead of just the state', () => {
    const text = buildRemediation(['policy_not_met'], [fail('secure_boot_enabled')]);
    expect(text).toBeDefined();
    expect(text).toContain('UEFI');
    expect(text).toMatch(/Secure Boot/);
    // The most common follow-up ticket is "the option is greyed out".
    expect(text).toContain('CSM');
  });

  it('names the blocking driver when Windows revealed it', () => {
    const text = buildRemediation(
      ['policy_not_met'],
      [fail('hvci_enabled', 'blockiert durch rtcore64.sys')],
    );
    expect(text).toContain('rtcore64.sys');
    expect(text).toContain('Kernisolierung');
  });

  it('falls back to a generic HVCI instruction when the driver is unknown', () => {
    const text = buildRemediation(['policy_not_met'], [fail('hvci_enabled')]);
    expect(text).toContain('Kernisolierung');
    expect(text).not.toContain('undefined');
  });

  it('gives the exact command for test signing', () => {
    const text = buildRemediation(['policy_not_met'], [fail('test_signing_disabled')]);
    expect(text).toContain('bcdedit /set testsigning off');
  });

  it('mentions the vendor names for TPM, because the UEFI label differs', () => {
    const text = buildRemediation(['policy_not_met'], [fail('tpm_attestation_valid')]);
    expect(text).toContain('PTT');
    expect(text).toContain('fTPM');
  });
});

describe('only one problem is explained', () => {
  it('picks the first blocking requirement rather than listing all of them', () => {
    // A list of five problems reads as insurmountable; one with one instruction gets acted
    // on.
    const text = buildRemediation(
      ['policy_not_met'],
      [fail('secure_boot_enabled'), fail('hvci_enabled'), fail('driver_blocklist_enabled')],
    );
    expect(text).toContain('UEFI');
    expect(text).not.toContain('Kernisolierung');
  });
});

describe('an unreadable probe reads differently from a switched-off feature', () => {
  it('adds a note when the state could not be determined', () => {
    const text = buildRemediation(
      ['policy_not_met'],
      [{ requirement: 'secure_boot_enabled', status: 'unknown' }],
    );
    expect(text).toContain('nicht sicher auslesen');
    expect(text).toContain('Administratorrechten');
  });
});

describe('reasons without a matching requirement', () => {
  it('explains a missing companion', () => {
    expect(buildRemediation(['companion_missing'], [])).toContain('FiveProtect läuft nicht');
  });

  it('tells an outdated companion to restart rather than to download something', () => {
    // The updater does the work; sending a player to a download page invites a fake one.
    const text = buildRemediation(['companion_outdated'], []);
    expect(text).toContain('aktualisiert sich');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('does not blame the player for a backend outage', () => {
    const text = buildRemediation(['backend_unavailable'], []);
    expect(text).toContain('nicht erreichbar');
    expect(text).toContain('erneut');
  });

  it('returns nothing when there is nothing useful to say', () => {
    expect(buildRemediation([], [])).toBeUndefined();
  });
});

describe('the text stays player-facing', () => {
  it('never leaks an internal reason code', () => {
    const codes = ['policy_not_met', 'network_origin_mismatch', 'game_process_missing'] as const;
    for (const code of codes) {
      const text = buildRemediation([code], []) ?? '';
      expect(text, code).not.toContain(code);
    }
  });
});
