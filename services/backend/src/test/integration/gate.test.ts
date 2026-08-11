import type { AttestationRequest, SystemSnapshot } from '@fiveprotect/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import type { Database } from '../../db/pool.js';
import {
  acceptBuild,
  hasDatabase,
  seedTenant,
  setupDatabase,
  truncateAll,
  type SeededTenant,
} from '../support/database.js';

/**
 * The connect flow from design document 5.1, end to end against a real database.
 *
 * These are the cases that cannot be proven by unit tests: single-use nonces under
 * concurrency, tenant scoping, and what the gate does when nothing attests.
 */

const BUILD_HASH = 'b'.repeat(64);

/**
 * app.inject reports 127.0.0.1 as the source address, so a test that wants the relay check
 * to pass has to hand the same address in as the game IP. Tests that are about something
 * else use this; the relay tests deliberately do not, because a mismatch is their subject.
 */
const LOCAL_IP = '127.0.0.1';

const suite = hasDatabase ? describe : describe.skip;

suite('connect gate', () => {
  let db: Database;
  let app: FastifyInstance;
  let tenant: SeededTenant;

  beforeAll(async () => {
    db = await setupDatabase();
    app = await buildApp({
      config: loadConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        PUBLIC_BASE_URL: 'https://api.test.fiveprotect.dev',
        NONCE_SEAL_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        LOG_LEVEL: 'error',
        NODE_ENV: 'test',
      }),
      db,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  beforeEach(async () => {
    await truncateAll(db);
    tenant = await seedTenant(db, { policyTier: 'standard' });
    await acceptBuild(db, BUILD_HASH);
  });

  function snapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
    return {
      schemaVersion: 1,
      collectedAt: new Date().toISOString(),
      companionVersion: '0.1.0',
      companionBuildHash: BUILD_HASH,
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
        pid: 4242,
        startedAtUnixMs: Date.now() - 60_000,
        imageName: 'FiveM_GTAProcess.exe',
        mainWindowPresent: true,
      },
      probeErrors: [],
      ...overrides,
    };
  }

  async function requestNonce(
    key = tenant.serverKey,
    serverId = tenant.serverId,
    ip = '203.0.113.42',
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/sessions/nonce',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        serverId,
        player: { license: 'license:1100001abcdef', ip },
        protocolVersion: 1,
      },
    });
  }

  async function attest(nonce: string, override: Partial<SystemSnapshot> = {}) {
    const body: AttestationRequest = {
      nonce,
      snapshot: snapshot(override),
      protocolVersion: 1,
    };
    return app.inject({ method: 'POST', url: '/v1/attest', payload: body });
  }

  async function pollVerdict(nonce: string, key = tenant.serverKey) {
    return app.inject({
      method: 'POST',
      url: '/v1/sessions/verdict',
      headers: { authorization: `Bearer ${key}` },
      payload: { nonce },
    });
  }

  describe('the happy path', () => {
    it('issues a nonce, accepts an attestation and answers allow', async () => {
      const issued = await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP);
      expect(issued.statusCode).toBe(201);
      const { nonce, sessionId, policyTier } = issued.json<{
        nonce: string;
        sessionId: string;
        policyTier: string;
      }>();
      expect(nonce).toHaveLength(64);
      expect(policyTier).toBe('standard');

      const ack = await attest(nonce);
      expect(ack.statusCode).toBe(202);
      // ADR 0004: the acknowledgement carries no judgement.
      const ackBody = ack.json<Record<string, unknown>>();
      expect(Object.keys(ackBody).sort()).toEqual(
        ['accepted', 'heartbeatIntervalSeconds', 'receivedAt', 'sessionId'].sort(),
      );

      const verdict = await pollVerdict(nonce);
      expect(verdict.statusCode).toBe(200);
      const body = verdict.json<{ decision: string; sessionId: string; failOpen: boolean }>();
      expect(body.decision).toBe('allow');
      expect(body.sessionId).toBe(sessionId);
      expect(body.failOpen).toBe(false);
    });

    it('stores the raw snapshot as evidence', async () => {
      const { nonce } = (await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP)).json<{
        nonce: string;
      }>();
      await attest(nonce);

      const { rows } = await db.query<{ payload: SystemSnapshot; count: string }>(
        'SELECT payload FROM system_snapshots WHERE tenant_id = $1',
        [tenant.tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.companionBuildHash).toBe(BUILD_HASH);
    });
  });

  describe('the nonce is single use', () => {
    it('refuses a second attestation for the same nonce', async () => {
      const { nonce } = (await requestNonce()).json<{ nonce: string }>();

      expect((await attest(nonce)).statusCode).toBe(202);
      const second = await attest(nonce);
      expect(second.statusCode).toBe(409);
      expect(second.json<{ code: string }>().code).toBe('nonce_reused');
    });

    it('lets exactly one of ten simultaneous attestations through', async () => {
      // The claim is a single conditional UPDATE, so the database arbitrates. A read
      // followed by a write would let several of these pass.
      const { nonce } = (await requestNonce()).json<{ nonce: string }>();

      const results = await Promise.all(Array.from({ length: 10 }, () => attest(nonce)));
      const accepted = results.filter((response) => response.statusCode === 202);
      const refused = results.filter((response) => response.statusCode === 409);

      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(9);
    });

    it('refuses an expired nonce', async () => {
      const { nonce } = (await requestNonce()).json<{ nonce: string }>();
      await db.query("UPDATE attestation_sessions SET expires_at = now() - interval '1 second'");

      const response = await attest(nonce);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('nonce_expired');
    });

    it('refuses a nonce nobody issued', async () => {
      const response = await attest('f'.repeat(64));
      expect(response.statusCode).toBe(404);
    });
  });

  describe('policy is applied per tenant', () => {
    it('denies a machine without HVCI at standard and explains why', async () => {
      const { nonce } = (await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP)).json<{
        nonce: string;
      }>();
      await attest(nonce, {
        features: { ...snapshot().features, hvci: 'disabled' },
        probeErrors: ['hvci_blocked_by:rtcore64.sys'],
      });

      const body = (await pollVerdict(nonce)).json<{
        decision: string;
        reasons: string[];
        remediation?: string;
      }>();
      expect(body.decision).toBe('deny');
      expect(body.reasons).toContain('policy_not_met');
      expect(body.remediation).toContain('rtcore64.sys');
    });

    it('lets the same machine in for a tenant on the relaxed tier', async () => {
      const relaxed = await seedTenant(db, { policyTier: 'relaxed', name: 'Relaxed Tenant' });
      const issued = await requestNonce(relaxed.serverKey, relaxed.serverId, LOCAL_IP);
      const { nonce } = issued.json<{ nonce: string }>();

      await attest(nonce, { features: { ...snapshot().features, hvci: 'disabled' } });

      const body = (await pollVerdict(nonce, relaxed.serverKey)).json<{ decision: string }>();
      expect(body.decision).toBe('allow');
    });
  });

  describe('the relay countermeasure', () => {
    it('denies when the attestation arrives from a different address', async () => {
      // app.inject reports 127.0.0.1 as the source, so a game IP of 203.0.113.42 is a
      // mismatch — the same shape as a companion attesting from another machine.
      const { nonce } = (
        await requestNonce(tenant.serverKey, tenant.serverId, '203.0.113.42')
      ).json<{ nonce: string }>();
      await attest(nonce);

      const body = (await pollVerdict(nonce)).json<{ decision: string; reasons: string[] }>();
      expect(body.decision).toBe('deny');
      expect(body.reasons).toContain('network_origin_mismatch');
    });

    it('allows when both addresses agree', async () => {
      const { nonce } = (await requestNonce(tenant.serverKey, tenant.serverId, '127.0.0.1')).json<{
        nonce: string;
      }>();
      await attest(nonce);
      expect((await pollVerdict(nonce)).json<{ decision: string }>().decision).toBe('allow');
    });
  });

  describe('when no attestation ever arrives', () => {
    // ADR 0005. This is the path that decides what happens during an outage, and it is only
    // reachable by letting the long poll run out — which is why the test budget is set above
    // the poll window rather than the poll window below the budget.
    it('lets the player in under fail-open and marks the session', async () => {
      const { nonce } = (await requestNonce()).json<{ nonce: string }>();

      const verdict = (await pollVerdict(nonce)).json<{
        decision: string;
        failOpen: boolean;
        requirements: { requirement: string; status: string }[];
      }>();

      expect(verdict.decision).toBe('allow');
      // Never silently: a session admitted while the backend was degraded has to stay
      // identifiable afterwards.
      expect(verdict.failOpen).toBe(true);
      expect(verdict.requirements[0]?.requirement).toBe('companion_attested');
      expect(verdict.requirements[0]?.status).toBe('fail');

      const { rows } = await db.query<{ failOpen: boolean }>(
        'SELECT fail_open AS "failOpen" FROM attestation_sessions WHERE nonce_hash IS NOT NULL',
      );
      expect(rows[0]?.failOpen).toBe(true);
    });

    it('refuses the player under fail-closed and explains why', async () => {
      const strict = await seedTenant(db, { failMode: 'fail_closed', name: 'Strict Tenant' });
      const { nonce } = (await requestNonce(strict.serverKey, strict.serverId)).json<{
        nonce: string;
      }>();

      const verdict = (await pollVerdict(nonce, strict.serverKey)).json<{
        decision: string;
        reasons: string[];
        remediation?: string;
        failOpen: boolean;
      }>();

      expect(verdict.decision).toBe('deny');
      expect(verdict.reasons).toContain('companion_timeout');
      expect(verdict.remediation).toBeDefined();
      expect(verdict.failOpen).toBe(false);
    });

    it('answers a second poll from the stored verdict rather than waiting again', async () => {
      const { nonce } = (await requestNonce()).json<{ nonce: string }>();
      await pollVerdict(nonce);

      const startedAt = Date.now();
      const second = (await pollVerdict(nonce)).json<{ decision: string }>();
      // The timeout verdict is written, so the second poll is a lookup. Without that a
      // reconnecting player would wait out the window a second time.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(second.decision).toBe('allow');
    });
  });

  describe('tenant isolation', () => {
    it("does not let one tenant read another tenant's session", async () => {
      const other = await seedTenant(db, { name: 'Other Tenant' });
      const { nonce } = (await requestNonce()).json<{ nonce: string }>();
      await attest(nonce);

      const response = await pollVerdict(nonce, other.serverKey);
      expect(response.statusCode).toBe(404);
    });

    it('keeps player identities separate per tenant', async () => {
      const other = await seedTenant(db, { name: 'Other Tenant' });
      await requestNonce();
      await requestNonce(other.serverKey, other.serverId);

      const { rows } = await db.query<{ tenantId: string }>(
        'SELECT tenant_id AS "tenantId" FROM player_identities ORDER BY tenant_id',
      );
      // The same licence at two customers is two records, not one shared one.
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.tenantId)).size).toBe(2);
    });

    it('refuses a server key pointed at another server of the same tenant', async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO game_servers (tenant_id, name, server_key_hash)
              VALUES ($1, 'Second Server', 'deadbeef') RETURNING id`,
        [tenant.tenantId],
      );
      const response = await requestNonce(tenant.serverKey, rows[0]?.id);
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('server_mismatch');
    });
  });

  describe('authentication', () => {
    it('refuses a missing key', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions/nonce',
        payload: {
          serverId: tenant.serverId,
          player: { license: 'x', ip: '1.2.3.4' },
          protocolVersion: 1,
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it('answers the same way for an unknown and a wrong key', async () => {
      const unknown = await requestNonce('0'.repeat(64));
      const malformed = await requestNonce('not-a-key');
      expect(unknown.statusCode).toBe(401);
      expect(malformed.statusCode).toBe(401);
      expect(unknown.json<{ code: string }>().code).toBe(malformed.json<{ code: string }>().code);
    });

    it('refuses a tenant whose licence is not active', async () => {
      await db.query("UPDATE tenants SET license_status = 'suspended' WHERE id = $1", [
        tenant.tenantId,
      ]);
      const response = await requestNonce();
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('license_inactive');
    });
  });

  describe('build pinning', () => {
    it('denies a companion build that is not on the accepted list', async () => {
      const { nonce } = (await requestNonce(tenant.serverKey, tenant.serverId, '127.0.0.1')).json<{
        nonce: string;
      }>();
      await attest(nonce, { companionBuildHash: 'c'.repeat(64) });

      const body = (await pollVerdict(nonce)).json<{ decision: string; reasons: string[] }>();
      expect(body.decision).toBe('deny');
      expect(body.reasons).toContain('companion_outdated');
    });
  });

  describe('closing the companion ends the session', () => {
    // Design document 5.5 wants a companion restart to survive and a deliberate exit not
    // to. Both look the same to a heartbeat that simply stops, and both then cost the full
    // interval plus grace — so quitting on purpose bought three and a half minutes of
    // playing without a companion. The last heartbeat says which one it is.
    async function activeSession() {
      const { nonce } = (await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP)).json<{
        nonce: string;
      }>();
      const ack = (await attest(nonce)).json<{ sessionId: string }>();
      return ack.sessionId;
    }

    function beat(sessionId: string, extra: Record<string, unknown> = {}) {
      return app.inject({
        method: 'POST',
        url: '/v1/sessions/heartbeat',
        payload: {
          sessionId,
          companionBuildHash: BUILD_HASH,
          uptimeSeconds: 60,
          gameProcessPresent: true,
          protocolVersion: 1,
          ...extra,
        },
      });
    }

    function liveness(sessionId: string) {
      return app.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}/liveness`,
        headers: { authorization: `Bearer ${tenant.serverKey}` },
      });
    }

    it('keeps the session alive on an ordinary heartbeat', async () => {
      const sessionId = await activeSession();

      const answer = (await beat(sessionId)).json<{ acknowledged: boolean; terminate: boolean }>();
      expect(answer.acknowledged).toBe(true);
      expect(answer.terminate).toBe(false);

      const alive = (await liveness(sessionId)).json<{ shouldKick: boolean }>();
      expect(alive.shouldKick).toBe(false);
    });

    it('ends the session when the companion says it is closing', async () => {
      const sessionId = await activeSession();
      await beat(sessionId);

      const answer = (await beat(sessionId, { closing: true })).json<{
        acknowledged: boolean;
        terminate: boolean;
        terminateReason: string;
      }>();
      expect(answer.terminate).toBe(true);
      expect(answer.terminateReason).toBe('heartbeat_lost');

      // The resource asks this on its next poll and drops the player on the answer.
      const after = (await liveness(sessionId)).json<{ shouldKick: boolean; reason: string }>();
      expect(after.shouldKick).toBe(true);
      expect(after.reason).toBe('heartbeat_lost');
    });

    it('refuses to keep beating for a session that has been closed', async () => {
      const sessionId = await activeSession();
      await beat(sessionId, { closing: true });

      // A companion restarted after the close must not be able to revive the old session —
      // it has to attest again against a fresh nonce.
      const answer = (await beat(sessionId)).json<{ terminate: boolean }>();
      expect(answer.terminate).toBe(true);
    });

    it('ends the session when the game is gone, closing or not', async () => {
      const sessionId = await activeSession();

      const answer = (await beat(sessionId, { gameProcessPresent: false })).json<{
        terminate: boolean;
        terminateReason: string;
      }>();
      expect(answer.terminate).toBe(true);
      expect(answer.terminateReason).toBe('game_process_missing');
    });
  });

  describe('the companion collects its own nonce', () => {
    // ADR 0010. FiveM does not run client resources while a player is held in a deferral,
    // so this endpoint is the only way the nonce reaches the companion at the moment the
    // gate needs it. If it stops working the gate silently degrades to its timeout path,
    // which under fail_open lets everybody in unchecked.
    async function pollPending(waitSeconds = 0) {
      return app.inject({
        method: 'POST',
        url: '/v1/companion/pending',
        payload: { companionVersion: '0.1.0', waitSeconds, protocolVersion: 1 },
      });
    }

    it('hands out the nonce issued for this address', async () => {
      const issued = await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP);
      const { nonce } = issued.json<{ nonce: string }>();

      const collected = await pollPending();
      expect(collected.statusCode).toBe(200);

      const answer = collected.json<{ pending: boolean; nonce: string; serverName: string }>();
      expect(answer.pending).toBe(true);
      expect(answer.nonce).toBe(nonce);
      expect(answer.serverName).toBeTypeOf('string');
    });

    it('answers empty when nobody from this address is connecting', async () => {
      const answer = (await pollPending()).json<{ pending: boolean; nonce?: string }>();
      expect(answer.pending).toBe(false);
      expect(answer.nonce).toBeUndefined();
    });

    it('refuses to guess when two connects are pending from one address', async () => {
      // Two players behind one NAT. Handing either nonce out would let one machine's
      // snapshot answer the other player's session — which is how a cheater borrows a clean
      // machine. Both are refused instead.
      await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP);
      await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP);

      const collected = await pollPending();
      expect(collected.statusCode).toBe(409);
      expect(collected.json<{ code: string }>().code).toBe('origin_ambiguous');
    });

    it('does not hand out a nonce issued for a different address', async () => {
      await requestNonce(tenant.serverKey, tenant.serverId, '203.0.113.42');

      const answer = (await pollPending()).json<{ pending: boolean }>();
      expect(answer.pending).toBe(false);
    });

    it('stops handing out a nonce once it has been used', async () => {
      const { nonce } = (await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP)).json<{
        nonce: string;
      }>();

      expect((await attest(nonce)).statusCode).toBe(202);

      // The sealed copy is cleared in the same statement that claims the session, so there
      // is nothing left to hand out — and a replayed poll cannot re-collect a live nonce.
      const answer = (await pollPending()).json<{ pending: boolean }>();
      expect(answer.pending).toBe(false);
    });

    it('never reveals a verdict, not even for a session it just handed out', async () => {
      // The same rule as everywhere else (ADR 0004). This endpoint is unauthenticated, so a
      // field here would be readable by any local process.
      const { nonce } = (await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP)).json<{
        nonce: string;
      }>();
      await attest(nonce, { features: { ...snapshot().features, testSigning: 'enabled' } });

      await requestNonce(tenant.serverKey, tenant.serverId, LOCAL_IP);
      const fields = Object.keys((await pollPending()).json<object>()).sort();

      expect(fields).toEqual(
        ['expiresAt', 'nonce', 'pending', 'policyTier', 'protocolVersion', 'serverName'].sort(),
      );
    });

    it('refuses a poll that does not match the protocol', async () => {
      const answer = await app.inject({
        method: 'POST',
        url: '/v1/companion/pending',
        payload: { companionVersion: 'not a version', waitSeconds: 999, protocolVersion: 1 },
      });
      expect(answer.statusCode).toBe(400);
    });
  });

  describe('the companion never learns the verdict', () => {
    it('acknowledges a denied attestation exactly like an allowed one', async () => {
      // Telling the companion whether it passed would hand an attacker a local oracle to
      // test modifications against.
      const clean = (await requestNonce(tenant.serverKey, tenant.serverId, '127.0.0.1')).json<{
        nonce: string;
      }>();
      const dirty = (await requestNonce(tenant.serverKey, tenant.serverId, '127.0.0.1')).json<{
        nonce: string;
      }>();

      const allowed = await attest(clean.nonce);
      const denied = await attest(dirty.nonce, {
        features: { ...snapshot().features, secureBoot: 'disabled' },
      });

      expect(allowed.statusCode).toBe(denied.statusCode);
      expect(Object.keys(allowed.json<object>()).sort()).toEqual(
        Object.keys(denied.json<object>()).sort(),
      );
      expect((await pollVerdict(dirty.nonce)).json<{ decision: string }>().decision).toBe('deny');
    });
  });
});
