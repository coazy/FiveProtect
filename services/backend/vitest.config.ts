import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The verdict endpoint holds a request open for up to VERDICT_POLL_TIMEOUT_SECONDS, and
    // the fail-open and fail-closed paths are only reachable by letting it run out. A test
    // budget below that would make the degradation behaviour untestable — which is the part
    // most likely to be wrong when it finally matters.
    testTimeout: 40_000,
    hookTimeout: 30_000,
    // One file at a time: the integration suite truncates shared tables between tests, and
    // parallel files would delete each other's fixtures.
    fileParallelism: false,
  },
});
