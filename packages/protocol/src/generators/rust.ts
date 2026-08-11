import type { FieldType, Registry } from '../ir.js';
import {
  UnsupportedTypeError,
  Writer,
  banner,
  constraintNote,
  isOptional,
  pascalCase,
  snakeCase,
  unwrapOptional,
} from './emit.js';

/**
 * Emits serde structs for the companion.
 *
 * Field names become snake_case with an explicit `#[serde(rename = "...")]` rather than a
 * blanket `rename_all`. The explicit form survives field names that do not round-trip
 * through a naming convention, and it makes the wire name visible at the field.
 */
export function generateRust(registry: Registry): string {
  const w = new Writer('    ');

  w.lines_(banner('// '));
  w.line('#![allow(dead_code)]');
  w.line();
  w.line('use serde::{Deserialize, Serialize};');
  w.line();
  w.line('// --- Constants -------------------------------------------------------------');
  w.line();
  for (const c of registry.constants) {
    w.comment('/// ', c.doc);
    w.line(`pub const ${c.name}: u32 = ${c.value};`);
    w.line();
  }

  w.line('// --- Enums -----------------------------------------------------------------');
  w.line();
  for (const e of registry.enums) {
    w.comment('/// ', e.doc);
    w.line('#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]');
    w.line(`pub enum ${e.name} {`);
    w.indent(() => {
      for (const v of e.values) {
        w.comment('/// ', v.doc);
        w.line(`#[serde(rename = "${v.value}")]`);
        w.line(`${pascalCase(v.value)},`);
      }
    });
    w.line('}');
    w.line();
    // A wire-name accessor keeps logging and error paths free of a second mapping.
    w.line(`impl ${e.name} {`);
    w.indent(() => {
      w.line('/// The exact string used on the wire.');
      w.line("pub fn as_wire_str(&self) -> &'static str {");
      w.indent(() => {
        w.line('match self {');
        w.indent(() => {
          for (const v of e.values) {
            w.line(`${e.name}::${pascalCase(v.value)} => "${v.value}",`);
          }
        });
        w.line('}');
      });
      w.line('}');
      w.line();
      w.line('/// Every variant, in declaration order.');
      w.line(`pub const ALL: [${e.name}; ${e.values.length}] = [`);
      w.indent(() => {
        for (const v of e.values) w.line(`${e.name}::${pascalCase(v.value)},`);
      });
      w.line('];');
    });
    w.line('}');
    w.line();
    w.line(`impl std::fmt::Display for ${e.name} {`);
    w.indent(() => {
      w.line("fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {");
      w.indent(() => w.line('f.write_str(self.as_wire_str())'));
      w.line('}');
    });
    w.line('}');
    w.line();
  }

  w.line('// --- Structs ---------------------------------------------------------------');
  w.line();
  for (const s of registry.structs) {
    w.comment('/// ', s.doc);
    w.line('#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]');
    // An unknown field means the two ends disagree about the protocol. Every target
    // language rejects it, so the contract fixtures behave the same everywhere.
    w.line('#[serde(deny_unknown_fields)]');
    w.line(`pub struct ${s.name} {`);
    w.indent(() => {
      for (const f of s.fields) {
        const note = constraintNote(f.type);
        w.comment('/// ', `${f.doc}${note ? ` ${note}` : ''}`);
        const rustName = snakeCase(f.name);
        if (isOptional(f.type)) {
          w.line(
            `#[serde(rename = "${f.name}", default, skip_serializing_if = "Option::is_none")]`,
          );
        } else {
          w.line(`#[serde(rename = "${f.name}")]`);
        }
        w.line(`pub ${escapeKeyword(rustName)}: ${rustType(f.type)},`);
      }
    });
    w.line('}');
    w.line();
  }

  w.line('// --- Validation ------------------------------------------------------------');
  w.line();
  w.lines_(RUST_VALIDATION_HELPERS);
  w.line();
  for (const s of registry.structs) {
    w.line(`impl ${s.name} {`);
    w.indent(() => {
      w.line('/// Checks the constraints serde cannot express — lengths, ranges and formats.');
      w.line('///');
      w.line(
        '/// Deserialization proves the shape; this proves the content. The companion runs it',
      );
      w.line('/// on everything it receives over the localhost endpoint, where the caller is');
      w.line('/// any local process rather than the game client.');
      w.line('pub fn validate(&self) -> Result<(), String> {');
      w.indent(() => {
        let emitted = false;
        for (const f of s.fields) {
          const rustName = escapeKeyword(snakeCase(f.name));
          const path = `${s.name}.${f.name}`;
          if (isOptional(f.type)) {
            const inner = unwrapOptional(f.type);
            const statements = validationStatements(inner, 'inner', path);
            if (statements.length === 0) continue;
            emitted = true;
            // Scalars are bound by value so the checks take the same argument types as in
            // the non-optional case; everything else stays behind the reference.
            const pattern = inner.kind === 'int' || inner.kind === 'bool' ? '&inner' : 'inner';
            w.line(`if let Some(${pattern}) = &self.${rustName} {`);
            w.indent(() => w.lines_(statements));
            w.line('}');
          } else {
            const statements = validationStatements(f.type, `self.${rustName}`, path);
            if (statements.length === 0) continue;
            emitted = true;
            w.lines_(statements);
          }
        }
        if (!emitted) {
          w.line('// No field of this message carries a constraint beyond its type.');
        }
        w.line('Ok(())');
      });
      w.line('}');
    });
    w.line('}');
    w.line();
  }

  w.line('// --- Schema names ----------------------------------------------------------');
  w.line();
  w.line('/// Names of every generated message, used by the contract tests.');
  w.line(`pub const SCHEMA_NAMES: [&str; ${registry.structs.length}] = [`);
  w.indent(() => {
    for (const s of registry.structs) w.line(`"${s.name}",`);
  });
  w.line('];');
  w.line();
  w.line('/// Names of every generated enum, used by the contract tests.');
  w.line(`pub const ENUM_NAMES: [&str; ${registry.enums.length}] = [`);
  w.indent(() => {
    for (const e of registry.enums) w.line(`"${e.name}",`);
  });
  w.line('];');

  return w.toString();
}

const RUST_VALIDATION_HELPERS = [
  '/// Format checks mirror the Lua patterns rather than the richer TypeScript ones. They',
  '/// catch a wrong shape; the backend stays the authority on well-formedness.',
  'mod check {',
  '    pub fn length(value: &str, path: &str, min: Option<usize>, max: Option<usize>) -> Result<(), String> {',
  '        if let Some(min) = min {',
  '            if value.len() < min {',
  '                return Err(format!("{path}: shorter than {min} characters"));',
  '            }',
  '        }',
  '        if let Some(max) = max {',
  '            if value.len() > max {',
  '                return Err(format!("{path}: longer than {max} characters"));',
  '            }',
  '        }',
  '        Ok(())',
  '    }',
  '',
  '    pub fn range(value: i64, path: &str, min: Option<i64>, max: Option<i64>) -> Result<(), String> {',
  '        if let Some(min) = min {',
  '            if value < min {',
  '                return Err(format!("{path}: below the minimum of {min}"));',
  '            }',
  '        }',
  '        if let Some(max) = max {',
  '            if value > max {',
  '                return Err(format!("{path}: above the maximum of {max}"));',
  '            }',
  '        }',
  '        Ok(())',
  '    }',
  '',
  '    pub fn max_items<T>(value: &[T], path: &str, max: usize) -> Result<(), String> {',
  '        if value.len() > max {',
  '            return Err(format!("{path}: holds more than {max} items"));',
  '        }',
  '        Ok(())',
  '    }',
  '',
  '    pub fn hex(value: &str, path: &str) -> Result<(), String> {',
  '        if value.chars().all(|c| c.is_ascii_hexdigit()) {',
  '            Ok(())',
  '        } else {',
  '            Err(format!("{path}: does not look like hex"))',
  '        }',
  '    }',
  '',
  '    pub fn base64(value: &str, path: &str) -> Result<(), String> {',
  "        if value.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=') {",
  '            Ok(())',
  '        } else {',
  '            Err(format!("{path}: does not look like base64"))',
  '        }',
  '    }',
  '',
  '    pub fn ip(value: &str, path: &str) -> Result<(), String> {',
  "        if !value.is_empty() && value.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':') {",
  '            Ok(())',
  '        } else {',
  '            Err(format!("{path}: does not look like an IP address"))',
  '        }',
  '    }',
  '',
  '    pub fn uuid(value: &str, path: &str) -> Result<(), String> {',
  '        let bytes = value.as_bytes();',
  '        let shaped = bytes.len() == 36',
  '            && bytes.iter().enumerate().all(|(index, byte)| match index {',
  "                8 | 13 | 18 | 23 => *byte == b'-',",
  '                _ => byte.is_ascii_hexdigit(),',
  '            });',
  '        if shaped {',
  '            Ok(())',
  '        } else {',
  '            Err(format!("{path}: does not look like a UUID"))',
  '        }',
  '    }',
  '',
  '    pub fn datetime(value: &str, path: &str) -> Result<(), String> {',
  '        // YYYY-MM-DDThh:mm:ss — anything after that is optional precision or a zone.',
  '        const SHAPE: &[u8] = b"0000-00-00T00:00:00";',
  '        let bytes = value.as_bytes();',
  '        let shaped = bytes.len() >= SHAPE.len()',
  '            && SHAPE.iter().enumerate().all(|(index, expected)| {',
  "                if *expected == b'0' { bytes[index].is_ascii_digit() } else { bytes[index] == *expected }",
  '            });',
  '        if shaped {',
  '            Ok(())',
  '        } else {',
  '            Err(format!("{path}: does not look like an ISO 8601 timestamp"))',
  '        }',
  '    }',
  '',
  '    pub fn semver(value: &str, path: &str) -> Result<(), String> {',
  "        let mut parts = value.split(['-', '+']).next().unwrap_or(\"\").split('.');",
  '        let major = parts.next().unwrap_or("");',
  '        let minor = parts.next().unwrap_or("");',
  '        let patch = parts.next().unwrap_or("");',
  '        let numeric = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());',
  '        if numeric(major) && numeric(minor) && numeric(patch) {',
  '            Ok(())',
  '        } else {',
  '            Err(format!("{path}: does not look like a semantic version"))',
  '        }',
  '    }',
  '}',
];

/** Statements that validate one field. Empty when the field carries no constraint. */
function validationStatements(type: FieldType, access: string, path: string): string[] {
  switch (type.kind) {
    case 'string': {
      // `.as_str()` works whether the access is a `String` field or a `&String` binding from
      // an Option, so optional and required fields share one code path.
      const out: string[] = [];
      if (type.minLength !== undefined || type.maxLength !== undefined) {
        out.push(
          `check::length(${access}.as_str(), "${path}", ${optionLiteral(type.minLength)}, ${optionLiteral(type.maxLength)})?;`,
        );
      }
      const formatFn = type.format === undefined ? undefined : FORMAT_FUNCTIONS[type.format];
      if (formatFn !== undefined) {
        out.push(`check::${formatFn}(${access}.as_str(), "${path}")?;`);
      }
      return out;
    }
    case 'int': {
      if (type.min === undefined && type.max === undefined) return [];
      return [
        `check::range(${access}, "${path}", ${optionLiteral(type.min)}, ${optionLiteral(type.max)})?;`,
      ];
    }
    case 'struct':
      return [`${access}.validate()?;`];
    case 'array': {
      const out: string[] = [];
      if (type.maxItems !== undefined) {
        out.push(`check::max_items(${access}.as_slice(), "${path}", ${type.maxItems})?;`);
      }
      // `.iter()` yields references. Scalar checks take values, so those get dereferenced;
      // strings and structs are happy behind the reference.
      const itemAccess = type.items.kind === 'int' || type.items.kind === 'bool' ? '*item' : 'item';
      const itemStatements = validationStatements(type.items, itemAccess, `${path}[]`);
      if (itemStatements.length > 0) {
        out.push(`for item in ${access}.iter() {`);
        out.push(...itemStatements.map((line) => `    ${line}`));
        out.push('}');
      }
      return out;
    }
    default:
      return [];
  }
}

const FORMAT_FUNCTIONS: Record<string, string> = {
  hex: 'hex',
  base64: 'base64',
  ip: 'ip',
  uuid: 'uuid',
  datetime: 'datetime',
  semver: 'semver',
};

function optionLiteral(value: number | undefined): string {
  return value === undefined ? 'None' : `Some(${value})`;
}

const RUST_KEYWORDS = new Set([
  'as',
  'break',
  'const',
  'continue',
  'crate',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'dyn',
  'abstract',
  'become',
  'box',
  'do',
  'final',
  'macro',
  'override',
  'priv',
  'typeof',
  'unsized',
  'virtual',
  'yield',
  'try',
]);

function escapeKeyword(name: string): string {
  return RUST_KEYWORDS.has(name) ? `r#${name}` : name;
}

function rustType(type: FieldType): string {
  switch (type.kind) {
    case 'string':
      return 'String';
    case 'int':
      // Signed 64-bit covers every declared range, including unix milliseconds, and avoids
      // a mixed-width surface that would need per-field reasoning at every call site.
      return 'i64';
    case 'bool':
      return 'bool';
    case 'enum':
    case 'struct':
      return type.ref;
    case 'array':
      return `Vec<${rustType(unwrapOptional(type.items))}>`;
    case 'optional':
      return `Option<${rustType(type.inner)}>`;
    default:
      throw new UnsupportedTypeError('rust', type);
  }
}
