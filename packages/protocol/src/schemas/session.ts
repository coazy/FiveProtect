import { defineStruct, field, t } from '../ir.js';
import {
  DenyReason,
  PolicyTier,
  RequirementId,
  RequirementStatus,
  SessionState,
  VerdictDecision,
} from './common.js';
import { AttestationQuote, SystemSnapshot } from './attestation.js';

export const PlayerIdentifiers = defineStruct({
  name: 'PlayerIdentifiers',
  doc: [
    'The identifiers FiveM exposes for a connecting player.',
    '',
    'Only "license" is guaranteed by the platform; the rest depend on what the player has',
    'linked. They are stored per tenant and are subject to the retention periods in design',
    'document 13.',
  ].join('\n'),
  fields: [
    field('license', t.string({ maxLength: 128 }), 'Rockstar license identifier, always present.'),
    field('steam', t.optional(t.string({ maxLength: 128 })), 'Steam identifier, if linked.'),
    field('discord', t.optional(t.string({ maxLength: 128 })), 'Discord identifier, if linked.'),
    field('ip', t.string({ format: 'ip', maxLength: 45 }), 'Public IP of the game connection.'),
  ],
});

export const NonceRequest = defineStruct({
  name: 'NonceRequest',
  doc: [
    'Step 2 of the connect flow: the resource asks for a nonce while the player is deferred.',
    '',
    'The tenant is taken from the server key used to authenticate the request, never from',
    'the body — otherwise a leaked key from one tenant could act as another.',
  ].join('\n'),
  fields: [
    field('serverId', t.string({ format: 'uuid' }), 'Which game server of the tenant is asking.'),
    field('player', t.structRef(PlayerIdentifiers), 'Identifiers of the connecting player.'),
    field('gameBuild', t.optional(t.string({ maxLength: 32 })), 'FiveM build the client reports.'),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the resource speaks.'),
  ],
});

export const NonceResponse = defineStruct({
  name: 'NonceResponse',
  doc: 'The nonce the resource hands to the client, plus what the client needs to act on it.',
  fields: [
    field(
      'nonce',
      t.string({ format: 'hex', minLength: 64, maxLength: 64 }),
      'Single-use challenge, 32 random bytes hex encoded.',
    ),
    field('sessionId', t.string({ format: 'uuid' }), 'Session this nonce belongs to.'),
    field('expiresAt', t.string({ format: 'datetime' }), 'Hard expiry, ISO 8601 UTC.'),
    field('policyTier', t.enumRef(PolicyTier), 'Tier the attestation will be evaluated against.'),
    field('backendUrl', t.string({ maxLength: 256 }), 'Base URL the companion should attest to.'),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the backend speaks.'),
  ],
});

export const AttestationRequest = defineStruct({
  name: 'AttestationRequest',
  doc: [
    'Step 6: the companion reports directly to the backend, not through the game client.',
    '',
    'The client never sees this payload and therefore cannot alter it (design document 5.2).',
    'The request carries no credentials — the nonce is the only thing that binds it to a',
    'session, and it is single use.',
  ].join('\n'),
  fields: [
    field(
      'nonce',
      t.string({ format: 'hex', minLength: 64, maxLength: 64 }),
      'Nonce being answered.',
    ),
    field('snapshot', t.structRef(SystemSnapshot), 'Observed system state.'),
    field(
      'quote',
      t.optional(t.structRef(AttestationQuote)),
      'TPM quote. Optional in phase 1, required from phase 2 at tier standard and above.',
    ),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the companion speaks.'),
  ],
});

export const AttestationAck = defineStruct({
  name: 'AttestationAck',
  doc: [
    'The backend confirms receipt to the companion.',
    '',
    'Deliberately free of any judgement: the companion must not learn whether it passed,',
    'because that turns the verdict into a value an attacker can read and work against.',
  ].join('\n'),
  fields: [
    field('accepted', t.bool(), 'The attestation was well formed and bound to a live nonce.'),
    field('sessionId', t.string({ format: 'uuid' }), 'Session the attestation was filed under.'),
    field('receivedAt', t.string({ format: 'datetime' }), 'Server time of receipt.'),
    field(
      'heartbeatIntervalSeconds',
      t.int({ min: 5, max: 3600 }),
      'How often the companion should report in from now on.',
    ),
  ],
});

export const RequirementResult = defineStruct({
  name: 'RequirementResult',
  doc: 'Outcome of one policy requirement, kept so the block screen can name a concrete cause.',
  fields: [
    field('requirement', t.enumRef(RequirementId), 'Which requirement was evaluated.'),
    field('status', t.enumRef(RequirementStatus), 'Outcome under the active tier.'),
    field(
      'detail',
      t.optional(t.string({ maxLength: 200 })),
      'Short human readable detail, for example the name of the driver blocking HVCI.',
    ),
  ],
});

export const Verdict = defineStruct({
  name: 'Verdict',
  doc: [
    'The gate decision. Produced only by the backend attestation service (ADR 0004).',
    '',
    'The resource pulls this; it is never pushed to the resource. That leaves no inbound',
    'path an attacker could feed (design document 5.2).',
  ].join('\n'),
  fields: [
    field('decision', t.enumRef(VerdictDecision), 'allow, deny, or pending while still waiting.'),
    field('sessionId', t.string({ format: 'uuid' }), 'Session the verdict belongs to.'),
    field('reasons', t.array(t.enumRef(DenyReason), 16), 'Empty when the decision is allow.'),
    field('requirements', t.array(t.structRef(RequirementResult), 32), 'Per-requirement detail.'),
    field(
      'remediation',
      t.optional(t.string({ maxLength: 500 })),
      'Player-facing instruction for the block screen. Naming the cause avoids a support ticket.',
    ),
    field('policyTier', t.enumRef(PolicyTier), 'Tier the evaluation ran against.'),
    field('evaluatedAt', t.string({ format: 'datetime' }), 'When the verdict was decided.'),
    field(
      'failOpen',
      t.bool(),
      'True when this allow was granted because the backend degraded, not because checks passed. ' +
        'Sessions admitted this way stay identifiable afterwards (ADR 0005).',
    ),
  ],
});

export const LivenessResponse = defineStruct({
  name: 'LivenessResponse',
  doc: 'What the resource needs to decide whether a player in game may stay.',
  fields: [
    field('sessionId', t.string({ format: 'uuid' }), 'Session being asked about.'),
    field('state', t.enumRef(SessionState), 'Current lifecycle state.'),
    field(
      'lastHeartbeatAt',
      t.optional(t.string({ format: 'datetime' })),
      'Last companion check-in.',
    ),
    field(
      'graceExpiresAt',
      t.optional(t.string({ format: 'datetime' })),
      'End of the grace period. While set, the player should see a visible warning.',
    ),
    field('shouldKick', t.bool(), 'True once the grace period has run out.'),
    field('reason', t.optional(t.enumRef(DenyReason)), 'Why the kick is due.'),
  ],
});
