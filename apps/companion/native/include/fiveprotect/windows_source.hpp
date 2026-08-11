// The real SystemSource, backed by Windows.
//
// Declared unconditionally so a non-Windows build still compiles the header; the
// definitions in windows_source.cpp are guarded.

#ifndef FIVEPROTECT_WINDOWS_SOURCE_HPP
#define FIVEPROTECT_WINDOWS_SOURCE_HPP

#include "fiveprotect/probes.hpp"

namespace fiveprotect::scan {

/// Reads the live system. Every method is read-only.
class WindowsSystemSource final : public SystemSource {
public:
    std::optional<bool> secure_boot_enabled() const override;
    std::optional<bool> test_signing_enabled() const override;
    std::optional<bool> kernel_debugger_present() const override;
    std::optional<bool> hvci_enabled() const override;
    std::optional<bool> vbs_enabled() const override;
    std::optional<bool> driver_blocklist_enabled() const override;
    std::optional<bool> iommu_enabled() const override;
    std::optional<std::string> hvci_blocking_driver() const override;
    TpmInfo tpm_info() const override;
    std::vector<ProcessInfo> find_processes(const std::vector<std::string>& names) const override;
    std::string os_build() const override;
};

}  // namespace fiveprotect::scan

#endif  // FIVEPROTECT_WINDOWS_SOURCE_HPP
