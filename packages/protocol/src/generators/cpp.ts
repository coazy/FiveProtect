import type { FieldType, Registry, StructDef } from '../ir.js';
import {
  UnsupportedTypeError,
  Writer,
  banner,
  constraintNote,
  isOptional,
  pascalCase,
  unwrapOptional,
} from './emit.js';

/**
 * Emits a header-only C++ binding for the scan engine.
 *
 * Header-only keeps the engine's build to a single target with no generated translation
 * unit to forget. `from_json` returns a bool and fills an error string rather than
 * throwing: the engine runs on a machine the attacker controls, so a malformed payload is
 * an expected input, not an exceptional one.
 */
export function generateCpp(registry: Registry): string {
  const w = new Writer('    ');

  w.lines_(banner('// '));
  w.line();
  w.line('#ifndef FIVEPROTECT_PROTOCOL_HPP');
  w.line('#define FIVEPROTECT_PROTOCOL_HPP');
  w.line();
  w.line('#include <cstddef>');
  w.line('#include <cstdint>');
  w.line('#include <optional>');
  w.line('#include <string>');
  w.line('#include <string_view>');
  w.line('#include <vector>');
  w.line();
  w.line('#include "fiveprotect_json.hpp"');
  w.line();
  w.line('namespace fiveprotect::protocol {');
  w.line();
  w.line('using fiveprotect::json::Value;');
  w.line();

  w.line('// --- Constants -------------------------------------------------------------');
  w.line();
  for (const c of registry.constants) {
    w.comment('/// ', c.doc);
    w.line(`inline constexpr std::int64_t ${c.name} = ${c.value};`);
    w.line();
  }

  w.line('// --- Enums -----------------------------------------------------------------');
  w.line();
  for (const e of registry.enums) {
    w.comment('/// ', e.doc);
    w.line(`enum class ${e.name} {`);
    w.indent(() => {
      for (const v of e.values) {
        w.comment('/// ', v.doc);
        w.line(`${pascalCase(v.value)},`);
      }
    });
    w.line('};');
    w.line();
    w.line(`inline const char* to_wire(${e.name} value) {`);
    w.indent(() => {
      w.line('switch (value) {');
      w.indent(() => {
        for (const v of e.values) {
          w.line(`case ${e.name}::${pascalCase(v.value)}: return "${v.value}";`);
        }
      });
      w.line('}');
      w.line('return "";');
    });
    w.line('}');
    w.line();
    w.line(`inline bool from_wire(std::string_view text, ${e.name}& out) {`);
    w.indent(() => {
      for (const v of e.values) {
        w.line(
          `if (text == "${v.value}") { out = ${e.name}::${pascalCase(v.value)}; return true; }`,
        );
      }
      w.line('return false;');
    });
    w.line('}');
    w.line();
  }

  w.line('// --- Structs ---------------------------------------------------------------');
  w.line();
  for (const s of registry.structs) {
    w.comment('/// ', s.doc);
    w.line(`struct ${s.name} {`);
    w.indent(() => {
      for (const f of s.fields) {
        const note = constraintNote(f.type);
        w.comment('/// ', `${f.doc}${note ? ` ${note}` : ''}`);
        w.line(`${cppType(f.type)} ${f.name}${defaultInitializer(f.type)};`);
      }
      w.line();
      w.line('Value to_json() const;');
      w.line(`static bool from_json(const Value& value, ${s.name}& out, std::string* error);`);
    });
    w.line('};');
    w.line();
  }

  w.line('// --- Helpers ---------------------------------------------------------------');
  w.line();
  w.lines_([
    'namespace detail {',
    '',
    'inline bool set_error(std::string* error, const std::string& message) {',
    '    if (error != nullptr) *error = message;',
    '    return false;',
    '}',
    '',
    'inline bool require_object(const Value& value, std::string* error, const char* what) {',
    '    if (!value.is_object()) return set_error(error, std::string(what) + ": expected an object");',
    '    return true;',
    '}',
    '',
    '// Format checks mirror the Lua patterns rather than the richer TypeScript ones. They',
    '// catch a wrong shape; the backend stays the authority on well-formedness.',
    'inline bool all_of(std::string_view text, bool (*predicate)(char)) {',
    '    for (char c : text) {',
    '        if (!predicate(c)) return false;',
    '    }',
    '    return true;',
    '}',
    '',
    'inline bool is_hex_digit(char c) {',
    "    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');",
    '}',
    '',
    'inline bool is_base64_char(char c) {',
    "    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')",
    "        || c == '+' || c == '/' || c == '=';",
    '}',
    '',
    'inline bool is_ip_char(char c) {',
    "    return is_hex_digit(c) || c == '.' || c == ':';",
    '}',
    '',
    'inline bool is_uuid(std::string_view text) {',
    '    if (text.size() != 36) return false;',
    '    for (std::size_t i = 0; i < text.size(); ++i) {',
    '        const bool dash_position = (i == 8 || i == 13 || i == 18 || i == 23);',
    "        if (dash_position ? text[i] != '-' : !is_hex_digit(text[i])) return false;",
    '    }',
    '    return true;',
    '}',
    '',
    'inline bool is_datetime(std::string_view text) {',
    '    // YYYY-MM-DDThh:mm:ss — anything after that is optional precision or a zone.',
    '    if (text.size() < 19) return false;',
    '    const char* shape = "0000-00-00T00:00:00";',
    '    for (std::size_t i = 0; i < 19; ++i) {',
    "        if (shape[i] == '0') {",
    "            if (text[i] < '0' || text[i] > '9') return false;",
    '        } else if (text[i] != shape[i]) {',
    '            return false;',
    '        }',
    '    }',
    '    return true;',
    '}',
    '',
    'inline bool is_semver(std::string_view text) {',
    '    int dots = 0;',
    '    bool digit_in_part = false;',
    '    for (char c : text) {',
    "        if (c >= '0' && c <= '9') {",
    '            digit_in_part = true;',
    "        } else if (c == '.') {",
    '            if (!digit_in_part) return false;',
    '            digit_in_part = false;',
    '            if (++dots > 2) break;',
    '        } else {',
    '            break;',
    '        }',
    '    }',
    '    return dots >= 2 && digit_in_part;',
    '}',
    '',
    'inline bool reject_unknown_fields(const Value& value, const char* const* known, std::size_t count,',
    '                                  std::string* error, const char* what) {',
    '    for (const auto& [key, ignored] : value.as_object()) {',
    '        (void)ignored;',
    '        bool found = false;',
    '        for (std::size_t i = 0; i < count; ++i) {',
    '            if (key == known[i]) { found = true; break; }',
    '        }',
    '        if (!found) {',
    '            return set_error(error, std::string(what) + ": unexpected field \\"" + key + "\\"");',
    '        }',
    '    }',
    '    return true;',
    '}',
    '',
    '}  // namespace detail',
  ]);
  w.line();

  w.line('// --- Serialization ---------------------------------------------------------');
  w.line();
  for (const s of registry.structs) {
    emitToJson(w, s);
    emitFromJson(w, s);
  }

  w.line('}  // namespace fiveprotect::protocol');
  w.line();
  w.line('#endif  // FIVEPROTECT_PROTOCOL_HPP');

  return w.toString();
}

function emitToJson(w: Writer, s: StructDef): void {
  w.line(`inline Value ${s.name}::to_json() const {`);
  w.indent(() => {
    w.line('fiveprotect::json::Object object;');
    for (const f of s.fields) {
      if (isOptional(f.type)) {
        w.line(`if (${f.name}.has_value()) {`);
        w.indent(() => {
          w.line(
            `object["${f.name}"] = ${toJsonExpr(unwrapOptional(f.type), `${f.name}.value()`)};`,
          );
        });
        w.line('}');
      } else {
        w.line(`object["${f.name}"] = ${toJsonExpr(f.type, f.name)};`);
      }
    }
    w.line('return Value(std::move(object));');
  });
  w.line('}');
  w.line();
}

function toJsonExpr(type: FieldType, expr: string): string {
  switch (type.kind) {
    case 'string':
      return `Value(${expr})`;
    case 'int':
      return `Value(static_cast<std::int64_t>(${expr}))`;
    case 'bool':
      return `Value(${expr})`;
    case 'enum':
      return `Value(std::string(to_wire(${expr})))`;
    case 'struct':
      return `${expr}.to_json()`;
    case 'array': {
      // A lambda keeps the element conversion inline without a named helper per type.
      const inner = toJsonExpr(type.items, 'item');
      return `[&]{ fiveprotect::json::Array array; for (const auto& item : ${expr}) { array.push_back(${inner}); } return Value(std::move(array)); }()`;
    }
    case 'optional':
      return toJsonExpr(type.inner, `${expr}.value()`);
    default:
      throw new UnsupportedTypeError('cpp', type);
  }
}

function emitFromJson(w: Writer, s: StructDef): void {
  // An unknown field means the two ends disagree about the protocol. TypeScript, Rust and
  // Lua all reject it; C++ does the same so one fixture set covers all four.
  w.line(`inline const char* const ${s.name}_known_fields[] = {`);
  w.indent(() => {
    for (const f of s.fields) w.line(`"${f.name}",`);
  });
  w.line('};');
  w.line();
  w.line(
    `inline bool ${s.name}::from_json(const Value& value, ${s.name}& out, std::string* error) {`,
  );
  w.indent(() => {
    w.line(`if (!detail::require_object(value, error, "${s.name}")) return false;`);
    w.line(
      `if (!detail::reject_unknown_fields(value, ${s.name}_known_fields, ` +
        `sizeof(${s.name}_known_fields) / sizeof(${s.name}_known_fields[0]), error, "${s.name}")) return false;`,
    );
    for (const f of s.fields) {
      const where = `${s.name}.${f.name}`;
      if (isOptional(f.type)) {
        w.line(`if (value.has("${f.name}")) {`);
        w.indent(() => {
          w.line(`const Value& field = *value.find("${f.name}");`);
          w.line(`${cppType(unwrapOptional(f.type))} parsed{};`);
          emitFieldParse(w, unwrapOptional(f.type), 'field', 'parsed', where);
          w.line(`out.${f.name} = std::move(parsed);`);
        });
        w.line('} else {');
        w.indent(() => w.line(`out.${f.name} = std::nullopt;`));
        w.line('}');
      } else {
        w.line(`{`);
        w.indent(() => {
          w.line(`const Value* found = value.find("${f.name}");`);
          w.line(
            `if (found == nullptr || found->is_null()) return detail::set_error(error, "${where}: missing");`,
          );
          w.line('const Value& field = *found;');
          emitFieldParse(w, f.type, 'field', `out.${f.name}`, where);
        });
        w.line(`}`);
      }
    }
    w.line('return true;');
  });
  w.line('}');
  w.line();
}

/** Emits statements that read `src` (a Value) into `dst` (an lvalue of the mapped type). */
function emitFieldParse(w: Writer, type: FieldType, src: string, dst: string, where: string): void {
  switch (type.kind) {
    case 'string':
      w.line(
        `if (!${src}.is_string()) return detail::set_error(error, "${where}: expected a string");`,
      );
      if (type.minLength !== undefined) {
        w.line(
          `if (${src}.as_string().size() < ${type.minLength}u) ` +
            `return detail::set_error(error, "${where}: shorter than ${type.minLength} characters");`,
        );
      }
      if (type.maxLength !== undefined) {
        w.line(
          `if (${src}.as_string().size() > ${type.maxLength}u) ` +
            `return detail::set_error(error, "${where}: longer than ${type.maxLength} characters");`,
        );
      }
      emitFormatCheck(w, type.format, src, where);
      w.line(`${dst} = ${src}.as_string();`);
      return;
    case 'int':
      w.line(
        `if (!${src}.is_number()) return detail::set_error(error, "${where}: expected a number");`,
      );
      if (type.min !== undefined) {
        w.line(
          `if (${src}.as_int() < ${type.min}) ` +
            `return detail::set_error(error, "${where}: below the minimum of ${type.min}");`,
        );
      }
      if (type.max !== undefined) {
        w.line(
          `if (${src}.as_int() > ${type.max}) ` +
            `return detail::set_error(error, "${where}: above the maximum of ${type.max}");`,
        );
      }
      w.line(`${dst} = ${src}.as_int();`);
      return;
    case 'bool':
      w.line(
        `if (!${src}.is_bool()) return detail::set_error(error, "${where}: expected a boolean");`,
      );
      w.line(`${dst} = ${src}.as_bool();`);
      return;
    case 'enum':
      w.line(
        `if (!${src}.is_string()) return detail::set_error(error, "${where}: expected a string");`,
      );
      w.line(
        `if (!from_wire(${src}.as_string(), ${dst})) return detail::set_error(error, "${where}: unknown value \\"" + ${src}.as_string() + "\\"");`,
      );
      return;
    case 'struct':
      w.line(`if (!${type.ref}::from_json(${src}, ${dst}, error)) return false;`);
      return;
    case 'array': {
      w.line(
        `if (!${src}.is_array()) return detail::set_error(error, "${where}: expected an array");`,
      );
      if (type.maxItems !== undefined) {
        w.line(
          `if (${src}.as_array().size() > ${type.maxItems}u) ` +
            `return detail::set_error(error, "${where}: holds more than ${type.maxItems} items");`,
        );
      }
      w.line(`${dst}.clear();`);
      w.line(`for (const Value& element : ${src}.as_array()) {`);
      w.indent(() => {
        w.line(`${cppType(type.items)} item{};`);
        emitFieldParse(w, type.items, 'element', 'item', `${where}[]`);
        w.line(`${dst}.push_back(std::move(item));`);
      });
      w.line('}');
      return;
    }
    default:
      throw new UnsupportedTypeError('cpp', type);
  }
}

function emitFormatCheck(w: Writer, format: string | undefined, src: string, where: string): void {
  const check: Record<string, [string, string]> = {
    hex: [`detail::all_of(${src}.as_string(), detail::is_hex_digit)`, 'hex'],
    base64: [`detail::all_of(${src}.as_string(), detail::is_base64_char)`, 'base64'],
    ip: [`detail::all_of(${src}.as_string(), detail::is_ip_char)`, 'an IP address'],
    uuid: [`detail::is_uuid(${src}.as_string())`, 'a UUID'],
    datetime: [`detail::is_datetime(${src}.as_string())`, 'an ISO 8601 timestamp'],
    semver: [`detail::is_semver(${src}.as_string())`, 'a semantic version'],
  };
  const entry = format === undefined ? undefined : check[format];
  if (entry === undefined) return;
  const [expr, label] = entry;
  w.line(`if (!${expr}) return detail::set_error(error, "${where}: does not look like ${label}");`);
}

function cppType(type: FieldType): string {
  switch (type.kind) {
    case 'string':
      return 'std::string';
    case 'int':
      return 'std::int64_t';
    case 'bool':
      return 'bool';
    case 'enum':
    case 'struct':
      return type.ref;
    case 'array':
      return `std::vector<${cppType(type.items)}>`;
    case 'optional':
      return `std::optional<${cppType(type.inner)}>`;
    default:
      throw new UnsupportedTypeError('cpp', type);
  }
}

/**
 * Value-initializes scalars so a default-constructed struct never carries indeterminate
 * data. Class types initialize themselves; enums need an explicit first value.
 */
function defaultInitializer(type: FieldType): string {
  switch (type.kind) {
    case 'int':
      return ' = 0';
    case 'bool':
      return ' = false';
    case 'enum':
      return ` = ${type.ref}{}`;
    default:
      return '';
  }
}
