/**
 * The schema intermediate representation.
 *
 * Every wire format FiveProtect speaks is declared here once, in a form small enough that
 * four generators can consume it without guessing. Zod, Rust, C++ and Lua artifacts are
 * all derived from this — see ADR 0008 for why the IR is the source rather than Zod
 * itself.
 *
 * The IR is deliberately narrow. If a schema needs a construct that is not in `FieldType`,
 * add it here and teach all four generators about it; a generator that meets an unknown
 * construct fails loudly rather than emitting something plausible but wrong.
 */

export type FieldType =
  | { kind: 'string'; format?: StringFormat; minLength?: number; maxLength?: number }
  | { kind: 'int'; min?: number; max?: number }
  | { kind: 'bool' }
  | { kind: 'enum'; ref: string }
  | { kind: 'struct'; ref: string }
  | { kind: 'array'; items: FieldType; maxItems?: number }
  | { kind: 'optional'; inner: FieldType };

/**
 * Formats carry validation intent across languages. They are checked in TypeScript and
 * Lua, and documented in Rust and C++ where the type system does not express them.
 */
export type StringFormat = 'uuid' | 'hex' | 'base64' | 'ip' | 'datetime' | 'semver';

export interface FieldDef {
  name: string;
  type: FieldType;
  doc: string;
}

export interface StructDef {
  name: string;
  doc: string;
  fields: FieldDef[];
}

export interface EnumDef {
  name: string;
  doc: string;
  values: { value: string; doc: string }[];
}

export interface ConstantDef {
  name: string;
  value: number;
  doc: string;
}

export interface Registry {
  enums: EnumDef[];
  structs: StructDef[];
  constants: ConstantDef[];
}

const registry: Registry = { enums: [], structs: [], constants: [] };

function assertUnique(kind: string, name: string, taken: string[]): void {
  if (taken.includes(name)) {
    throw new Error(`duplicate ${kind} "${name}" in protocol registry`);
  }
}

export function defineEnum(def: EnumDef): EnumDef {
  assertUnique(
    'enum',
    def.name,
    registry.enums.map((e) => e.name),
  );
  if (def.values.length === 0) {
    throw new Error(`enum "${def.name}" has no values`);
  }
  registry.enums.push(def);
  return def;
}

export function defineStruct(def: StructDef): StructDef {
  assertUnique(
    'struct',
    def.name,
    registry.structs.map((s) => s.name),
  );
  registry.structs.push(def);
  return def;
}

export function defineConstant(def: ConstantDef): ConstantDef {
  assertUnique(
    'constant',
    def.name,
    registry.constants.map((c) => c.name),
  );
  registry.constants.push(def);
  return def;
}

/** Declaration order is the generated order. Generators must not re-sort. */
export function getRegistry(): Registry {
  return registry;
}

// ---------------------------------------------------------------------------
// Field constructors — thin sugar so schema files read as declarations.
// ---------------------------------------------------------------------------

export const t = {
  string: (opts: { format?: StringFormat; minLength?: number; maxLength?: number } = {}) =>
    ({ kind: 'string', ...opts }) as FieldType,
  int: (opts: { min?: number; max?: number } = {}) => ({ kind: 'int', ...opts }) as FieldType,
  bool: () => ({ kind: 'bool' }) as FieldType,
  enumRef: (ref: EnumDef) => ({ kind: 'enum', ref: ref.name }) as FieldType,
  structRef: (ref: StructDef) => ({ kind: 'struct', ref: ref.name }) as FieldType,
  array: (items: FieldType, maxItems?: number) => ({ kind: 'array', items, maxItems }) as FieldType,
  optional: (inner: FieldType) => {
    if (inner.kind === 'optional') {
      throw new Error('optional(optional(...)) is not a meaningful wire type');
    }
    return { kind: 'optional', inner } as FieldType;
  },
};

export function field(name: string, type: FieldType, doc: string): FieldDef {
  return { name, type, doc };
}

// ---------------------------------------------------------------------------
// Validation of the registry itself. Runs before any generator writes a byte.
// ---------------------------------------------------------------------------

/**
 * Rejects dangling references and structs declared after their first use.
 *
 * The ordering rule matters: Rust and C++ emit declarations in registry order, and C++
 * has no forward declarations in the generated header. Catching it here produces a clear
 * message instead of a compiler error in a generated file.
 */
export function validateRegistry(reg: Registry = registry): void {
  const enumNames = new Set(reg.enums.map((e) => e.name));
  const seenStructs = new Set<string>();

  const walk = (type: FieldType, where: string): void => {
    switch (type.kind) {
      case 'enum':
        if (!enumNames.has(type.ref)) {
          throw new Error(`${where} references unknown enum "${type.ref}"`);
        }
        return;
      case 'struct':
        if (!seenStructs.has(type.ref)) {
          throw new Error(
            `${where} references struct "${type.ref}" before it is declared — ` +
              'reorder the schema files so dependencies come first',
          );
        }
        return;
      case 'array':
        return walk(type.items, where);
      case 'optional':
        return walk(type.inner, where);
      default:
        return;
    }
  };

  for (const struct of reg.structs) {
    if (struct.fields.length === 0) {
      throw new Error(`struct "${struct.name}" has no fields`);
    }
    const fieldNames = new Set<string>();
    for (const f of struct.fields) {
      if (fieldNames.has(f.name)) {
        throw new Error(`struct "${struct.name}" declares field "${f.name}" twice`);
      }
      fieldNames.add(f.name);
      walk(f.type, `${struct.name}.${f.name}`);
    }
    seenStructs.add(struct.name);
  }
}
