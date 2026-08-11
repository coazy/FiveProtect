-- Phase 1 schema: everything the connect gate needs, nothing it does not.
--
-- Entities from design document 11 that belong to later phases (HardwareIdentity,
-- EnvironmentBaseline, Detection, Ban, Appeal) are deliberately absent. Adding a table
-- before the code that fills it produces a schema nobody can reason about.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------------------
-- Tenants and their servers
-- --------------------------------------------------------------------------

CREATE TYPE policy_tier AS ENUM ('relaxed', 'standard', 'strict');
CREATE TYPE fail_mode AS ENUM ('fail_open', 'fail_closed');
CREATE TYPE license_status AS ENUM ('active', 'suspended', 'expired');

CREATE TABLE tenants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL,
    policy_tier         policy_tier NOT NULL DEFAULT 'relaxed',
    -- ADR 0005: fail_open is the default because an outage that empties the customer's
    -- server costs more than a short window without companion checks.
    fail_mode           fail_mode NOT NULL DEFAULT 'fail_open',
    license_status      license_status NOT NULL DEFAULT 'active',
    ban_network_enabled boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_servers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            text NOT NULL,
    -- Only the hash. A database dump must not hand anyone a working server key.
    server_key_hash text NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz
);

CREATE INDEX game_servers_tenant_idx ON game_servers (tenant_id);

-- --------------------------------------------------------------------------
-- Players
-- --------------------------------------------------------------------------

CREATE TABLE player_identities (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    license       text NOT NULL,
    steam         text,
    discord       text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    -- Identities are scoped to a tenant. Cross-tenant correlation happens later through
    -- the hardware identity, under the network ban rules in design document 11.
    UNIQUE (tenant_id, license)
);

-- --------------------------------------------------------------------------
-- Accepted companion builds
-- --------------------------------------------------------------------------

CREATE TABLE companion_builds (
    build_hash  text PRIMARY KEY,
    version     text NOT NULL,
    channel     text NOT NULL DEFAULT 'stable',
    accepted    boolean NOT NULL DEFAULT true,
    released_at timestamptz NOT NULL DEFAULT now(),
    notes       text
);

COMMENT ON TABLE companion_builds IS
    'Build pinning per design document 10: an outdated companion is forced to update '
    'rather than given a window to work in.';

-- --------------------------------------------------------------------------
-- Sessions
-- --------------------------------------------------------------------------

CREATE TYPE session_state AS ENUM ('pending', 'attested', 'active', 'expired', 'terminated');
CREATE TYPE verdict_decision AS ENUM ('allow', 'deny', 'pending');

CREATE TABLE attestation_sessions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    game_server_id       uuid NOT NULL REFERENCES game_servers(id) ON DELETE CASCADE,
    player_identity_id   uuid NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,

    -- The nonce is a bearer secret in transit; only its digest is kept, so a dump of this
    -- table cannot be replayed against a live gate.
    nonce_hash           text NOT NULL UNIQUE,
    game_ip              inet NOT NULL,
    policy_tier          policy_tier NOT NULL,
    state                session_state NOT NULL DEFAULT 'pending',

    issued_at            timestamptz NOT NULL DEFAULT now(),
    expires_at           timestamptz NOT NULL,
    consumed_at          timestamptz,

    attested_at          timestamptz,
    attestation_ip       inet,

    verdict_decision     verdict_decision NOT NULL DEFAULT 'pending',
    verdict_reasons      text[] NOT NULL DEFAULT '{}',
    verdict_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
    verdict_remediation  text,
    -- ADR 0005: a session admitted while the backend was degraded stays identifiable, so
    -- it is possible to see afterwards who connected during the window.
    fail_open            boolean NOT NULL DEFAULT false,
    evaluated_at         timestamptz,

    last_heartbeat_at    timestamptz,
    grace_expires_at     timestamptz,
    terminated_at        timestamptz,
    termination_reason   text
);

CREATE INDEX attestation_sessions_tenant_idx ON attestation_sessions (tenant_id, issued_at DESC);
CREATE INDEX attestation_sessions_player_idx ON attestation_sessions (player_identity_id, issued_at DESC);
-- Supports the sweep that expires stale pending sessions.
CREATE INDEX attestation_sessions_pending_idx ON attestation_sessions (expires_at)
    WHERE state = 'pending';

-- --------------------------------------------------------------------------
-- Snapshots
-- --------------------------------------------------------------------------

CREATE TABLE system_snapshots (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id          uuid NOT NULL REFERENCES attestation_sessions(id) ON DELETE CASCADE,
    companion_build_hash text NOT NULL,
    companion_version   text NOT NULL,
    collected_at        timestamptz NOT NULL,
    received_at         timestamptz NOT NULL DEFAULT now(),
    -- The raw facts, exactly as reported. Kept whole because a scoring rule written in six
    -- months has to be answerable against evidence collected today.
    payload             jsonb NOT NULL,
    -- Design document 13: snapshots are kept for 30 days.
    delete_after        timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

CREATE INDEX system_snapshots_session_idx ON system_snapshots (session_id);
CREATE INDEX system_snapshots_retention_idx ON system_snapshots (delete_after);
