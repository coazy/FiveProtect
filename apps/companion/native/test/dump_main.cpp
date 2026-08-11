// Prints the snapshot this machine would send.
//
// A developer and support tool, not part of the shipped companion. It is the fastest way to
// answer "what does FiveProtect actually see on this PC" without a server, a backend or a
// player waiting in a deferral — and it is the basis for the diagnostic export the block
// screen offers (design document 12.2).

#include "fiveprotect/engine_abi.h"

#include <cstdio>
#include <string>
#include <vector>

int main() {
    const std::string buildHash(64, 'a');  // a real build hash is computed by the shell
    const char* const collectedAt = "1970-01-01T00:00:00.000Z";

    std::size_t needed = 0;
    fiveprotect_scan_snapshot_json("0.0.0-dump", buildHash.c_str(), collectedAt, nullptr, 0, &needed);

    std::vector<char> buffer(needed + 1);
    std::size_t written = 0;
    const int status = fiveprotect_scan_snapshot_json("0.0.0-dump", buildHash.c_str(), collectedAt,
                                                  buffer.data(), buffer.size(), &written);
    if (status != FIVEPROTECT_OK) {
        std::fprintf(stderr, "scan failed with %d\n", status);
        return 1;
    }

    std::fwrite(buffer.data(), 1, written, stdout);
    std::fputc('\n', stdout);
    return 0;
}
