import { defineStruct, field, t } from '../ir.js';
import { FeatureState } from './common.js';

export const SecurityFeatures = defineStruct({
  name: 'SecurityFeatures',
  doc: [
    'Operating system security features the policy tiers are built on.',
    '',
    'These are raw observations, not judgements — the companion reports what it found and',
    'the backend decides what it means (ADR 0004). "unknown" is never silently upgraded to',
    '"enabled"; a probe that could not answer is itself a signal.',
  ].join('\n'),
  fields: [
    field('secureBoot', t.enumRef(FeatureState), 'UEFI Secure Boot state.'),
    field(
      'hvci',
      t.enumRef(FeatureState),
      'Memory integrity / hypervisor-enforced code integrity.',
    ),
    field('testSigning', t.enumRef(FeatureState), 'Windows test signing. Enabled is a fail.'),
    field(
      'kernelDebugging',
      t.enumRef(FeatureState),
      'Kernel debugger attached. Enabled is a fail.',
    ),
    field('driverBlocklist', t.enumRef(FeatureState), 'Microsoft vulnerable driver blocklist.'),
    field('iommu', t.enumRef(FeatureState), 'IOMMU / kernel DMA protection.'),
    field('virtualizationBasedSecurity', t.enumRef(FeatureState), 'VBS running state.'),
  ],
});

export const TpmInfo = defineStruct({
  name: 'TpmInfo',
  doc: [
    'What the companion could learn about the TPM without performing a quote.',
    '',
    'Phase 1 only establishes presence. The attestation key handling, EK certificate chain',
    'and ActivateCredential challenge arrive in phase 2 (design document 6).',
  ].join('\n'),
  fields: [
    field('present', t.bool(), 'A TPM 2.0 device responded to the TBS API.'),
    field(
      'manufacturer',
      t.optional(t.string({ maxLength: 64 })),
      'Vendor ID as reported by the TPM.',
    ),
    field(
      'specVersion',
      t.optional(t.string({ maxLength: 32 })),
      'TPM specification version, for example "2.0".',
    ),
    field(
      'attestationKeyId',
      t.optional(t.string({ format: 'hex', maxLength: 128 })),
      'TODO(phase-2): fingerprint of the registered attestation key. Empty in phase 1.',
    ),
  ],
});

export const GameProcessEvidence = defineStruct({
  name: 'GameProcessEvidence',
  doc: [
    'Proof that a FiveM client is running on the same machine as the companion.',
    '',
    'This is the second half of the co-location argument; the localhost hop is the first',
    '(ADR 0003). Absence of this evidence denies the connection under every policy tier.',
  ].join('\n'),
  fields: [
    field('pid', t.int({ min: 1 }), 'Process id of the observed FiveM client.'),
    field('startedAtUnixMs', t.int({ min: 0 }), 'Process creation time, milliseconds since epoch.'),
    field('imageName', t.string({ maxLength: 128 }), 'Executable file name, without any path.'),
    field(
      'mainWindowPresent',
      t.bool(),
      'Whether a top-level window belonging to that process was found.',
    ),
  ],
});

export const SystemSnapshot = defineStruct({
  name: 'SystemSnapshot',
  doc: [
    'Everything the companion observed for one connect attempt.',
    '',
    'Facts only. There is deliberately no field that says "clean" — a tampered companion',
    'can omit facts, and omission is itself evaluated (ADR 0004).',
    '',
    'Privacy: no command lines, no paths below user directories, no document names.',
    'Process names are hashed unless they are on a published signature list (design',
    'document 13).',
  ].join('\n'),
  fields: [
    field(
      'schemaVersion',
      t.int({ min: 1 }),
      'Protocol version this snapshot was produced against.',
    ),
    field(
      'collectedAt',
      t.string({ format: 'datetime' }),
      'When the scan completed, ISO 8601 UTC.',
    ),
    field(
      'companionVersion',
      t.string({ format: 'semver', maxLength: 32 }),
      'Companion release version.',
    ),
    field(
      'companionBuildHash',
      t.string({ format: 'hex', minLength: 64, maxLength: 64 }),
      'SHA-256 of the companion binary. Checked against the accepted build list.',
    ),
    field(
      'osBuild',
      t.string({ maxLength: 64 }),
      'Windows build string, for example "10.0.26100".',
    ),
    field('features', t.structRef(SecurityFeatures), 'Security feature states.'),
    field('tpm', t.structRef(TpmInfo), 'TPM presence and identity.'),
    field(
      'gameProcess',
      t.optional(t.structRef(GameProcessEvidence)),
      'Local FiveM process, absent if none was found.',
    ),
    field(
      'probeErrors',
      t.array(t.string({ maxLength: 200 }), 32),
      'Probes that failed, as short stable identifiers. An empty list is the normal case.',
    ),
  ],
});

export const AttestationQuote = defineStruct({
  name: 'AttestationQuote',
  doc: [
    'TPM quote over the selected PCRs, signed by the registered attestation key.',
    '',
    'TODO(phase-2): phase 1 accepts and stores this structure but does not verify it.',
    'Verification against the AK, the EK certificate chain and the TCG event log is the',
    'core of phase 2 (design document 6).',
  ].join('\n'),
  fields: [
    field(
      'akPublicKeyId',
      t.string({ format: 'hex', maxLength: 128 }),
      'Fingerprint of the attestation key.',
    ),
    field(
      'pcrSelection',
      t.array(t.int({ min: 0, max: 23 }), 24),
      'PCR indices covered by the quote.',
    ),
    field(
      'pcrDigest',
      t.string({ format: 'hex', maxLength: 128 }),
      'Digest over the selected PCR values.',
    ),
    field(
      'quoteBlob',
      t.string({ format: 'base64', maxLength: 8192 }),
      'Raw TPMS_ATTEST structure.',
    ),
    field(
      'signature',
      t.string({ format: 'base64', maxLength: 2048 }),
      'Signature over the quote blob.',
    ),
  ],
});
