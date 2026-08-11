// FiveProtect scan engine — the phase 1 probe surface.
//
// Every probe here is read-only and uses documented Win32 or NT APIs. Nothing is injected,
// nothing is hooked, nothing is written. That is a design constraint, not an accident:
// injecting into the FiveM process is out of scope (design document 3), and staying
// read-only rules out a class of bugs that would otherwise show up as crashes on a paying
// customer's player's machine.
//
// The engine knows nothing about the backend or the network. Its input is the system, its
// output is a SystemSnapshot, and it is testable with neither (design document 4.3).

#ifndef FIVEPROTECT_PROBES_HPP
#define FIVEPROTECT_PROBES_HPP

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "fiveprotect_protocol.hpp"

namespace fiveprotect::scan {

using protocol::FeatureState;
using protocol::GameProcessEvidence;
using protocol::SecurityFeatures;
using protocol::SystemSnapshot;
using protocol::TpmInfo;

/// Notes a probe leaves behind. Stable identifiers rather than free text: they travel in
/// the snapshot and the backend matches on them — `hvci_blocked_by:` in particular, which
/// is what puts a driver name on the block screen.
using ProbeNotes = std::vector<std::string>;

struct ProbeResult {
    SecurityFeatures features;
    TpmInfo tpm;
    std::optional<GameProcessEvidence> gameProcess;
    ProbeNotes notes;
};

/// One process the engine found.
struct ProcessInfo {
    std::int64_t pid = 0;
    std::int64_t startedAtUnixMs = 0;
    std::string imageName;
    bool mainWindowPresent = false;
};

/// Where the probes read from.
///
/// Every system access goes through this interface, so probe logic can be driven with a
/// fake. Without it, "HVCI is off because of driver X" would only be testable on a machine
/// where HVCI happens to be off because of driver X.
///
/// `std::optional<bool>` everywhere is deliberate: "could not determine" is a distinct,
/// meaningful answer. Collapsing it into false would deny clean machines; collapsing it
/// into true would admit dirty ones. The backend decides what a gap means.
class SystemSource {
public:
    virtual ~SystemSource() = default;

    virtual std::optional<bool> secure_boot_enabled() const = 0;
    virtual std::optional<bool> test_signing_enabled() const = 0;
    virtual std::optional<bool> kernel_debugger_present() const = 0;
    virtual std::optional<bool> hvci_enabled() const = 0;
    virtual std::optional<bool> vbs_enabled() const = 0;
    virtual std::optional<bool> driver_blocklist_enabled() const = 0;
    virtual std::optional<bool> iommu_enabled() const = 0;

    /// Name of the driver blocking HVCI, when Windows names one.
    virtual std::optional<std::string> hvci_blocking_driver() const = 0;

    virtual TpmInfo tpm_info() const = 0;

    /// Running processes whose image name matches one of `names`. See `matches_process_name`.
    virtual std::vector<ProcessInfo> find_processes(const std::vector<std::string>& names) const = 0;

    /// Windows build string, for example "10.0.26100".
    virtual std::string os_build() const = 0;
};

/// Image names the FiveM client is known to run under.
///
/// A list rather than one name: launcher and game process differ, and Cfx has renamed them
/// before. Matching several is cheap; failing to find the game denies a player who did
/// nothing wrong.
const std::vector<std::string>& fivem_process_names();

/// Bits of `SYSTEM_CODEINTEGRITY_INFORMATION.CodeIntegrityOptions`.
///
/// Spelled out here rather than inline at the call site because a wrong literal in this
/// table is invisible: the query succeeds, the bit is simply read from the wrong place, and
/// the answer is a confident lie. That is exactly what happened with HVCI — `0x200` is
/// `FLIGHTING_ENABLED`, and testing it denied every machine whose memory integrity was
/// correctly switched on, while telling the player to switch it on.
namespace code_integrity {
inline constexpr unsigned long kEnabled = 0x0001;
inline constexpr unsigned long kTestSign = 0x0002;
inline constexpr unsigned long kUmciEnabled = 0x0004;
inline constexpr unsigned long kDebugModeEnabled = 0x0080;
inline constexpr unsigned long kFlightingEnabled = 0x0200;
inline constexpr unsigned long kHvciKmciEnabled = 0x0400;
inline constexpr unsigned long kHvciKmciAuditMode = 0x0800;
inline constexpr unsigned long kHvciKmciStrictMode = 0x1000;
}  // namespace code_integrity

/// Whether Windows test signing is on. Enabled is a failure at every tier.
bool test_signing_from_options(unsigned long options);

/// Whether memory integrity is *running*.
///
/// Running, not configured: Windows shows the setting as "on" as soon as it is toggled, but
/// the kernel only enforces it after a restart. Reading the running state is what makes the
/// difference visible to a player who has toggled it and not yet rebooted.
///
/// Audit mode does not count. It logs what it would have blocked and blocks nothing.
bool hvci_from_options(unsigned long options);

/// Whether a process image name matches one of the patterns above.
///
/// Case-insensitive, with at most one `*` standing for the game build number. A pattern
/// without a `*` is an exact comparison. Deliberately not a general glob — the only variable
/// part of a FiveM image name is the build, and a regex here would be a parser nobody needs.
bool matches_process_name(const std::string& image, const std::string& pattern);

/// Runs every phase 1 probe against `source`.
ProbeResult run_probes(const SystemSource& source);

/// Assembles the snapshot the companion sends.
///
/// Separate from `run_probes` so the assembly — versions, timestamps, payload shape — is
/// testable without any system access at all.
SystemSnapshot build_snapshot(const ProbeResult& result,
                              const std::string& companionVersion,
                              const std::string& companionBuildHash,
                              const std::string& osBuild,
                              const std::string& collectedAtIso);

/// Maps "could not determine / yes / no" to the tri-state the protocol uses.
FeatureState state_from(const std::optional<bool>& value);

}  // namespace fiveprotect::scan

#endif  // FIVEPROTECT_PROBES_HPP
