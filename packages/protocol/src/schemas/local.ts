import { defineStruct, field, t } from '../ir.js';
import { DenyReason, PolicyTier } from './common.js';

export const LocalAttestCommand = defineStruct({
  name: 'LocalAttestCommand',
  doc: [
    'Step 4: the NUI script pokes the companion on 127.0.0.1.',
    '',
    'This is the only request the localhost endpoint accepts. It carries a nonce and',
    'nothing else worth stealing — the backend URL is public and the server name is',
    'cosmetic (ADR 0003).',
  ].join('\n'),
  fields: [
    field(
      'nonce',
      t.string({ format: 'hex', minLength: 64, maxLength: 64 }),
      'Nonce issued by the backend and relayed through the game client.',
    ),
    field(
      'backendUrl',
      t.string({ maxLength: 256 }),
      'Where the companion should send the attestation.',
    ),
    field(
      'serverName',
      t.optional(t.string({ maxLength: 128 })),
      'Display name shown in the companion window while the check runs.',
    ),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the resource speaks.'),
  ],
});

export const LocalAttestAck = defineStruct({
  name: 'LocalAttestAck',
  doc: [
    'The only thing the localhost endpoint ever returns.',
    '',
    'It is an acknowledgement, not a result. Any local process can reach 127.0.0.1 — CORS',
    'protects browsers, not native code — so the endpoint is built to be useless to a',
    'caller other than the game client: it can trigger an attestation but can neither read',
    'its outcome nor influence it.',
  ].join('\n'),
  fields: [
    field('accepted', t.bool(), 'The command was well formed and an attestation was started.'),
    field(
      'companionVersion',
      t.string({ format: 'semver', maxLength: 32 }),
      'Running companion version.',
    ),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the companion speaks.'),
  ],
});

export const CompanionPollRequest = defineStruct({
  name: 'CompanionPollRequest',
  doc: [
    'The companion asks the backend whether a player on this machine is connecting.',
    '',
    'ADR 0010. FiveM does not run client resources while a player is held in a connect',
    'deferral, so the localhost hop of ADR 0003 cannot carry the nonce at the moment the',
    'gate needs it. The companion collects it here instead, and the backend decides which',
    'pending session — if any — belongs to this machine.',
    '',
    'The request carries no credential. It cannot: an attacker on this machine holds',
    'whatever the companion holds. What limits the answer is the source address, which the',
    'caller cannot choose.',
  ].join('\n'),
  fields: [
    field(
      'companionVersion',
      t.string({ format: 'semver', maxLength: 32 }),
      'Running companion version, so an outdated build is visible in the logs.',
    ),
    field(
      'waitSeconds',
      t.int({ min: 0, max: 30 }),
      'How long the backend may hold the request open before answering empty.',
    ),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the companion speaks.'),
  ],
});

export const CompanionPollResponse = defineStruct({
  name: 'CompanionPollResponse',
  doc: [
    'A nonce waiting for this machine, or nothing.',
    '',
    'Carries no verdict and no history — only what the companion needs to run one scan and',
    'report it. A local process that calls this endpoint learns that somebody at this',
    'address is connecting, which it could see on the network anyway.',
  ].join('\n'),
  fields: [
    field('pending', t.bool(), 'Whether a nonce is waiting. Every field below is absent if not.'),
    field(
      'nonce',
      t.optional(t.string({ format: 'hex', minLength: 64, maxLength: 64 })),
      'Nonce to attest against.',
    ),
    field(
      'serverName',
      t.optional(t.string({ maxLength: 128 })),
      'Display name for the companion window while the check runs.',
    ),
    field('policyTier', t.optional(t.enumRef(PolicyTier)), 'Tier the session is evaluated at.'),
    field(
      'expiresAt',
      t.optional(t.string({ format: 'datetime' })),
      'When the nonce stops being accepted.',
    ),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the backend speaks.'),
  ],
});

export const CompanionOutcomeRequest = defineStruct({
  name: 'CompanionOutcomeRequest',
  doc: [
    'The companion asks how the attestation it just filed was judged.',
    '',
    'ADR 0011, which relaxes ADR 0004. The reason and the remediation text are already',
    'shown to the player by the FiveM connect screen, so withholding them here bought no',
    'secrecy — it only made the companion window claim everything was fine while the',
    'server was refusing the connection.',
    '',
    'Answered only for a session id the caller already holds, which the companion learned',
    'by attesting for it.',
  ].join('\n'),
  fields: [
    field('sessionId', t.string({ format: 'uuid' }), 'The session this companion attested for.'),
    field(
      'waitSeconds',
      t.int({ min: 0, max: 10 }),
      'How long the backend may hold the request open while the verdict is still forming.',
    ),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the companion speaks.'),
  ],
});

export const HeartbeatRequest = defineStruct({
  name: 'HeartbeatRequest',
  doc: 'Sent by the companion every HEARTBEAT_INTERVAL_SECONDS while a session is active.',
  fields: [
    field('sessionId', t.string({ format: 'uuid' }), 'Session being kept alive.'),
    field(
      'companionBuildHash',
      t.string({ format: 'hex', minLength: 64, maxLength: 64 }),
      'Repeated so a mid-session swap of the binary is visible.',
    ),
    field('uptimeSeconds', t.int({ min: 0 }), 'Seconds since the companion started.'),
    field('gameProcessPresent', t.bool(), 'Whether the FiveM process is still running locally.'),
    field(
      'closing',
      t.optional(t.bool()),
      [
        'Set on the last heartbeat the companion sends before it exits.',
        '',
        'Design document 5.5 wants a companion restart to survive the session and a',
        'deliberate exit not to. Without this the two are indistinguishable and both cost',
        'the full 210 seconds of interval plus grace — so quitting on purpose bought three',
        'and a half minutes of playing without a companion.',
        '',
        'It grants nobody anything: whoever can send this can already send',
        'gameProcessPresent false and end the same session.',
      ].join('\n'),
    ),
    field('protocolVersion', t.int({ min: 1 }), 'Protocol version the companion speaks.'),
  ],
});

export const HeartbeatResponse = defineStruct({
  name: 'HeartbeatResponse',
  doc: 'The backend can shorten the interval or end the session, but never reveals a verdict.',
  fields: [
    field('acknowledged', t.bool(), 'Heartbeat was accepted and the session extended.'),
    field('nextIntervalSeconds', t.int({ min: 5, max: 3600 }), 'When to report in next.'),
    field(
      'terminate',
      t.bool(),
      'The companion should stop and tell the player the session ended.',
    ),
    field('terminateReason', t.optional(t.enumRef(DenyReason)), 'Set when terminate is true.'),
  ],
});

export const ProtocolError = defineStruct({
  name: 'ProtocolError',
  doc: [
    'Error envelope shared by every endpoint.',
    '',
    'The message is for operators and logs. It never carries player data, and it never',
    'explains which check failed to a caller that has not earned that information.',
  ].join('\n'),
  fields: [
    field(
      'code',
      t.string({ maxLength: 64 }),
      'Stable machine readable code, for example "nonce_expired".',
    ),
    field('message', t.string({ maxLength: 500 }), 'Short operator-facing description.'),
    field(
      'requestId',
      t.optional(t.string({ maxLength: 64 })),
      'Correlation id for support requests.',
    ),
  ],
});
