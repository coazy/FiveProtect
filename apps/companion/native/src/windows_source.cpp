// Windows implementation of SystemSource.
//
// Read-only throughout: registry queries, NtQuerySystemInformation, a process snapshot and
// the TPM base services API. Nothing is written, nothing is injected, no handle to the game
// process is opened with anything beyond what enumeration needs.
//
// Compiled only on Windows. The probe logic in probes.cpp is platform independent and is
// what the tests exercise, so a Linux CI runner still checks the interesting half.

#ifdef _WIN32

#include "fiveprotect/windows_source.hpp"

// clang-format off
#include <windows.h>
#include <tlhelp32.h>
#include <tbs.h>
// clang-format on

#include <algorithm>
#include <array>
#include <cctype>

namespace fiveprotect::scan {

namespace {

/// Undocumented but stable system information classes. Declared here rather than pulled in
/// from the WDK so the engine builds with the plain Windows SDK.
constexpr ULONG kSystemKernelDebuggerInformation = 35;
constexpr ULONG kSystemCodeIntegrityInformation = 103;

constexpr ULONG kCodeIntegrityOptionEnabled = fiveprotect::scan::code_integrity::kEnabled;

struct SystemCodeIntegrityInformation {
    ULONG Length;
    ULONG CodeIntegrityOptions;
};

struct SystemKernelDebuggerInformation {
    BOOLEAN DebuggerEnabled;
    BOOLEAN DebuggerNotPresent;
};

using NtQuerySystemInformationFn = LONG(WINAPI*)(ULONG, PVOID, ULONG, PULONG);

NtQuerySystemInformationFn nt_query() {
    static NtQuerySystemInformationFn fn = []() -> NtQuerySystemInformationFn {
        const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        if (ntdll == nullptr) return nullptr;
        return reinterpret_cast<NtQuerySystemInformationFn>(
            reinterpret_cast<void*>(GetProcAddress(ntdll, "NtQuerySystemInformation")));
    }();
    return fn;
}

std::optional<ULONG> code_integrity_options() {
    const auto query = nt_query();
    if (query == nullptr) return std::nullopt;

    SystemCodeIntegrityInformation info{};
    info.Length = sizeof(info);
    ULONG returned = 0;
    const LONG status = query(kSystemCodeIntegrityInformation, &info, sizeof(info), &returned);
    if (status < 0) return std::nullopt;
    // A build that does not know the class can report success with nothing set. Treating
    // that as "everything is off" would deny every player on such a build.
    if ((info.CodeIntegrityOptions & kCodeIntegrityOptionEnabled) == 0
        && info.CodeIntegrityOptions == 0) {
        return std::nullopt;
    }
    return info.CodeIntegrityOptions;
}

std::wstring widen(const std::string& text) {
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    std::wstring wide(static_cast<std::size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, wide.data(), size);
    if (!wide.empty() && wide.back() == L'\0') wide.pop_back();
    return wide;
}

std::string narrow(const std::wstring& text) {
    if (text.empty()) return {};
    const int size =
        WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<std::size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, out.data(), size, nullptr, nullptr);
    if (!out.empty() && out.back() == '\0') out.pop_back();
    return out;
}

std::optional<DWORD> registry_dword(const wchar_t* key, const wchar_t* value) {
    DWORD data = 0;
    DWORD size = sizeof(data);
    DWORD type = 0;
    const LSTATUS status = RegGetValueW(HKEY_LOCAL_MACHINE, key, value, RRF_RT_REG_DWORD, &type,
                                        &data, &size);
    if (status != ERROR_SUCCESS) return std::nullopt;
    return data;
}

std::optional<std::string> registry_string(const wchar_t* key, const wchar_t* value) {
    wchar_t buffer[512] = {};
    DWORD size = sizeof(buffer);
    const LSTATUS status =
        RegGetValueW(HKEY_LOCAL_MACHINE, key, value, RRF_RT_REG_SZ, nullptr, buffer, &size);
    if (status != ERROR_SUCCESS) return std::nullopt;
    return narrow(buffer);
}

std::int64_t filetime_to_unix_ms(const FILETIME& time) {
    ULARGE_INTEGER value;
    value.LowPart = time.dwLowDateTime;
    value.HighPart = time.dwHighDateTime;
    // FILETIME counts 100 ns intervals since 1601-01-01; the offset to the Unix epoch is
    // 11644473600 seconds.
    constexpr std::uint64_t kEpochOffset100ns = 116444736000000000ULL;
    if (value.QuadPart < kEpochOffset100ns) return 0;
    return static_cast<std::int64_t>((value.QuadPart - kEpochOffset100ns) / 10000ULL);
}

struct WindowSearch {
    DWORD pid = 0;
    bool found = false;
};

BOOL CALLBACK window_callback(HWND window, LPARAM parameter) {
    auto* search = reinterpret_cast<WindowSearch*>(parameter);
    DWORD owner = 0;
    GetWindowThreadProcessId(window, &owner);
    if (owner == search->pid && IsWindowVisible(window) != 0) {
        search->found = true;
        return FALSE;
    }
    return TRUE;
}

bool has_visible_window(DWORD pid) {
    WindowSearch search{pid, false};
    EnumWindows(window_callback, reinterpret_cast<LPARAM>(&search));
    return search.found;
}

}  // namespace

std::optional<bool> WindowsSystemSource::secure_boot_enabled() const {
    const auto value = registry_dword(LR"(SYSTEM\CurrentControlSet\Control\SecureBoot\State)",
                                      L"UEFISecureBootEnabled");
    if (!value.has_value()) return std::nullopt;
    return *value != 0;
}

std::optional<bool> WindowsSystemSource::test_signing_enabled() const {
    const auto options = code_integrity_options();
    if (!options.has_value()) return std::nullopt;
    return test_signing_from_options(*options);
}

std::optional<bool> WindowsSystemSource::kernel_debugger_present() const {
    const auto query = nt_query();
    if (query == nullptr) return std::nullopt;

    SystemKernelDebuggerInformation info{};
    ULONG returned = 0;
    const LONG status = query(kSystemKernelDebuggerInformation, &info, sizeof(info), &returned);
    if (status < 0) return std::nullopt;
    return info.DebuggerEnabled != 0 && info.DebuggerNotPresent == 0;
}

std::optional<bool> WindowsSystemSource::hvci_enabled() const {
    const auto options = code_integrity_options();
    if (!options.has_value()) return std::nullopt;
    return hvci_from_options(*options);
}

std::optional<bool> WindowsSystemSource::vbs_enabled() const {
    const auto value = registry_dword(LR"(SYSTEM\CurrentControlSet\Control\DeviceGuard)",
                                      L"EnableVirtualizationBasedSecurity");
    if (!value.has_value()) return std::nullopt;
    return *value != 0;
}

std::optional<bool> WindowsSystemSource::driver_blocklist_enabled() const {
    const auto value = registry_dword(LR"(SYSTEM\CurrentControlSet\Control\CI\Config)",
                                      L"VulnerableDriverBlocklistEnable");
    if (!value.has_value()) return std::nullopt;
    return *value != 0;
}

std::optional<bool> WindowsSystemSource::iommu_enabled() const {
    // Kernel DMA protection is exposed as a device guard requirement rather than a state.
    // A value of 1 or 3 requires platform security features including IOMMU.
    const auto value = registry_dword(LR"(SYSTEM\CurrentControlSet\Control\DeviceGuard)",
                                      L"RequirePlatformSecurityFeatures");
    if (!value.has_value()) return std::nullopt;
    return *value == 1 || *value == 3;
}

std::optional<std::string> WindowsSystemSource::hvci_blocking_driver() const {
    // TODO(phase-3): Windows names the incompatible driver in the Code Integrity operational
    // event log (event 3082). Reading an event log is a heavier dependency than phase 1
    // needs, so the registry hint is used where it exists and the block screen falls back to
    // the generic instruction otherwise. Design document 7.4 wants the name, and phase 3
    // will read the log.
    return registry_string(
        LR"(SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity)",
        L"IncompatibleDriver");
}

TpmInfo WindowsSystemSource::tpm_info() const {
    TpmInfo info;
    info.present = false;

    TBS_CONTEXT_PARAMS2 params{};
    params.version = TBS_CONTEXT_VERSION_TWO;
    params.includeTpm20 = 1;

    TBS_HCONTEXT context = nullptr;
    if (Tbsi_Context_Create(reinterpret_cast<PCTBS_CONTEXT_PARAMS>(&params), &context) != TBS_SUCCESS) {
        return info;
    }

    TPM_DEVICE_INFO device{};
    if (Tbsi_GetDeviceInfo(sizeof(device), &device) == TBS_SUCCESS) {
        // Only 2.0 counts. A 1.2 device cannot produce the quotes phase 2 needs, so
        // reporting it as present would set up a denial with a confusing explanation.
        info.present = device.tpmVersion == TPM_VERSION_20;
        if (info.present) {
            info.specVersion = "2.0";
            // TODO(phase-2): the manufacturer is not in TPM_DEVICE_INFO — reading it means
            // submitting a TPM2_GetCapability through Tbsip_Submit_Command. That machinery
            // belongs with the AK handling in phase 2, and phase 1 has no use for the value.
            // Leaving the field empty is better than guessing from the interface type.
            if (device.tpmInterfaceType == TPM_IFTYPE_EMULATOR) {
                // Worth recording: an emulated TPM is not a hardware root of trust. The
                // backend will care about this from phase 2 onwards.
                info.manufacturer = "emulator";
            }
        }
    }

    Tbsip_Context_Close(context);
    // TODO(phase-2): attestationKeyId stays empty until the AK is created and registered.
    return info;
}

std::vector<ProcessInfo> WindowsSystemSource::find_processes(
    const std::vector<std::string>& names) const {
    std::vector<ProcessInfo> found;

    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return found;

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);

    if (Process32FirstW(snapshot, &entry) != 0) {
        do {
            const std::string image = narrow(entry.szExeFile);
            const bool matches = std::any_of(names.begin(), names.end(), [&](const std::string& n) {
                return matches_process_name(image, n);
            });
            if (!matches) continue;

            ProcessInfo info;
            info.pid = static_cast<std::int64_t>(entry.th32ProcessID);
            info.imageName = image;

            // Only the rights needed to read the creation time. Nothing here reads or writes
            // the game's memory — that is out of scope by design (design document 3).
            const HANDLE process =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
            if (process != nullptr) {
                FILETIME created{}, exited{}, kernel{}, user{};
                if (GetProcessTimes(process, &created, &exited, &kernel, &user) != 0) {
                    info.startedAtUnixMs = filetime_to_unix_ms(created);
                }
                CloseHandle(process);
            }

            info.mainWindowPresent = has_visible_window(entry.th32ProcessID);
            found.push_back(info);
        } while (Process32NextW(snapshot, &entry) != 0);
    }

    CloseHandle(snapshot);
    return found;
}

std::string WindowsSystemSource::os_build() const {
    // GetVersionEx lies to unmanifested processes; RtlGetVersion does not.
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) return "unknown";

    const auto rtlGetVersion = reinterpret_cast<RtlGetVersionFn>(
        reinterpret_cast<void*>(GetProcAddress(ntdll, "RtlGetVersion")));
    if (rtlGetVersion == nullptr) return "unknown";

    RTL_OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof(info);
    if (rtlGetVersion(&info) < 0) return "unknown";

    return std::to_string(info.dwMajorVersion) + "." + std::to_string(info.dwMinorVersion) + "."
        + std::to_string(info.dwBuildNumber);
}

}  // namespace fiveprotect::scan

#endif  // _WIN32
