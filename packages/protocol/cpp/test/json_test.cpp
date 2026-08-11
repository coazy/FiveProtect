// Tests for the hand-written JSON value type.
//
// Hostile input is the normal case here: the scan engine runs on a machine the attacker
// controls, so malformed payloads must produce a clean failure rather than a crash.

#include "fiveprotect_json.hpp"
#include "testing.hpp"

#include <string>

namespace json = fiveprotect::json;
using fiveprotect::testing::check;
using fiveprotect::testing::check_equal;

FIVEPROTECT_TEST(parses_scalars) {
    check(json::parse("true").value().as_bool(), "true");
    check(!json::parse("false").value().as_bool(), "false");
    check(json::parse("null").value().is_null(), "null");
    check_equal(json::parse("42").value().as_int(), 42, "integer");
    check_equal(json::parse("-17").value().as_int(), -17, "negative integer");
    check_equal(json::parse("\"hello\"").value().as_string(), std::string("hello"), "string");
}

FIVEPROTECT_TEST(parses_nested_structures) {
    const auto value = json::parse(R"({"a":[1,2,{"b":true}],"c":{"d":"e"}})");
    check(value.has_value(), "should parse");
    check_equal(value->as_object().size(), std::size_t{2}, "two members");
    check_equal(value->find("a")->as_array().size(), std::size_t{3}, "three items");
    check(value->find("a")->as_array()[2].find("b")->as_bool(), "nested boolean");
    check_equal(value->find("c")->find("d")->as_string(), std::string("e"), "nested string");
}

FIVEPROTECT_TEST(round_trips_escapes) {
    const std::string source = R"("line\nbreak \"quoted\" back\\slash tab\there")";
    const auto parsed = json::parse(source);
    check(parsed.has_value(), "escapes parse");
    const std::string expected = "line\nbreak \"quoted\" back\\slash tab\there";
    check_equal(parsed->as_string(), expected, "escapes decode");
    const auto again = json::parse(json::serialize(*parsed));
    check_equal(again->as_string(), expected, "escapes survive a round trip");
}

FIVEPROTECT_TEST(decodes_unicode_escapes) {
    const auto parsed = json::parse(R"("äöü")");
    check(parsed.has_value(), "bmp escapes parse");
    check_equal(parsed->as_string(), std::string("\xc3\xa4\xc3\xb6\xc3\xbc"), "utf-8 encoded");

    const auto emoji = json::parse(R"("😀")");
    check(emoji.has_value(), "surrogate pair parses");
    check_equal(emoji->as_string().size(), std::size_t{4}, "four utf-8 bytes");
}

FIVEPROTECT_TEST(rejects_malformed_input) {
    const char* bad[] = {
        "{",
        "[1,2",
        R"({"a":})",
        R"({"a" 1})",
        R"("unterminated)",
        R"({"a":1}trailing)",
        R"("\ud83d")",   // lone high surrogate
        R"("\q")",       // unknown escape
        "",
    };
    for (const char* text : bad) {
        std::string error;
        const auto parsed = json::parse(text, &error);
        check(!parsed.has_value(), std::string("should reject: ") + text);
        check(!error.empty(), std::string("should explain: ") + text);
    }
}

FIVEPROTECT_TEST(rejects_deeply_nested_input) {
    // A hostile payload aimed at the stack. The limit is well above what the protocol needs.
    std::string deep;
    for (int i = 0; i < 200; ++i) deep += "[";
    for (int i = 0; i < 200; ++i) deep += "]";

    std::string error;
    check(!json::parse(deep, &error).has_value(), "deep nesting is refused");
    check_equal(error.find("nesting too deep") != std::string::npos, true, "names the reason");
}

FIVEPROTECT_TEST(serializes_object_members_in_a_stable_order) {
    // Determinism matters: build hashes and log lines are compared across runs.
    json::Object object;
    object["zebra"] = json::Value(1);
    object["alpha"] = json::Value(2);
    check_equal(json::serialize(json::Value(object)), std::string(R"({"alpha":2,"zebra":1})"), "sorted");
}

FIVEPROTECT_TEST(treats_absent_and_null_alike) {
    const auto value = json::parse(R"({"present":1,"explicit":null})");
    check(value->has("present"), "present");
    check(!value->has("explicit"), "explicit null counts as absent");
    check(!value->has("missing"), "missing");
}

FIVEPROTECT_TEST(compares_integers_and_doubles_numerically) {
    check(json::parse("1").value() == json::parse("1.0").value(), "1 equals 1.0");
    check(json::parse("1").value() != json::parse("2").value(), "1 differs from 2");
}

int main() {
    std::cout << "\nfiveprotect_json\n";
    return fiveprotect::testing::run_all();
}
