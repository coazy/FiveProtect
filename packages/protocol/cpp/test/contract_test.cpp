// C++ half of the protocol contract tests.
//
// Reads the same fixtures TypeScript, Rust and Lua read. A fixture that the backend accepts
// but the scan engine cannot produce — or the reverse — is exactly the drift the protocol
// layer exists to catch, and it must fail here rather than on a player's machine.

#include "fiveprotect_json.hpp"
#include "fiveprotect_protocol.hpp"
#include "testing.hpp"

#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace json = fiveprotect::json;
namespace protocol = fiveprotect::protocol;
using fiveprotect::testing::check;
using fiveprotect::testing::check_equal;
using fiveprotect::testing::fail;

namespace {

std::string fixtures_dir() { return std::string(FIVEPROTECT_FIXTURES_DIR); }

std::string read_file(const std::string& relative) {
    const std::string path = fixtures_dir() + "/" + relative;
    std::ifstream stream(path, std::ios::binary);
    if (!stream) fail("cannot open fixture " + path);
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

json::Value read_fixture(const std::string& relative) {
    std::string error;
    auto value = json::parse(read_file(relative), &error);
    if (!value.has_value()) fail("fixture " + relative + " is not valid JSON: " + error);
    return *value;
}

/// Parses into the generated struct and serializes back. `ok` reports whether the payload
/// was accepted; `round_tripped` is what came back out.
using Handler = bool (*)(const json::Value& input, json::Value& round_tripped, std::string& error);

template <typename T>
bool handle(const json::Value& input, json::Value& round_tripped, std::string& error) {
    T parsed{};
    if (!T::from_json(input, parsed, &error)) return false;
    round_tripped = parsed.to_json();
    return true;
}

/// Only the messages the engine and the companion actually exchange need a handler; the
/// nested structs are covered through their parents.
const std::map<std::string, Handler>& handlers() {
    static const std::map<std::string, Handler> table = {
        {"SystemSnapshot", &handle<protocol::SystemSnapshot>},
        {"NonceRequest", &handle<protocol::NonceRequest>},
        {"NonceResponse", &handle<protocol::NonceResponse>},
        {"AttestationRequest", &handle<protocol::AttestationRequest>},
        {"AttestationAck", &handle<protocol::AttestationAck>},
        {"Verdict", &handle<protocol::Verdict>},
        {"LocalAttestCommand", &handle<protocol::LocalAttestCommand>},
        {"LocalAttestAck", &handle<protocol::LocalAttestAck>},
        {"HeartbeatRequest", &handle<protocol::HeartbeatRequest>},
        {"HeartbeatResponse", &handle<protocol::HeartbeatResponse>},
        {"LivenessResponse", &handle<protocol::LivenessResponse>},
        {"ProtocolError", &handle<protocol::ProtocolError>},
        {"CompanionOutcomeRequest", &handle<protocol::CompanionOutcomeRequest>},
        {"CompanionPollRequest", &handle<protocol::CompanionPollRequest>},
        {"CompanionPollResponse", &handle<protocol::CompanionPollResponse>},
    };
    return table;
}

struct Entry {
    std::string schema;
    std::string file;
};

std::vector<Entry> entries_from_index(const char* key) {
    const json::Value index = read_fixture("index.json");
    const json::Value* list = index.find(key);
    if (list == nullptr || !list->is_array()) fail(std::string("fixtures/index.json has no ") + key);

    std::vector<Entry> entries;
    for (const json::Value& item : list->as_array()) {
        entries.push_back(Entry{item.find("schema")->as_string(), item.find("file")->as_string()});
    }
    return entries;
}

}  // namespace

FIVEPROTECT_TEST(valid_fixtures_parse_and_round_trip) {
    for (const Entry& entry : entries_from_index("valid")) {
        const auto handler = handlers().find(entry.schema);
        if (handler == handlers().end()) continue;  // nested-only struct

        const json::Value input = read_fixture(entry.file);
        json::Value output;
        std::string error;
        if (!handler->second(input, output, error)) {
            fail(entry.file + " should be valid but was rejected: " + error);
        }
        // Equality is structural: object members are sorted, and absent optional fields are
        // omitted on the way out just as they were absent on the way in.
        check_equal(output, input, entry.file + " changed while round tripping through C++");
    }
}

FIVEPROTECT_TEST(invalid_fixtures_are_rejected) {
    for (const Entry& entry : entries_from_index("invalid")) {
        const auto handler = handlers().find(entry.schema);
        if (handler == handlers().end()) continue;

        const json::Value input = read_fixture(entry.file);
        json::Value output;
        std::string error;
        check(!handler->second(input, output, error), entry.file + " should have been rejected");
        check(!error.empty(), entry.file + " must explain the rejection");
    }
}

FIVEPROTECT_TEST(every_message_the_engine_touches_has_a_handler) {
    // Guards against a new message being added to the schemas without anyone teaching the
    // C++ side about it.
    for (const char* required : {"SystemSnapshot", "AttestationRequest", "LocalAttestCommand"}) {
        check(handlers().count(required) == 1, std::string("no handler for ") + required);
    }
}

FIVEPROTECT_TEST(rejects_a_snapshot_carrying_a_judgement) {
    // ADR 0004 in executable form.
    json::Value snapshot = read_fixture("valid/system-snapshot-full.json");
    snapshot.set("clean", json::Value(true));

    protocol::SystemSnapshot parsed{};
    std::string error;
    check(!protocol::SystemSnapshot::from_json(snapshot, parsed, &error),
          "a companion never sends a judgement");
    check(error.find("clean") != std::string::npos, "the error names the offending field");
}

FIVEPROTECT_TEST(optional_fields_are_omitted_rather_than_nulled) {
    protocol::SystemSnapshot snapshot{};
    snapshot.schemaVersion = protocol::PROTOCOL_VERSION;
    snapshot.collectedAt = "2026-08-04T14:22:31.412Z";
    snapshot.companionVersion = "0.1.0";
    snapshot.companionBuildHash = std::string(64, 'a');
    snapshot.osBuild = "10.0.26100";
    snapshot.tpm.present = false;

    const json::Value encoded = snapshot.to_json();
    check(encoded.find("gameProcess") == nullptr, "absent optional is not serialized");
    check(encoded.find("features") != nullptr, "required struct is serialized");
}

FIVEPROTECT_TEST(enum_names_survive_a_round_trip) {
    for (const auto state : {protocol::FeatureState::Enabled, protocol::FeatureState::Disabled,
                             protocol::FeatureState::Unknown}) {
        protocol::FeatureState parsed{};
        check(protocol::from_wire(protocol::to_wire(state), parsed), "wire name is recognised");
        check(parsed == state, "same variant comes back");
    }
    protocol::FeatureState ignored{};
    check(!protocol::from_wire("probably", ignored), "unknown wire names are refused");
}

FIVEPROTECT_TEST(constraints_are_enforced_not_just_types) {
    json::Value response = read_fixture("valid/nonce-response.json");
    response.set("nonce", json::Value(std::string("abcd")));

    protocol::NonceResponse parsed{};
    std::string error;
    check(!protocol::NonceResponse::from_json(response, parsed, &error), "short nonce is refused");
    check(error.find("shorter than 64") != std::string::npos, "the error names the constraint");
}

int main() {
    std::cout << "\nfiveprotect_protocol contract\n";
    return fiveprotect::testing::run_all();
}
