// Probe logic against a scripted system.
//
// The point of the SystemSource interface is right here: "HVCI is off because of driver X"
// is otherwise only testable on a machine where HVCI happens to be off because of driver X.
// Every scenario below is one a customer will eventually hit.

#include "fiveprotect/probes.hpp"
#include "testing.hpp"

#include <optional>
#include <string>
#include <vector>

namespace scan = fiveprotect::scan;
using fiveprotect::testing::check;
using fiveprotect::testing::check_equal;
using scan::FeatureState;

namespace {

/// A system that answers exactly what a test tells it to.
class FakeSource final : public scan::SystemSource {
public:
    std::optional<bool> secureBoot = true;
    std::optional<bool> testSigning = false;
    std::optional<bool> kernelDebugger = false;
    std::optional<bool> hvci = true;
    std::optional<bool> vbs = true;
    std::optional<bool> blocklist = true;
    std::optional<bool> iommu = true;
    std::optional<std::string> blockingDriver;
    scan::TpmInfo tpm;
    std::vector<scan::ProcessInfo> processes;
    std::string build = "10.0.26100";

    FakeSource() {
        tpm.present = true;
        tpm.manufacturer = "IFX";
        tpm.specVersion = "2.0";
        processes.push_back(
            scan::ProcessInfo{4242, 1786000951000, "FiveM_GTAProcess.exe", true});
    }

    std::optional<bool> secure_boot_enabled() const override { return secureBoot; }
    std::optional<bool> test_signing_enabled() const override { return testSigning; }
    std::optional<bool> kernel_debugger_present() const override { return kernelDebugger; }
    std::optional<bool> hvci_enabled() const override { return hvci; }
    std::optional<bool> vbs_enabled() const override { return vbs; }
    std::optional<bool> driver_blocklist_enabled() const override { return blocklist; }
    std::optional<bool> iommu_enabled() const override { return iommu; }
    std::optional<std::string> hvci_blocking_driver() const override { return blockingDriver; }
    scan::TpmInfo tpm_info() const override { return tpm; }
    std::vector<scan::ProcessInfo> find_processes(const std::vector<std::string>&) const override {
        return processes;
    }
    std::string os_build() const override { return build; }
};

bool has_note(const scan::ProbeNotes& notes, const std::string& prefix) {
    for (const std::string& note : notes) {
        if (note.rfind(prefix, 0) == 0) return true;
    }
    return false;
}

}  // namespace

FIVEPROTECT_TEST(a_healthy_machine_reports_everything_enabled) {
    const FakeSource source;
    const scan::ProbeResult result = scan::run_probes(source);

    check(result.features.secureBoot == FeatureState::Enabled, "secure boot");
    check(result.features.hvci == FeatureState::Enabled, "hvci");
    check(result.features.testSigning == FeatureState::Disabled, "test signing");
    check(result.features.kernelDebugging == FeatureState::Disabled, "kernel debugging");
    check(result.features.driverBlocklist == FeatureState::Enabled, "driver blocklist");
    check(result.features.iommu == FeatureState::Enabled, "iommu");
    check(result.tpm.present, "tpm present");
    check(result.gameProcess.has_value(), "game process found");
    check(result.notes.empty(), "a healthy machine leaves no notes");
}

FIVEPROTECT_TEST(a_probe_that_cannot_answer_reports_unknown_not_disabled) {
    // Collapsing "could not determine" into "disabled" would deny clean machines whose WMI
    // is slow or whose firmware does not expose Secure Boot at all.
    FakeSource source;
    source.secureBoot = std::nullopt;
    source.hvci = std::nullopt;

    const scan::ProbeResult result = scan::run_probes(source);
    check(result.features.secureBoot == FeatureState::Unknown, "secure boot is unknown");
    check(result.features.hvci == FeatureState::Unknown, "hvci is unknown");
    check(has_note(result.notes, "secure_boot_probe_unavailable"), "the gap is recorded");
    check(has_note(result.notes, "hvci_probe_unavailable"), "the gap is recorded");
}

FIVEPROTECT_TEST(a_disabled_hvci_names_the_driver_that_blocked_it) {
    // Design document 7.4. Naming the driver is the difference between a support ticket and
    // none, and the note prefix is what the backend matches on.
    FakeSource source;
    source.hvci = false;
    source.blockingDriver = "rtcore64.sys";

    const scan::ProbeResult result = scan::run_probes(source);
    check(result.features.hvci == FeatureState::Disabled, "hvci is off");
    check(has_note(result.notes, "hvci_blocked_by:rtcore64.sys"), "the driver is named");
}

FIVEPROTECT_TEST(a_disabled_hvci_without_a_named_driver_says_nothing_invented) {
    FakeSource source;
    source.hvci = false;
    source.blockingDriver = std::nullopt;

    const scan::ProbeResult result = scan::run_probes(source);
    check(!has_note(result.notes, "hvci_blocked_by:"), "no driver is invented");
}

FIVEPROTECT_TEST(an_empty_driver_name_is_not_reported_as_a_driver) {
    FakeSource source;
    source.hvci = false;
    source.blockingDriver = std::string();

    const scan::ProbeResult result = scan::run_probes(source);
    check(!has_note(result.notes, "hvci_blocked_by:"), "an empty name is not a name");
}

FIVEPROTECT_TEST(an_enabled_hvci_never_carries_a_blocking_driver) {
    FakeSource source;
    source.hvci = true;
    source.blockingDriver = "stale.sys";  // left over from before it was enabled

    const scan::ProbeResult result = scan::run_probes(source);
    check(!has_note(result.notes, "hvci_blocked_by:"), "a stale value must not surface");
}

FIVEPROTECT_TEST(no_game_process_is_reported_rather_than_faked) {
    FakeSource source;
    source.processes.clear();

    const scan::ProbeResult result = scan::run_probes(source);
    check(!result.gameProcess.has_value(), "no evidence is produced");
    check(has_note(result.notes, "game_process_not_found"), "the absence is recorded");
}

FIVEPROTECT_TEST(the_oldest_matching_process_wins) {
    // A launcher spawns the game. The game is the process whose lifetime should match the
    // session, and it is the older of the two.
    FakeSource source;
    source.processes = {
        scan::ProcessInfo{2000, 1786000999000, "FiveM.exe", false},
        scan::ProcessInfo{1000, 1786000951000, "FiveM_GTAProcess.exe", true},
    };

    const scan::ProbeResult result = scan::run_probes(source);
    check(result.gameProcess.has_value(), "a process was chosen");
    check_equal(result.gameProcess->pid, 1000, "the older process was chosen");
}

FIVEPROTECT_TEST(the_known_process_names_cover_the_launcher_and_the_game) {
    const std::vector<std::string>& names = scan::fivem_process_names();
    check(names.size() >= 2, "more than one name is matched");

    bool hasGame = false;
    for (const std::string& name : names) {
        if (name.find("GTAProcess") != std::string::npos) hasGame = true;
    }
    check(hasGame, "the game process name is covered");
}

FIVEPROTECT_TEST(memory_integrity_is_read_from_the_bit_windows_actually_sets) {
    // 0xF401 is what a Windows 11 machine with memory integrity switched on and running
    // reports: ENABLED | HVCI_KMCI | HVCI_STRICTMODE | HVCI_IUM | WHQL | WHQL_AUDIT.
    //
    // This test exists because the constant was wrong. `0x200` is FLIGHTING_ENABLED, not
    // HVCI, so the probe reported "memory integrity off" on a machine where it was on — and
    // the block screen told the player to switch on the thing they had already switched on.
    // At the standard tier that denies everyone who did the right thing.
    check(scan::hvci_from_options(0xF401), "a real machine with memory integrity running");
    check(scan::hvci_from_options(scan::code_integrity::kHvciKmciEnabled), "the bit alone");

    check(!scan::hvci_from_options(0x0001), "code integrity on, no HVCI");
    check(!scan::hvci_from_options(scan::code_integrity::kFlightingEnabled),
          "flighting is not memory integrity");
    check(!scan::hvci_from_options(0), "nothing set");
}

FIVEPROTECT_TEST(memory_integrity_in_audit_mode_does_not_count_as_on) {
    // Audit mode logs what it would have blocked and blocks nothing. Counting it would give
    // a machine credit for a protection that is not protecting anything.
    check(!scan::hvci_from_options(scan::code_integrity::kHvciKmciAuditMode | 0x0001),
          "audit mode alone");
    check(scan::hvci_from_options(scan::code_integrity::kHvciKmciAuditMode
                                  | scan::code_integrity::kHvciKmciEnabled),
          "audit mode alongside real enforcement still counts as on");
}

FIVEPROTECT_TEST(test_signing_is_read_from_its_own_bit) {
    check(scan::test_signing_from_options(scan::code_integrity::kTestSign), "the bit alone");
    check(scan::test_signing_from_options(0x0003), "alongside code integrity");
    check(!scan::test_signing_from_options(0xF401), "a clean machine");
    check(!scan::test_signing_from_options(0), "nothing set");
}

FIVEPROTECT_TEST(the_code_integrity_bits_are_the_documented_values) {
    // The whole class of bug above is a wrong literal. Naming the expected values here means
    // a typo in the table fails a test instead of silently reading the wrong flag.
    check_equal(static_cast<int>(scan::code_integrity::kEnabled), 0x0001, "ENABLED");
    check_equal(static_cast<int>(scan::code_integrity::kTestSign), 0x0002, "TESTSIGN");
    check_equal(static_cast<int>(scan::code_integrity::kUmciEnabled), 0x0004, "UMCI");
    check_equal(static_cast<int>(scan::code_integrity::kDebugModeEnabled), 0x0080, "DEBUGMODE");
    check_equal(static_cast<int>(scan::code_integrity::kFlightingEnabled), 0x0200, "FLIGHTING");
    check_equal(static_cast<int>(scan::code_integrity::kHvciKmciEnabled), 0x0400, "HVCI_KMCI");
    check_equal(static_cast<int>(scan::code_integrity::kHvciKmciAuditMode), 0x0800, "HVCI_AUDIT");
    check_equal(static_cast<int>(scan::code_integrity::kHvciKmciStrictMode), 0x1000, "HVCI_STRICT");
}

/// Whether any known pattern accepts this image name.
static bool any_pattern_matches(const std::string& image) {
    for (const std::string& pattern : scan::fivem_process_names()) {
        if (scan::matches_process_name(image, pattern)) return true;
    }
    return false;
}

FIVEPROTECT_TEST(a_game_build_nobody_has_seen_yet_is_still_recognised) {
    // The reason the patterns exist. FiveM puts the game build in the image name and a new
    // one appears with every Rockstar update; a list of literal names would deny every
    // player who updated before this file did.
    check(any_pattern_matches("FiveM_b3258_GTAProcess.exe"), "current build");
    check(any_pattern_matches("FiveM_b9999_GTAProcess.exe"), "a build from the future");
    check(any_pattern_matches("FiveM_GTAProcess.exe"), "the unnumbered game process");
    check(any_pattern_matches("fivem_b3258_gtaprocess.exe"), "lower case");
    check(any_pattern_matches("FiveM.exe"), "the launcher");
}

FIVEPROTECT_TEST(the_pattern_does_not_accept_a_lookalike) {
    // A wildcard that matched too much would let any process called FiveM-something stand
    // in for the game, and `game_process_present` is a blocking requirement at every tier.
    check(!any_pattern_matches("FiveM_GTAProcess.exe.txt"), "wrong extension");
    check(!any_pattern_matches("NotFiveM_b1_GTAProcess.exe"), "wrong prefix");
    check(!any_pattern_matches("FiveM_b1_GTAProcess.exe.mal"), "trailing junk");
    check(!any_pattern_matches("GTAProcess.exe"), "suffix alone");
    check(!any_pattern_matches("FiveMGTAProcess.ex"), "truncated suffix");
}

FIVEPROTECT_TEST(a_pattern_without_a_star_is_an_exact_comparison) {
    check(scan::matches_process_name("FiveM.exe", "FiveM.exe"), "identical");
    check(scan::matches_process_name("FIVEM.EXE", "FiveM.exe"), "case does not matter");
    check(!scan::matches_process_name("FiveM.exe.bak", "FiveM.exe"), "no implicit prefix match");
}

FIVEPROTECT_TEST(prefix_and_suffix_may_not_overlap) {
    // Without the length check, "FiveM_GTAProcess.exe" would satisfy a pattern whose prefix
    // and suffix together are longer than the name, by matching the same characters twice.
    check(!scan::matches_process_name("FiveM_.exe", "FiveM_*GTAProcess.exe"), "too short");
    check(scan::matches_process_name("FiveM_GTAProcess.exe", "FiveM_*GTAProcess.exe"),
          "exactly long enough with an empty wildcard");
}

FIVEPROTECT_TEST(the_snapshot_carries_no_verdict_field) {
    // ADR 0004 at the point where the payload is built. There is no field to set, and this
    // test is what fails if somebody adds one.
    const FakeSource source;
    const scan::ProbeResult result = scan::run_probes(source);
    const scan::SystemSnapshot snapshot =
        scan::build_snapshot(result, "0.1.0", std::string(64, 'a'), "10.0.26100",
                             "2026-08-04T14:22:31.412Z");

    const std::string json = fiveprotect::json::serialize(snapshot.to_json());
    for (const char* forbidden : {"\"clean\"", "\"passed\"", "\"verdict\"", "\"trusted\""}) {
        check(json.find(forbidden) == std::string::npos,
              std::string("the snapshot must not carry ") + forbidden);
    }
}

FIVEPROTECT_TEST(the_snapshot_matches_the_protocol_it_was_built_against) {
    const FakeSource source;
    const scan::ProbeResult result = scan::run_probes(source);
    const scan::SystemSnapshot snapshot =
        scan::build_snapshot(result, "0.1.0", std::string(64, 'a'), "10.0.26100",
                             "2026-08-04T14:22:31.412Z");

    check_equal(snapshot.schemaVersion, fiveprotect::protocol::PROTOCOL_VERSION, "schema version");

    // Round trip through the generated parser: whatever the engine produces has to be
    // something the backend would accept.
    std::string error;
    const auto parsed = fiveprotect::json::parse(fiveprotect::json::serialize(snapshot.to_json()), &error);
    check(parsed.has_value(), "the snapshot is valid JSON: " + error);

    fiveprotect::protocol::SystemSnapshot decoded{};
    check(fiveprotect::protocol::SystemSnapshot::from_json(*parsed, decoded, &error),
          "the snapshot satisfies its own schema: " + error);
    check_equal(decoded.companionBuildHash, std::string(64, 'a'), "build hash survives");
}

FIVEPROTECT_TEST(state_mapping_keeps_three_states_apart) {
    check(scan::state_from(true) == FeatureState::Enabled, "true");
    check(scan::state_from(false) == FeatureState::Disabled, "false");
    check(scan::state_from(std::nullopt) == FeatureState::Unknown, "nullopt");
}

int main() {
    std::cout << "\nfiveprotect scan probes\n";
    return fiveprotect::testing::run_all();
}
