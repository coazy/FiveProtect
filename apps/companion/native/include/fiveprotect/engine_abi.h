/*
 * C ABI for the scan engine.
 *
 * The companion shell is Rust. A C ABI is the seam between them: no C++ name mangling, no
 * exceptions crossing the boundary, no ownership questions — the caller supplies the buffer
 * and the engine fills it.
 *
 * The engine returns JSON rather than a struct. The protocol already defines that shape in
 * all four languages, so JSON keeps one contract instead of adding a second, hand-written
 * one at the FFI boundary.
 */

#ifndef FIVEPROTECT_ENGINE_ABI_H
#define FIVEPROTECT_ENGINE_ABI_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Return codes. Negative values are failures. */
#define FIVEPROTECT_OK 0
#define FIVEPROTECT_ERR_BUFFER_TOO_SMALL (-1)
#define FIVEPROTECT_ERR_INVALID_ARGUMENT (-2)
#define FIVEPROTECT_ERR_INTERNAL (-3)

/*
 * Runs every probe and writes a SystemSnapshot as UTF-8 JSON into `buffer`.
 *
 * `companion_version`, `companion_build_hash` and `collected_at_iso` come from the caller:
 * the engine does not know its own build hash, and it must not invent a timestamp the shell
 * would then disagree with.
 *
 * On success returns FIVEPROTECT_OK and sets `*written` to the number of bytes, excluding the
 * terminating NUL. On FIVEPROTECT_ERR_BUFFER_TOO_SMALL, `*written` holds the required size.
 *
 * Never throws. A probe that fails becomes a note in the snapshot, not an error here — the
 * engine's job is to report what it found, including that it found nothing.
 */
int fiveprotect_scan_snapshot_json(const char* companion_version,
                               const char* companion_build_hash,
                               const char* collected_at_iso,
                               char* buffer,
                               size_t buffer_size,
                               size_t* written);

/* Engine version, for the shell to log and for build pinning to compare. */
const char* fiveprotect_engine_version(void);

#ifdef __cplusplus
}
#endif

#endif /* FIVEPROTECT_ENGINE_ABI_H */
