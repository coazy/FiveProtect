import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { STATES, render } from './app.js';

/**
 * The window, rendered against the real markup.
 *
 * The blocked screen is the one that matters: design document 12.2 calls it the most
 * important screen in the product, because that is where the support load is decided.
 * These tests are about whether a player can read it and act, not about pixels.
 */

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

function load() {
  document.documentElement.innerHTML = html;
  return document;
}

const READY_REQUIREMENTS = [
  { requirement: 'secure_boot_enabled', status: 'pass' },
  { requirement: 'tpm_attestation_valid', status: 'pass' },
  { requirement: 'hvci_enabled', status: 'pass' },
  { requirement: 'companion_attested', status: 'pass' },
];

beforeEach(() => {
  load();
});

describe('the four states', () => {
  it('renders every state the shell can be in', () => {
    // Design document 12.1: four, not more. A fifth state would need a heading here, and
    // this is what fails if one is added without one.
    for (const state of STATES) {
      render(document, { state });
      expect(document.getElementById('window').dataset.state).toBe(state);
      expect(document.getElementById('state-name').textContent.length).toBeGreaterThan(0);
    }
  });

  it('shows progress only while a check is running', () => {
    for (const state of STATES) {
      render(document, { state });
      expect(document.getElementById('progress').hidden).toBe(state !== 'checking');
    }
  });

  it('tells the player which of the two waits it is in', () => {
    // "Nothing is happening" and "nothing is supposed to be happening yet" look identical
    // in an empty window, and only one of them is a reason to go looking for a problem.
    render(document, { state: 'idle', gamePresent: false });
    const waiting = document.getElementById('waiting');
    expect(waiting.hidden).toBe(false);
    expect(document.getElementById('waiting-text').textContent).toContain('FiveM');
    expect(waiting.dataset.found).toBe('false');

    render(document, { state: 'idle', gamePresent: true });
    expect(document.getElementById('waiting-text').textContent).toContain('Server');
    expect(document.getElementById('waiting').dataset.found).toBe('true');
  });

  it('shows the waiting animation only while idle', () => {
    for (const state of STATES) {
      render(document, { state });
      expect(document.getElementById('waiting').hidden).toBe(state !== 'idle');
    }
  });

  it('offers no buttons while waiting or checking', () => {
    // A button that does nothing invites being pressed and then reported as broken.
    for (const state of ['idle', 'checking']) {
      render(document, { state });
      expect(document.getElementById('actions').hidden).toBe(true);
    }
  });
});

describe('the ready screen', () => {
  beforeEach(() => {
    render(document, {
      state: 'ready',
      requirements: READY_REQUIREMENTS,
      serverName: 'Nordstadt Roleplay',
    });
  });

  it('says the check is done without promising admission', () => {
    // The companion is never told how the server judged the snapshot (ADR 0004). On a
    // server that requires more than this machine offers, "du kannst jetzt beitreten" is
    // contradicted by the connect screen seconds later — so the ready screen reports what
    // happened here and names the server as the one that decides.
    const title = document.getElementById('callout-title').textContent;
    const body = document.getElementById('callout-body').textContent;

    expect(title).toContain('Prüfung');
    expect(title).not.toContain('kannst');
    expect(body).toContain('Server');
  });

  it('lists each requirement with a word a player recognises from Windows', () => {
    const labels = [...document.querySelectorAll('.check-label')].map((n) => n.textContent);
    // Not "HVCI" — that is not what the setting is called in the system the player will open.
    expect(labels).toContain('Speicherintegrität');
    expect(labels).toContain('Secure Boot');
    expect(labels).toContain('TPM 2.0');
  });

  it('marks every passing check with the same accent', () => {
    const values = [...document.querySelectorAll('.check-value')];
    expect(values).toHaveLength(READY_REQUIREMENTS.length);
    expect(values.every((node) => node.dataset.status === 'pass')).toBe(true);
  });

  it('names the server so the player knows which one answered', () => {
    expect(document.getElementById('server').textContent).toBe('Nordstadt Roleplay');
  });
});

describe('the blocked screen', () => {
  const REMEDIATION =
    'Die Speicherintegrität ist abgeschaltet, weil der Treiber rtcore64.sys sie blockiert. ' +
    'Deinstalliere die zugehörige Software und aktiviere sie unter Windows-Sicherheit → ' +
    'Gerätesicherheit → Kernisolierung.';

  beforeEach(() => {
    render(document, {
      state: 'blocked',
      remediation: REMEDIATION,
      requirements: [
        { requirement: 'secure_boot_enabled', status: 'pass' },
        { requirement: 'hvci_enabled', status: 'fail', detail: 'rtcore64.sys' },
        { requirement: 'companion_attested', status: 'pass' },
      ],
    });
  });

  it('shows the backend text verbatim, because only the backend knows the cause', () => {
    expect(document.getElementById('callout-body').textContent).toBe(REMEDIATION);
  });

  it('names the driver, which is the whole point of the screen', () => {
    expect(document.getElementById('callout-body').textContent).toContain('rtcore64.sys');
  });

  it('offers a way to try again and a diagnostic export', () => {
    expect(document.getElementById('actions').hidden).toBe(false);
    expect(document.getElementById('action-primary').textContent).toBe('Erneut prüfen');
    expect(document.getElementById('action-secondary').textContent).toContain('Diagnose');
  });

  it('still says something useful when the backend sent no explanation', () => {
    render(document, { state: 'blocked', requirements: [] });
    const body = document.getElementById('callout-body').textContent;
    expect(body.length).toBeGreaterThan(30);
    expect(body).not.toContain('undefined');
  });

  it('shows the failing check next to the passing ones rather than only the failure', () => {
    // Context matters: "one of four failed" is a different feeling from "failed".
    const statuses = [...document.querySelectorAll('.check-value')].map((n) => n.dataset.status);
    expect(statuses).toContain('pass');
    expect(statuses).toContain('fail');
  });
});

describe('what the window never shows', () => {
  it('hides requirements a player cannot act on', () => {
    render(document, {
      state: 'blocked',
      requirements: [{ requirement: 'network_origin_matches', status: 'fail' }],
    });
    // Telling a player "network origin mismatch" helps nobody; the remediation text explains
    // it in words instead.
    expect(document.querySelectorAll('.check-label')).toHaveLength(0);
  });

  it('hides requirements that do not apply at this tier', () => {
    render(document, {
      state: 'ready',
      requirements: [
        { requirement: 'secure_boot_enabled', status: 'pass' },
        { requirement: 'iommu_enabled', status: 'skipped' },
      ],
    });
    const labels = [...document.querySelectorAll('.check-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Secure Boot']);
  });

  it('never renders a raw requirement identifier', () => {
    render(document, {
      state: 'ready',
      requirements: Object.keys({
        secure_boot_enabled: 1,
        tpm_attestation_valid: 1,
        hvci_enabled: 1,
        driver_blocklist_enabled: 1,
        iommu_enabled: 1,
        test_signing_disabled: 1,
        kernel_debugging_disabled: 1,
        vulnerable_drivers_absent: 1,
        game_process_present: 1,
        companion_attested: 1,
      }).map((requirement) => ({ requirement, status: 'pass' })),
    });

    for (const node of document.querySelectorAll('.check-label')) {
      expect(node.textContent, node.textContent).not.toMatch(/_/);
    }
  });
});

describe('the state words', () => {
  it('says "bestanden" for a check rather than "aktiv"', () => {
    render(document, {
      state: 'ready',
      requirements: [{ requirement: 'companion_attested', status: 'pass' }],
    });
    expect(document.querySelector('.check-value').textContent).toBe('bestanden');
  });

  it('says "aus" for test signing, matching how a player thinks about it', () => {
    render(document, {
      state: 'ready',
      requirements: [{ requirement: 'test_signing_disabled', status: 'pass' }],
    });
    expect(document.querySelector('.check-value').textContent).toBe('aus');
  });

  it('distinguishes "unklar" from "inaktiv"', () => {
    // A probe that could not read a setting is not the same as a setting that is off, and
    // the player who has it switched on already needs to see that difference.
    render(document, {
      state: 'blocked',
      requirements: [{ requirement: 'hvci_enabled', status: 'unknown' }],
    });
    expect(document.querySelector('.check-value').textContent).toBe('unklar');
  });
});
