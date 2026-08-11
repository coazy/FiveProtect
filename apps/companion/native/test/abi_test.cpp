// The C ABI the Rust shell calls.
//
// The boundary is where a mistake is expensive: a buffer overrun or an exception crossing
// into Rust would be a crash on a player's machine during a connect. These tests run the
// real engine against the real system, so they assert on the contract rather than on the
// readings — what those are depends on the machine the test runs on.

#include "fiveprotect/engine_abi.h"
#include "fiveprotect_json.hpp"
#include "fiveprotect_protocol.hpp"
#include "testing.hpp"

#include <string>
#include <vector>

using fiveprotect::testing::check;
using fiveprotect::testing::check_equal;

namespace {

const char* const kVersion = "0.1.0";
const std::string kBuildHash(64, 'a');
const char* const kCollectedAt = "2026-08-04T14:22:31.412Z";

}  // namespace

FIVEPROTECT_TEST(reports_the_required_size_when_the_buffer_is_too_small) {
    std::size_t needed = 0;
    const int status = fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt,
                                                  nullptr, 0, &needed);
    check_equal(status, FIVEPROTECT_ERR_BUFFER_TOO_SMALL, "too small is reported");
    check(needed > 0, "the required size is reported");
}

FIVEPROTECT_TEST(fills_a_buffer_of_exactly_the_required_size) {
    std::size_t needed = 0;
    fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt, nullptr, 0, &needed);

    // One extra byte for the terminator, and not one more: an off-by-one here is the kind
    // of bug that only shows up on someone else's machine.
    std::vector<char> buffer(needed + 1, '\xCC');
    std::size_t written = 0;
    const int status = fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt,
                                                  buffer.data(), buffer.size(), &written);

    check_equal(status, FIVEPROTECT_OK, "the call succeeds");
    check_equal(written, needed, "the reported size was right");
    check_equal(buffer[written], '\0', "the result is NUL terminated");
}

FIVEPROTECT_TEST(refuses_a_buffer_one_byte_short) {
    std::size_t needed = 0;
    fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt, nullptr, 0, &needed);

    std::vector<char> buffer(needed, '\xCC');  // no room for the terminator
    std::size_t written = 0;
    const int status = fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt,
                                                  buffer.data(), buffer.size(), &written);
    check_equal(status, FIVEPROTECT_ERR_BUFFER_TOO_SMALL, "one byte short is still too small");
}

FIVEPROTECT_TEST(rejects_null_arguments_instead_of_dereferencing_them) {
    std::size_t written = 0;
    char buffer[16] = {};

    check_equal(fiveprotect_scan_snapshot_json(nullptr, kBuildHash.c_str(), kCollectedAt, buffer,
                                           sizeof(buffer), &written),
                FIVEPROTECT_ERR_INVALID_ARGUMENT, "null version");
    check_equal(fiveprotect_scan_snapshot_json(kVersion, nullptr, kCollectedAt, buffer,
                                           sizeof(buffer), &written),
                FIVEPROTECT_ERR_INVALID_ARGUMENT, "null build hash");
    check_equal(fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), nullptr, buffer,
                                           sizeof(buffer), &written),
                FIVEPROTECT_ERR_INVALID_ARGUMENT, "null timestamp");
    check_equal(fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt, buffer,
                                           sizeof(buffer), nullptr),
                FIVEPROTECT_ERR_INVALID_ARGUMENT, "null out parameter");
}

FIVEPROTECT_TEST(produces_a_snapshot_the_backend_would_accept) {
    std::size_t needed = 0;
    fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt, nullptr, 0, &needed);

    std::vector<char> buffer(needed + 1);
    std::size_t written = 0;
    check_equal(fiveprotect_scan_snapshot_json(kVersion, kBuildHash.c_str(), kCollectedAt,
                                           buffer.data(), buffer.size(), &written),
                FIVEPROTECT_OK, "the call succeeds");

    std::string error;
    const auto value = fiveprotect::json::parse(std::string(buffer.data(), written), &error);
    check(value.has_value(), "the output is valid JSON: " + error);

    fiveprotect::protocol::SystemSnapshot snapshot{};
    check(fiveprotect::protocol::SystemSnapshot::from_json(*value, snapshot, &error),
          "the output satisfies the schema: " + error);

    check_equal(snapshot.companionVersion, std::string(kVersion), "version is passed through");
    check_equal(snapshot.companionBuildHash, kBuildHash, "build hash is passed through");
    check_equal(snapshot.collectedAt, std::string(kCollectedAt), "timestamp is passed through");
    // The engine does not know its own build hash or the wall clock the shell will report,
    // so both come from the caller. Inventing either would put the two out of step.
}

FIVEPROTECT_TEST(exposes_its_version) {
    const char* version = fiveprotect_engine_version();
    check(version != nullptr && version[0] != '\0', "a version is reported");
}

int main() {
    std::cout << "\nfiveprotect scan abi\n";
    return fiveprotect::testing::run_all();
}
