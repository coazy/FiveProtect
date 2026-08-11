#include "fiveprotect/probes.hpp"

#include <algorithm>
#include <cctype>

namespace fiveprotect::scan {
namespace {

bool equals_ignore_case(const std::string& left, const std::string& right) {
    if (left.size() != right.size()) return false;
    return std::equal(left.begin(), left.end(), right.begin(), [](char a, char b) {
        return std::tolower(static_cast<unsigned char>(a))
            == std::tolower(static_cast<unsigned char>(b));
    });
}

}  // namespace

const std::vector<std::string>& fivem_process_names() {
    static const std::vector<std::string> names = {
        // The game process carries the game build in its name: FiveM_b3258_GTAProcess.exe,
        // and a new one appears whenever Rockstar ships an update. Listing them by hand was
        // a denial waiting to happen — every player who moved to a build newer than this
        // file would have failed `game_process_present` while doing nothing wrong.
        "FiveM_*GTAProcess.exe",
        "FiveM.exe",
        "CitizenFX.exe",
    };
    return names;
}

bool test_signing_from_options(unsigned long options) {
    return (options & code_integrity::kTestSign) != 0;
}

bool hvci_from_options(unsigned long options) {
    // Audit mode deliberately excluded: it reports what it would have blocked and blocks
    // nothing, so a machine in audit mode is a machine without memory integrity.
    if ((options & code_integrity::kHvciKmciAuditMode) != 0
        && (options & code_integrity::kHvciKmciEnabled) == 0) {
        return false;
    }
    return (options & code_integrity::kHvciKmciEnabled) != 0;
}

bool matches_process_name(const std::string& image, const std::string& pattern) {
    const std::size_t star = pattern.find('*');
    if (star == std::string::npos) return equals_ignore_case(image, pattern);

    const std::string prefix = pattern.substr(0, star);
    const std::string suffix = pattern.substr(star + 1);

    // A pattern is only ever `prefix*suffix`, and the two must not overlap — otherwise
    // "FiveM_.exe" would match "FiveM_*GTAProcess.exe" on a four-character name.
    if (image.size() < prefix.size() + suffix.size()) return false;

    return equals_ignore_case(image.substr(0, prefix.size()), prefix)
        && equals_ignore_case(image.substr(image.size() - suffix.size()), suffix);
}

FeatureState state_from(const std::optional<bool>& value) {
    if (!value.has_value()) return FeatureState::Unknown;
    return *value ? FeatureState::Enabled : FeatureState::Disabled;
}

ProbeResult run_probes(const SystemSource& source) {
    ProbeResult result;

    result.features.secureBoot = state_from(source.secure_boot_enabled());
    result.features.testSigning = state_from(source.test_signing_enabled());
    result.features.kernelDebugging = state_from(source.kernel_debugger_present());
    result.features.hvci = state_from(source.hvci_enabled());
    result.features.virtualizationBasedSecurity = state_from(source.vbs_enabled());
    result.features.driverBlocklist = state_from(source.driver_blocklist_enabled());
    result.features.iommu = state_from(source.iommu_enabled());

    // Design document 7.4: Windows switches memory integrity off by itself when an
    // incompatible driver is installed, and those players never cheated. Carrying the
    // driver name to the block screen is the difference between a support ticket and none.
    if (result.features.hvci == FeatureState::Disabled) {
        if (const auto driver = source.hvci_blocking_driver(); driver.has_value() && !driver->empty()) {
            result.notes.push_back("hvci_blocked_by:" + *driver);
        }
    }

    // A probe that could not answer says so. The backend treats a gap in the evidence as a
    // denial at a blocking tier, which is only defensible if the gap is visible.
    if (result.features.hvci == FeatureState::Unknown) result.notes.push_back("hvci_probe_unavailable");
    if (result.features.driverBlocklist == FeatureState::Unknown) {
        result.notes.push_back("driver_blocklist_registry_missing");
    }
    if (result.features.iommu == FeatureState::Unknown) result.notes.push_back("iommu_probe_unavailable");
    if (result.features.secureBoot == FeatureState::Unknown) {
        result.notes.push_back("secure_boot_probe_unavailable");
    }

    result.tpm = source.tpm_info();

    const std::vector<ProcessInfo> processes = source.find_processes(fivem_process_names());
    if (processes.empty()) {
        result.notes.push_back("game_process_not_found");
    } else {
        // The oldest match: a launcher spawns the game, and the game is the process whose
        // lifetime should match the session.
        const ProcessInfo* oldest = &processes.front();
        for (const ProcessInfo& candidate : processes) {
            if (candidate.startedAtUnixMs < oldest->startedAtUnixMs) oldest = &candidate;
        }
        GameProcessEvidence evidence;
        evidence.pid = oldest->pid;
        evidence.startedAtUnixMs = oldest->startedAtUnixMs;
        evidence.imageName = oldest->imageName;
        evidence.mainWindowPresent = oldest->mainWindowPresent;
        result.gameProcess = evidence;
    }

    return result;
}

SystemSnapshot build_snapshot(const ProbeResult& result,
                              const std::string& companionVersion,
                              const std::string& companionBuildHash,
                              const std::string& osBuild,
                              const std::string& collectedAtIso) {
    SystemSnapshot snapshot;
    snapshot.schemaVersion = protocol::PROTOCOL_VERSION;
    snapshot.collectedAt = collectedAtIso;
    snapshot.companionVersion = companionVersion;
    snapshot.companionBuildHash = companionBuildHash;
    snapshot.osBuild = osBuild;
    snapshot.features = result.features;
    snapshot.tpm = result.tpm;
    snapshot.gameProcess = result.gameProcess;
    snapshot.probeErrors = result.notes;
    // There is deliberately no field here to say the machine is fine. The companion reports
    // facts; the backend judges (ADR 0004).
    return snapshot;
}

}  // namespace fiveprotect::scan
