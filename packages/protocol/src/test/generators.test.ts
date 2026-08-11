import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generatedRoot } from '../cli/paths.js';
import { renderAll } from '../generators/index.js';
import { UnsupportedTypeError, pascalCase, snakeCase } from '../generators/emit.js';
import { validateRegistry, type Registry } from '../ir.js';
import { loadRegistry } from '../schemas/index.js';

const registry = loadRegistry();

describe('registry', () => {
  it('validates', () => {
    expect(() => validateRegistry(registry)).not.toThrow();
  });

  it('rejects a struct that references one declared after it', () => {
    const broken: Registry = {
      enums: [],
      constants: [],
      structs: [
        {
          name: 'Early',
          doc: '',
          fields: [{ name: 'later', type: { kind: 'struct', ref: 'Late' }, doc: '' }],
        },
        { name: 'Late', doc: '', fields: [{ name: 'value', type: { kind: 'bool' }, doc: '' }] },
      ],
    };
    expect(() => validateRegistry(broken)).toThrow(/before it is declared/);
  });

  it('rejects a dangling enum reference', () => {
    const broken: Registry = {
      enums: [],
      constants: [],
      structs: [
        {
          name: 'Thing',
          doc: '',
          fields: [{ name: 'tier', type: { kind: 'enum', ref: 'Nope' }, doc: '' }],
        },
      ],
    };
    expect(() => validateRegistry(broken)).toThrow(/unknown enum "Nope"/);
  });

  it('rejects a duplicate field name', () => {
    const broken: Registry = {
      enums: [],
      constants: [],
      structs: [
        {
          name: 'Thing',
          doc: '',
          fields: [
            { name: 'value', type: { kind: 'bool' }, doc: '' },
            { name: 'value', type: { kind: 'bool' }, doc: '' },
          ],
        },
      ],
    };
    expect(() => validateRegistry(broken)).toThrow(/declares field "value" twice/);
  });
});

describe('generated artifacts', () => {
  const artifacts = renderAll(registry);

  it('produces one artifact per target language', () => {
    expect(artifacts.map((a) => a.language)).toEqual(['TypeScript', 'Rust', 'C++', 'Lua']);
  });

  it('is byte identical to what is committed', () => {
    // The same comparison the CI drift check performs. Having it here means a schema change
    // fails in the package's own test run, not three jobs later.
    for (const artifact of artifacts) {
      const committed = readFileSync(join(generatedRoot, artifact.path), 'utf8').replace(
        /\r\n/g,
        '\n',
      );
      expect(committed, `generated/${artifact.path} is stale — run npm run protocol:generate`).toBe(
        artifact.contents.replace(/\r\n/g, '\n'),
      );
    }
  });

  it('is deterministic across runs', () => {
    const second = renderAll(registry);
    for (const [i, artifact] of artifacts.entries()) {
      expect(second[i]?.contents).toBe(artifact.contents);
    }
  });

  it('carries the do-not-edit banner in every file', () => {
    for (const artifact of artifacts) {
      expect(artifact.contents.split('\n')[0]).toContain('Do not edit by hand');
    }
  });

  it('mentions every enum in every language', () => {
    for (const artifact of artifacts) {
      for (const e of registry.enums) {
        expect(artifact.contents, `${e.name} missing from ${artifact.path}`).toContain(e.name);
      }
    }
  });

  it('mentions every struct in every language', () => {
    for (const artifact of artifacts) {
      for (const s of registry.structs) {
        expect(artifact.contents, `${s.name} missing from ${artifact.path}`).toContain(s.name);
      }
    }
  });

  it('never leaks a timestamp into the output', () => {
    // A timestamp would make the drift check fail on every run for no reason.
    const currentYear = String(new Date().getFullYear());
    for (const artifact of artifacts) {
      const banner = artifact.contents.split('\n').slice(0, 6).join('\n');
      expect(banner).not.toContain(currentYear);
    }
  });
});

describe('naming helpers', () => {
  it('converts wire values to Rust and C++ variant names', () => {
    expect(pascalCase('fail_open')).toBe('FailOpen');
    expect(pascalCase('network_origin_mismatch')).toBe('NetworkOriginMismatch');
    expect(pascalCase('relaxed')).toBe('Relaxed');
  });

  it('converts wire field names to Rust field names', () => {
    expect(snakeCase('companionBuildHash')).toBe('companion_build_hash');
    expect(snakeCase('tpm')).toBe('tpm');
    expect(snakeCase('startedAtUnixMs')).toBe('started_at_unix_ms');
  });
});

describe('unsupported IR constructs', () => {
  it('fails loudly rather than emitting something plausible', () => {
    const error = new UnsupportedTypeError('rust', { kind: 'bool' });
    expect(error.message).toContain('Teach all four generators');
  });
});
