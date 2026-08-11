#include "fiveprotect/engine_abi.h"

#include <cstring>
#include <string>

#include "fiveprotect/probes.hpp"

#ifdef _WIN32
#include "fiveprotect/windows_source.hpp"
#endif

namespace {

/// Version of the engine itself, independent of the companion release version.
constexpr const char* kEngineVersion = "0.1.0";

#ifndef _WIN32
/// Stand-in for non-Windows builds.
///
/// The engine only ships on Windows, but the probe logic is platform independent and worth
/// compiling everywhere. Every reading is "could not determine", which is the honest answer
/// for a platform where the question does not apply — and it exercises the path where the
/// backend has to deal with a snapshot full of gaps.
class UnavailableSource final : public fiveprotect::scan::SystemSource {
public:
    std::optional<bool> secure_boot_enabled() const override { return std::nullopt; }
    std::optional<bool> test_signing_enabled() const override { return std::nullopt; }
    std::optional<bool> kernel_debugger_present() const override { return std::nullopt; }
    std::optional<bool> hvci_enabled() const override { return std::nullopt; }
    std::optional<bool> vbs_enabled() const override { return std::nullopt; }
    std::optional<bool> driver_blocklist_enabled() const override { return std::nullopt; }
    std::optional<bool> iommu_enabled() const override { return std::nullopt; }
    std::optional<std::string> hvci_blocking_driver() const override { return std::nullopt; }
    fiveprotect::scan::TpmInfo tpm_info() const override { return {}; }
    std::vector<fiveprotect::scan::ProcessInfo> find_processes(
        const std::vector<std::string>&) const override {
        return {};
    }
    std::string os_build() const override { return "unsupported-platform"; }
};
#endif

}  // namespace

extern "C" {

const char* fiveprotect_engine_version(void) { return kEngineVersion; }

int fiveprotect_scan_snapshot_json(const char* companion_version,
                               const char* companion_build_hash,
                               const char* collected_at_iso,
                               char* buffer,
                               size_t buffer_size,
                               size_t* written) {
    if (companion_version == nullptr || companion_build_hash == nullptr
        || collected_at_iso == nullptr || written == nullptr) {
        return FIVEPROTECT_ERR_INVALID_ARGUMENT;
    }

    // Nothing may cross the ABI boundary as an exception. A probe that fails is a note in
    // the snapshot; anything else that throws becomes an internal error here.
    try {
#ifdef _WIN32
        const fiveprotect::scan::WindowsSystemSource source;
#else
        const UnavailableSource source;
#endif
        const fiveprotect::scan::ProbeResult result = fiveprotect::scan::run_probes(source);
        const fiveprotect::scan::SystemSnapshot snapshot =
            fiveprotect::scan::build_snapshot(result, companion_version, companion_build_hash,
                                          source.os_build(), collected_at_iso);

        const std::string json = fiveprotect::json::serialize(snapshot.to_json());
        *written = json.size();

        if (buffer == nullptr || buffer_size < json.size() + 1) {
            return FIVEPROTECT_ERR_BUFFER_TOO_SMALL;
        }

        std::memcpy(buffer, json.data(), json.size());
        buffer[json.size()] = '\0';
        return FIVEPROTECT_OK;
    } catch (...) {
        return FIVEPROTECT_ERR_INTERNAL;
    }
}

}  // extern "C"
