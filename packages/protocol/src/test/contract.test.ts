import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SCHEMAS, type SchemaName } from '../../generated/typescript/protocol.js';
import { packageRoot } from '../cli/paths.js';

interface FixtureIndex {
  valid: { schema: string; file: string; note: string }[];
  invalid: { schema: string; file: string; reason: string }[];
}

const fixturesRoot = join(packageRoot, 'fixtures');
const index = JSON.parse(readFileSync(join(fixturesRoot, 'index.json'), 'utf8')) as FixtureIndex;

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, file), 'utf8'));
}

function schemaFor(name: string) {
  const schema = SCHEMAS[name as SchemaName];
  if (schema === undefined) {
    throw new Error(`fixture index names an unknown schema "${name}"`);
  }
  return schema;
}

describe('fixture index', () => {
  it('references only schemas that exist', () => {
    for (const entry of [...index.valid, ...index.invalid]) {
      expect(() => schemaFor(entry.schema), `${entry.file}`).not.toThrow();
    }
  });

  it('covers every message the protocol defines', () => {
    // A message with no fixture is a message no other language is exercising either.
    const covered = new Set(index.valid.map((entry) => entry.schema));
    const uncovered = Object.keys(SCHEMAS).filter((name) => !covered.has(name));

    // Structs that only ever appear nested are covered through their parent.
    const nestedOnly = [
      'SecurityFeatures',
      'TpmInfo',
      'GameProcessEvidence',
      'AttestationQuote',
      'PlayerIdentifiers',
      'RequirementResult',
    ];
    expect(uncovered.sort()).toEqual(nestedOnly.sort());
  });
});

describe('valid fixtures', () => {
  for (const entry of index.valid) {
    it(`${entry.file} parses as ${entry.schema}`, () => {
      const result = schemaFor(entry.schema).safeParse(readFixture(entry.file));
      if (!result.success) {
        throw new Error(
          `${entry.file} should be valid but was rejected:\n` +
            JSON.stringify(result.error.issues, null, 2),
        );
      }
    });

    it(`${entry.file} survives a serialize and parse round trip`, () => {
      const schema = schemaFor(entry.schema);
      const first = schema.parse(readFixture(entry.file));
      const second = schema.parse(JSON.parse(JSON.stringify(first)));
      expect(second).toEqual(first);
    });
  }
});

describe('invalid fixtures', () => {
  for (const entry of index.invalid) {
    it(`${entry.file} is rejected — ${entry.reason}`, () => {
      const result = schemaFor(entry.schema).safeParse(readFixture(entry.file));
      expect(result.success, `expected rejection because ${entry.reason}`).toBe(false);
    });
  }
});

describe('the companion cannot smuggle a verdict', () => {
  // ADR 0004 in executable form: the snapshot schema is strict, so any field the companion
  // invents is rejected rather than silently ignored by the backend.
  const base = readFixture('valid/system-snapshot-full.json') as Record<string, unknown>;

  for (const smuggled of ['clean', 'passed', 'verdict', 'isLegit', 'trusted']) {
    it(`rejects a snapshot carrying "${smuggled}"`, () => {
      const result = SCHEMAS.SystemSnapshot.safeParse({ ...base, [smuggled]: true });
      expect(result.success).toBe(false);
    });
  }
});
