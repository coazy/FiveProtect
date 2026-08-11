-- Nonce delivery to the companion (ADR 0010).
--
-- FiveM does not run client resources while a player is held in a connect deferral, so the
-- localhost hop cannot carry the nonce at the moment the gate needs it. The companion pulls
-- it from the backend instead, which means the backend has to be able to hand out the nonce
-- and not only compare a digest against it.
--
-- Sealed rather than stored plainly: AES-256-GCM under a key that lives in the environment.
-- A dump of this table on its own still cannot be replayed against a live gate, which is
-- the property `nonce_hash` was introduced for.

ALTER TABLE attestation_sessions
    ADD COLUMN nonce_sealed bytea;

COMMENT ON COLUMN attestation_sessions.nonce_sealed IS
    'AES-256-GCM sealed nonce, readable only with NONCE_SEAL_KEY. Cleared on consumption.';

-- The companion identifies itself by nothing but where it connects from, so the pending
-- lookup is a scan by address. Partial, because only unconsumed sessions are ever looked up
-- this way and they are a vanishing fraction of the table.
CREATE INDEX attestation_sessions_pending_origin_idx
    ON attestation_sessions (game_ip, expires_at)
    WHERE consumed_at IS NULL;
