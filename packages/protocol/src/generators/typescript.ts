import type { FieldType, Registry } from '../ir.js';
import {
  UnsupportedTypeError,
  Writer,
  banner,
  constraintNote,
  jsDoc,
  screamingSnakeCase,
} from './emit.js';

/**
 * Emits real Zod source rather than building schemas at runtime.
 *
 * The point is reviewability: a reader of the pull request sees the validation the backend
 * will actually run, not a factory that produces it. The same file also carries the
 * inferred TypeScript types, so backend and dashboard share one definition.
 */
export function generateTypeScript(registry: Registry): string {
  const w = new Writer('  ');

  w.lines_(banner('// '));
  w.line();
  w.line("import { z } from 'zod';");
  w.line();
  w.line('// --- Constants -------------------------------------------------------------');
  w.line();
  for (const c of registry.constants) {
    jsDoc(w, c.doc);
    w.line(`export const ${c.name} = ${c.value};`).line();
  }

  w.line('// --- Enums -----------------------------------------------------------------');
  w.line();
  for (const e of registry.enums) {
    w.line('/**');
    w.comment(' * ', e.doc);
    w.line(' *');
    for (const v of e.values) {
      w.line(` * - \`${v.value}\` — ${v.doc}`);
    }
    w.line(' */');
    w.line(`export const ${e.name} = z.enum([`);
    w.indent(() => {
      for (const v of e.values) w.line(`'${v.value}',`);
    });
    w.line(']);');
    w.line(`export type ${e.name} = z.infer<typeof ${e.name}>;`);
    w.line();
    // A plain value map keeps call sites free of string literals.
    w.line(`export const ${screamingSnakeCase(e.name)}_VALUES = ${e.name}.options;`);
    w.line();
  }

  w.line('// --- Structs ---------------------------------------------------------------');
  w.line();
  for (const s of registry.structs) {
    jsDoc(w, s.doc);
    w.line(`export const ${s.name} = z.object({`);
    w.indent(() => {
      for (const f of s.fields) {
        const note = constraintNote(f.type);
        jsDoc(w, `${f.doc}${note ? ` ${note}` : ''}`);
        w.line(`${f.name}: ${zodExpr(f.type)},`);
      }
    });
    w.line('}).strict();');
    w.line(`export type ${s.name} = z.infer<typeof ${s.name}>;`);
    w.line();
  }

  w.line('// --- Registry --------------------------------------------------------------');
  w.line();
  w.line('/** Every message schema, keyed by name. Used by the contract tests. */');
  w.line('export const SCHEMAS = {');
  w.indent(() => {
    for (const s of registry.structs) w.line(`${s.name},`);
  });
  w.line('} as const;');
  w.line();
  w.line('export type SchemaName = keyof typeof SCHEMAS;');

  return w.toString();
}

function zodExpr(type: FieldType): string {
  switch (type.kind) {
    case 'string': {
      let expr = 'z.string()';
      switch (type.format) {
        case 'uuid':
          expr += '.uuid()';
          break;
        case 'hex':
          expr += '.regex(/^[0-9a-f]*$/, { message: "expected lowercase hex" })';
          break;
        case 'base64':
          expr += '.regex(/^[A-Za-z0-9+/]*={0,2}$/, { message: "expected base64" })';
          break;
        case 'ip':
          // Accepts both families; FiveM reports either depending on the player's network.
          expr += '.regex(/^[0-9a-fA-F.:]+$/, { message: "expected an IPv4 or IPv6 address" })';
          break;
        case 'datetime':
          expr += '.datetime({ offset: false, message: "expected ISO 8601 UTC" })';
          break;
        case 'semver':
          expr +=
            '.regex(/^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$/, { message: "expected semver" })';
          break;
        default:
          break;
      }
      if (type.minLength !== undefined) expr += `.min(${type.minLength})`;
      if (type.maxLength !== undefined) expr += `.max(${type.maxLength})`;
      return expr;
    }
    case 'int': {
      let expr = 'z.number().int()';
      if (type.min !== undefined) expr += `.min(${type.min})`;
      if (type.max !== undefined) expr += `.max(${type.max})`;
      return expr;
    }
    case 'bool':
      return 'z.boolean()';
    case 'enum':
      return type.ref;
    case 'struct':
      return type.ref;
    case 'array': {
      let expr = `z.array(${zodExpr(type.items)})`;
      if (type.maxItems !== undefined) expr += `.max(${type.maxItems})`;
      return expr;
    }
    case 'optional':
      return `${zodExpr(type.inner)}.optional()`;
    default:
      throw new UnsupportedTypeError('typescript', type);
  }
}
