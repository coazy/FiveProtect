import { describe, expect, it } from 'vitest';

import { TIMING } from '../attestation/service.js';
import { buildLiveness } from '../routes/sessions.js';

/**
 * Heartbeat boundaries, without a stopwatch.
 *
 * Design document 5.5: a companion restart or a short network drop must survive; a
 * deliberate exit must not. That is a handful of seconds either side of a boundary, which
 * is precisely the kind of thing that is untestable against a real clock and trivial
 * against an injected one.
 */

const INTERVAL = TIMING.heartbeatIntervalSeconds;
const GRACE = TIMING.heartbeatGraceSeconds;

function session(overrides: Partial<Parameters<typeof buildLiveness>[0]> = {}) {
  return {
    id: '1b4e28ba-2fa1-4d3b-8f2e-9c1d0e5a7b63',
    state: 'active',
    lastHeartbeatAt: new Date('2026-08-04T14:00:00.000Z'),
    graceExpiresAt: null,
    terminationReason: null,
    ...overrides,
  };
}

function at(secondsAfterHeartbeat: number): Date {
  return new Date(new Date('2026-08-04T14:00:00.000Z').getTime() + secondsAfterHeartbeat * 1000);
}

describe('a companion reporting on time', () => {
  it('keeps the player in with no warning', () => {
    const result = buildLiveness(session(), at(30));
    expect(result.shouldKick).toBe(false);
    expect(result.graceExpiresAt).toBeUndefined();
  });

  it('is still fine one second before the interval runs out', () => {
    const result = buildLiveness(session(), at(INTERVAL - 1));
    expect(result.shouldKick).toBe(false);
    expect(result.graceExpiresAt).toBeUndefined();
  });
});

describe('a late companion', () => {
  it('starts the grace period and exposes its end so the player can be warned', () => {
    const result = buildLiveness(session(), at(INTERVAL + 1));
    expect(result.shouldKick).toBe(false);
    expect(result.graceExpiresAt).toBe(at(INTERVAL + GRACE).toISOString());
  });

  it('survives a restart that takes almost the whole grace period', () => {
    const result = buildLiveness(session(), at(INTERVAL + GRACE - 1));
    expect(result.shouldKick).toBe(false);
  });

  it('is kicked once the grace period has run out', () => {
    const result = buildLiveness(session(), at(INTERVAL + GRACE));
    expect(result.shouldKick).toBe(true);
    expect(result.reason).toBe('heartbeat_lost');
  });

  it('stays kicked well past the boundary', () => {
    expect(buildLiveness(session(), at(INTERVAL + GRACE + 3600)).shouldKick).toBe(true);
  });
});

describe('sessions that are not running', () => {
  it('kicks a terminated session and carries the stored reason', () => {
    const result = buildLiveness(
      session({ state: 'terminated', terminationReason: 'banned' }),
      at(0),
    );
    expect(result.shouldKick).toBe(true);
    expect(result.reason).toBe('banned');
  });

  it('does not kick a session that is still waiting for its attestation', () => {
    const result = buildLiveness(session({ state: 'pending', lastHeartbeatAt: null }), at(9999));
    expect(result.shouldKick).toBe(false);
  });

  it('does not kick an active session that has not beaten once yet', () => {
    // The verdict sets the first heartbeat, so this is a narrow window — but a null here
    // must not be read as "silent for ever".
    const result = buildLiveness(session({ lastHeartbeatAt: null }), at(9999));
    expect(result.shouldKick).toBe(false);
  });
});
