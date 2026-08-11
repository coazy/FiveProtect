import type { FieldType, Registry, StructDef } from '../ir.js';
import { UnsupportedTypeError, Writer, banner, isOptional, unwrapOptional } from './emit.js';

/**
 * Emits a validator module for the FiveM resource.
 *
 * Lua has no types to generate, so the useful artifact is validation. The resource talks
 * to the backend over HTTP and to the companion through NUI; both are places where a
 * malformed payload must produce a named error rather than a nil index three call frames
 * later, while a player sits in a deferral.
 *
 * Validators operate on already decoded tables. Decoding is the caller's job — inside
 * FiveM that is the built-in `json` global.
 */
export function generateLua(registry: Registry): string {
  const w = new Writer('    ');

  w.lines_(banner('-- '));
  w.line();
  w.line('local M = {}');
  w.line();

  w.line('-- Constants ----------------------------------------------------------------');
  w.line();
  for (const c of registry.constants) {
    w.comment('--- ', c.doc);
    w.line(`M.${c.name} = ${c.value}`);
    w.line();
  }

  w.line('-- Enums --------------------------------------------------------------------');
  w.line();
  w.line('--- Allowed wire values per enum, in declaration order.');
  w.line('M.enums = {');
  w.indent(() => {
    for (const e of registry.enums) {
      w.line(`${e.name} = {`);
      w.indent(() => {
        for (const v of e.values) w.line(`'${v.value}',`);
      });
      w.line('},');
    }
  });
  w.line('}');
  w.line();
  w.lines_([
    'local enum_sets = {}',
    'for enum_name, values in pairs(M.enums) do',
    '    local set = {}',
    '    for _, value in ipairs(values) do',
    '        set[value] = true',
    '    end',
    '    enum_sets[enum_name] = set',
    'end',
  ]);
  w.line();

  w.line('-- Check helpers ------------------------------------------------------------');
  w.line();
  w.lines_(LUA_HELPERS);
  w.line();

  w.line('-- Validators ---------------------------------------------------------------');
  w.line();
  w.line('M.validate = {}');
  w.line();
  for (const s of registry.structs) {
    emitValidator(w, s);
  }

  w.line('-- Schema list ---------------------------------------------------------------');
  w.line();
  w.line('--- Every message name, in declaration order. Used by the contract tests.');
  w.line('M.schema_names = {');
  w.indent(() => {
    for (const s of registry.structs) w.line(`'${s.name}',`);
  });
  w.line('}');
  w.line();
  w.lines_([
    '-- FiveM loads shared scripts as plain chunks: there is no `require`, and the value a',
    '-- chunk returns is discarded. Publishing the module as a global is therefore the only',
    '-- way the resource can reach it. Test harnesses use `require` and take the return value;',
    '-- both paths end up with the same table.',
    'Protocol = M',
    '',
    'return M',
  ]);

  return w.toString();
}

const LUA_HELPERS = [
  '--- Every check returns `true` or `false, message`. The message names the full path so a',
  '--- failure points at a field rather than at a payload.',
  'local function fail(path, message)',
  '    return false, path .. ": " .. message',
  'end',
  '',
  'local function check_string(value, path, pattern, pattern_name, min_length, max_length)',
  '    if type(value) ~= "string" then',
  '        return fail(path, "expected a string, got " .. type(value))',
  '    end',
  '    if min_length and #value < min_length then',
  '        return fail(path, "shorter than " .. min_length .. " characters")',
  '    end',
  '    if max_length and #value > max_length then',
  '        return fail(path, "longer than " .. max_length .. " characters")',
  '    end',
  '    if pattern and not string.match(value, pattern) then',
  '        return fail(path, "does not look like " .. pattern_name)',
  '    end',
  '    return true',
  'end',
  '',
  'local function check_int(value, path, min_value, max_value)',
  '    if type(value) ~= "number" then',
  '        return fail(path, "expected a number, got " .. type(value))',
  '    end',
  '    if value ~= math.floor(value) then',
  '        return fail(path, "expected an integer")',
  '    end',
  '    if min_value and value < min_value then',
  '        return fail(path, "below the minimum of " .. min_value)',
  '    end',
  '    if max_value and value > max_value then',
  '        return fail(path, "above the maximum of " .. max_value)',
  '    end',
  '    return true',
  'end',
  '',
  'local function check_boolean(value, path)',
  '    if type(value) ~= "boolean" then',
  '        return fail(path, "expected a boolean, got " .. type(value))',
  '    end',
  '    return true',
  'end',
  '',
  'local function check_enum(value, path, enum_name)',
  '    if type(value) ~= "string" then',
  '        return fail(path, "expected a string, got " .. type(value))',
  '    end',
  '    if not enum_sets[enum_name][value] then',
  '        return fail(path, "\'" .. value .. "\' is not a valid " .. enum_name)',
  '    end',
  '    return true',
  'end',
  '',
  '--- Arrays arrive as sequential tables. An empty JSON array decodes to an empty table,',
  '--- which is indistinguishable from an empty object in Lua — both are accepted here',
  '--- because the protocol never gives a field both meanings.',
  'local function check_array(value, path, max_items, check_item)',
  '    if type(value) ~= "table" then',
  '        return fail(path, "expected a table, got " .. type(value))',
  '    end',
  '    local count = 0',
  '    for key in pairs(value) do',
  '        if type(key) ~= "number" then',
  '            return fail(path, "expected an array, found the key \'" .. tostring(key) .. "\'")',
  '        end',
  '        count = count + 1',
  '    end',
  '    if count ~= #value then',
  '        return fail(path, "array has holes")',
  '    end',
  '    if max_items and count > max_items then',
  '        return fail(path, "holds more than " .. max_items .. " items")',
  '    end',
  '    for index, item in ipairs(value) do',
  '        local ok, err = check_item(item, path .. "[" .. index .. "]")',
  '        if not ok then',
  '            return false, err',
  '        end',
  '    end',
  '    return true',
  'end',
  '',
  '--- Mirrors the strict object schemas on the TypeScript side: an unexpected key means the',
  '--- two ends disagree about the protocol, and that is worth failing over.',
  'local function check_no_extra_keys(value, path, allowed)',
  '    for key in pairs(value) do',
  '        if not allowed[key] then',
  '            return fail(path, "unexpected field \'" .. tostring(key) .. "\'")',
  '        end',
  '    end',
  '    return true',
  'end',
];

function emitValidator(w: Writer, s: StructDef): void {
  w.comment('--- ', s.doc);
  w.line(`--- @return boolean, string|nil`);
  w.line(`local ${s.name}_fields = {`);
  w.indent(() => {
    for (const f of s.fields) w.line(`${f.name} = true,`);
  });
  w.line('}');
  w.line();
  w.line(`function M.validate.${s.name}(value, path)`);
  w.indent(() => {
    w.line(`path = path or '${s.name}'`);
    w.line('if type(value) ~= "table" then');
    w.indent(() => w.line('return fail(path, "expected a table, got " .. type(value))'));
    w.line('end');
    w.line('local ok, err');
    w.line(`ok, err = check_no_extra_keys(value, path, ${s.name}_fields)`);
    w.line('if not ok then return false, err end');

    for (const f of s.fields) {
      const access = `value.${f.name}`;
      const path = `path .. '.${f.name}'`;
      if (isOptional(f.type)) {
        w.line(`if ${access} ~= nil then`);
        w.indent(() => {
          emitCheck(w, unwrapOptional(f.type), access, path);
        });
        w.line('end');
      } else {
        w.line(`if ${access} == nil then return fail(path .. '.${f.name}', "is required") end`);
        emitCheck(w, f.type, access, path);
      }
    }
    w.line('return true');
  });
  w.line('end');
  w.line();
}

function emitCheck(w: Writer, type: FieldType, access: string, path: string): void {
  w.line(`ok, err = ${checkExpr(type, access, path)}`);
  w.line('if not ok then return false, err end');
}

function checkExpr(type: FieldType, access: string, path: string): string {
  switch (type.kind) {
    case 'string': {
      const [pattern, name] = luaPattern(type.format);
      const min = type.minLength ?? 'nil';
      const max = type.maxLength ?? 'nil';
      return `check_string(${access}, ${path}, ${pattern}, ${name}, ${min}, ${max})`;
    }
    case 'int':
      return `check_int(${access}, ${path}, ${type.min ?? 'nil'}, ${type.max ?? 'nil'})`;
    case 'bool':
      return `check_boolean(${access}, ${path})`;
    case 'enum':
      return `check_enum(${access}, ${path}, '${type.ref}')`;
    case 'struct':
      return `M.validate.${type.ref}(${access}, ${path})`;
    case 'array': {
      const items = type.items;
      const itemCheck = checkExpr(items, 'item', 'item_path');
      return `check_array(${access}, ${path}, ${type.maxItems ?? 'nil'}, function(item, item_path) return ${itemCheck} end)`;
    }
    default:
      throw new UnsupportedTypeError('lua', type);
  }
}

/**
 * Lua patterns, not regular expressions — no alternation, no quantified groups. The checks
 * are therefore coarser than the TypeScript ones; they catch a wrong shape, and the backend
 * remains the authority on well-formedness.
 */
function luaPattern(format?: string): [string, string] {
  switch (format) {
    case 'uuid':
      return [
        "'^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$'",
        "'a UUID'",
      ];
    case 'hex':
      return ["'^%x*$'", "'hex'"];
    case 'base64':
      return ["'^[A-Za-z0-9+/=]*$'", "'base64'"];
    case 'ip':
      return ["'^[%x%.:]+$'", "'an IP address'"];
    case 'datetime':
      return ["'^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d'", "'an ISO 8601 timestamp'"];
    case 'semver':
      return ["'^%d+%.%d+%.%d+'", "'a semantic version'"];
    default:
      return ['nil', 'nil'];
  }
}
