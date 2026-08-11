// FiveProtect — minimal JSON value type for the scan engine.
//
// Hand written on purpose. The scan engine is a read-only Windows component that must
// build without a package manager and without network access in CI, and the only JSON it
// ever meets is the protocol defined in packages/protocol. A vendored general purpose
// library would be more code, not less, for this surface.
//
// Scope: parse and serialize the subset RFC 8259 requires for that protocol. Object keys
// are kept sorted so serialization is deterministic; the protocol assigns no meaning to
// member order.

#ifndef FIVEPROTECT_JSON_HPP
#define FIVEPROTECT_JSON_HPP

#include <cstdint>
#include <cstdio>
#include <exception>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace fiveprotect::json {

class Value;

using Object = std::map<std::string, Value>;
using Array = std::vector<Value>;

enum class Type { Null, Bool, Int, Double, String, Array, Object };

class Value {
public:
    Value() : type_(Type::Null) {}
    Value(std::nullptr_t) : type_(Type::Null) {}
    Value(bool v) : type_(Type::Bool), bool_(v) {}
    Value(std::int64_t v) : type_(Type::Int), int_(v) {}
    Value(int v) : type_(Type::Int), int_(static_cast<std::int64_t>(v)) {}
    Value(double v) : type_(Type::Double), double_(v) {}
    Value(std::string v) : type_(Type::String), string_(std::move(v)) {}
    Value(const char* v) : type_(Type::String), string_(v) {}
    Value(Array v) : type_(Type::Array), array_(std::move(v)) {}
    Value(Object v) : type_(Type::Object), object_(std::move(v)) {}

    Type type() const { return type_; }
    bool is_null() const { return type_ == Type::Null; }
    bool is_bool() const { return type_ == Type::Bool; }
    bool is_int() const { return type_ == Type::Int; }
    bool is_number() const { return type_ == Type::Int || type_ == Type::Double; }
    bool is_string() const { return type_ == Type::String; }
    bool is_array() const { return type_ == Type::Array; }
    bool is_object() const { return type_ == Type::Object; }

    bool as_bool() const { return bool_; }
    std::int64_t as_int() const { return type_ == Type::Double ? static_cast<std::int64_t>(double_) : int_; }
    double as_double() const { return type_ == Type::Int ? static_cast<double>(int_) : double_; }
    const std::string& as_string() const { return string_; }
    const Array& as_array() const { return array_; }
    const Object& as_object() const { return object_; }

    Array& as_array() { return array_; }
    Object& as_object() { return object_; }

    /// Member lookup that does not create the member. Returns nullptr when absent.
    const Value* find(std::string_view key) const {
        if (type_ != Type::Object) return nullptr;
        auto it = object_.find(std::string(key));
        return it == object_.end() ? nullptr : &it->second;
    }

    /// Absent and explicit null are treated the same. A protocol field that is optional is
    /// allowed to arrive either way, and no field carries a meaningful null.
    bool has(std::string_view key) const {
        const Value* v = find(key);
        return v != nullptr && !v->is_null();
    }

    void set(std::string key, Value value) {
        type_ = Type::Object;
        object_.insert_or_assign(std::move(key), std::move(value));
    }

    bool operator==(const Value& other) const {
        if (type_ != other.type_) {
            // Int and Double compare numerically so a fixture written as 1 matches a value
            // produced as 1.0.
            if (is_number() && other.is_number()) return as_double() == other.as_double();
            return false;
        }
        switch (type_) {
            case Type::Null: return true;
            case Type::Bool: return bool_ == other.bool_;
            case Type::Int: return int_ == other.int_;
            case Type::Double: return double_ == other.double_;
            case Type::String: return string_ == other.string_;
            case Type::Array: return array_ == other.array_;
            case Type::Object: return object_ == other.object_;
        }
        return false;
    }
    bool operator!=(const Value& other) const { return !(*this == other); }

private:
    Type type_;
    bool bool_ = false;
    std::int64_t int_ = 0;
    double double_ = 0.0;
    std::string string_;
    Array array_;
    Object object_;
};

// --- Serialization ---------------------------------------------------------

inline void escape_into(const std::string& in, std::string& out) {
    out.push_back('"');
    for (unsigned char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[7];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    out.push_back('"');
}

inline void serialize_into(const Value& value, std::string& out) {
    switch (value.type()) {
        case Type::Null: out += "null"; return;
        case Type::Bool: out += value.as_bool() ? "true" : "false"; return;
        case Type::Int: out += std::to_string(value.as_int()); return;
        case Type::Double: {
            std::ostringstream oss;
            oss.precision(17);
            oss << value.as_double();
            out += oss.str();
            return;
        }
        case Type::String: escape_into(value.as_string(), out); return;
        case Type::Array: {
            out.push_back('[');
            bool first = true;
            for (const Value& item : value.as_array()) {
                if (!first) out.push_back(',');
                first = false;
                serialize_into(item, out);
            }
            out.push_back(']');
            return;
        }
        case Type::Object: {
            out.push_back('{');
            bool first = true;
            for (const auto& [key, item] : value.as_object()) {
                if (!first) out.push_back(',');
                first = false;
                escape_into(key, out);
                out.push_back(':');
                serialize_into(item, out);
            }
            out.push_back('}');
            return;
        }
    }
}

inline std::string serialize(const Value& value) {
    std::string out;
    serialize_into(value, out);
    return out;
}

// --- Parsing ---------------------------------------------------------------

namespace detail {

struct Parser {
    std::string_view text;
    std::size_t pos = 0;
    std::string error;

    bool fail(const char* message) {
        if (error.empty()) {
            error = std::string(message) + " at offset " + std::to_string(pos);
        }
        return false;
    }

    void skip_ws() {
        while (pos < text.size()) {
            const char c = text[pos];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++pos;
            } else {
                break;
            }
        }
    }

    bool literal(std::string_view word) {
        if (text.compare(pos, word.size(), word) != 0) return fail("unexpected token");
        pos += word.size();
        return true;
    }

    /// Appends one UTF-8 encoded code point. Surrogate pairs are combined by the caller.
    static void append_utf8(std::uint32_t cp, std::string& out) {
        if (cp <= 0x7F) {
            out.push_back(static_cast<char>(cp));
        } else if (cp <= 0x7FF) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp <= 0xFFFF) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool parse_hex4(std::uint32_t& out) {
        if (pos + 4 > text.size()) return fail("truncated \\u escape");
        out = 0;
        for (int i = 0; i < 4; ++i) {
            const char c = text[pos + static_cast<std::size_t>(i)];
            out <<= 4;
            if (c >= '0' && c <= '9') out |= static_cast<std::uint32_t>(c - '0');
            else if (c >= 'a' && c <= 'f') out |= static_cast<std::uint32_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') out |= static_cast<std::uint32_t>(c - 'A' + 10);
            else return fail("invalid \\u escape");
        }
        pos += 4;
        return true;
    }

    bool parse_string(std::string& out) {
        if (pos >= text.size() || text[pos] != '"') return fail("expected string");
        ++pos;
        while (true) {
            if (pos >= text.size()) return fail("unterminated string");
            const char c = text[pos++];
            if (c == '"') return true;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (pos >= text.size()) return fail("unterminated escape");
            const char esc = text[pos++];
            switch (esc) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    std::uint32_t cp = 0;
                    if (!parse_hex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        // High surrogate — a low surrogate must follow.
                        if (pos + 1 < text.size() && text[pos] == '\\' && text[pos + 1] == 'u') {
                            pos += 2;
                            std::uint32_t low = 0;
                            if (!parse_hex4(low)) return false;
                            if (low < 0xDC00 || low > 0xDFFF) return fail("invalid low surrogate");
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                        } else {
                            return fail("lone high surrogate");
                        }
                    }
                    append_utf8(cp, out);
                    break;
                }
                default:
                    return fail("unknown escape");
            }
        }
    }

    bool parse_number(Value& out) {
        const std::size_t start = pos;
        if (pos < text.size() && (text[pos] == '-' || text[pos] == '+')) ++pos;
        bool is_double = false;
        while (pos < text.size()) {
            const char c = text[pos];
            if (c >= '0' && c <= '9') {
                ++pos;
            } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                is_double = true;
                ++pos;
            } else {
                break;
            }
        }
        if (pos == start) return fail("expected number");
        const std::string token(text.substr(start, pos - start));
        try {
            if (is_double) {
                out = Value(std::stod(token));
            } else {
                out = Value(static_cast<std::int64_t>(std::stoll(token)));
            }
        } catch (const std::exception&) {
            return fail("number out of range");
        }
        return true;
    }

    bool parse_value(Value& out, int depth) {
        // Bounded recursion: the protocol nests three levels, so anything deeper is either
        // a bug or a hostile payload aimed at the stack.
        if (depth > 32) return fail("nesting too deep");
        skip_ws();
        if (pos >= text.size()) return fail("unexpected end of input");
        switch (text[pos]) {
            case 'n':
                if (!literal("null")) return false;
                out = Value(nullptr);
                return true;
            case 't':
                if (!literal("true")) return false;
                out = Value(true);
                return true;
            case 'f':
                if (!literal("false")) return false;
                out = Value(false);
                return true;
            case '"': {
                std::string s;
                if (!parse_string(s)) return false;
                out = Value(std::move(s));
                return true;
            }
            case '[': {
                ++pos;
                Array array;
                skip_ws();
                if (pos < text.size() && text[pos] == ']') {
                    ++pos;
                    out = Value(std::move(array));
                    return true;
                }
                while (true) {
                    Value item;
                    if (!parse_value(item, depth + 1)) return false;
                    array.push_back(std::move(item));
                    skip_ws();
                    if (pos >= text.size()) return fail("unterminated array");
                    if (text[pos] == ',') {
                        ++pos;
                        continue;
                    }
                    if (text[pos] == ']') {
                        ++pos;
                        out = Value(std::move(array));
                        return true;
                    }
                    return fail("expected , or ] in array");
                }
            }
            case '{': {
                ++pos;
                Object object;
                skip_ws();
                if (pos < text.size() && text[pos] == '}') {
                    ++pos;
                    out = Value(std::move(object));
                    return true;
                }
                while (true) {
                    skip_ws();
                    std::string key;
                    if (!parse_string(key)) return false;
                    skip_ws();
                    if (pos >= text.size() || text[pos] != ':') return fail("expected : after key");
                    ++pos;
                    Value item;
                    if (!parse_value(item, depth + 1)) return false;
                    object.insert_or_assign(std::move(key), std::move(item));
                    skip_ws();
                    if (pos >= text.size()) return fail("unterminated object");
                    if (text[pos] == ',') {
                        ++pos;
                        continue;
                    }
                    if (text[pos] == '}') {
                        ++pos;
                        out = Value(std::move(object));
                        return true;
                    }
                    return fail("expected , or } in object");
                }
            }
            default:
                return parse_number(out);
        }
    }
};

}  // namespace detail

/// Parses `text`. On failure returns std::nullopt and, when `error` is given, a message.
inline std::optional<Value> parse(std::string_view text, std::string* error = nullptr) {
    detail::Parser parser{text};
    Value value;
    if (!parser.parse_value(value, 0)) {
        if (error != nullptr) *error = parser.error;
        return std::nullopt;
    }
    parser.skip_ws();
    if (parser.pos != text.size()) {
        if (error != nullptr) *error = "trailing content after JSON value";
        return std::nullopt;
    }
    return value;
}

}  // namespace fiveprotect::json

#endif  // FIVEPROTECT_JSON_HPP
