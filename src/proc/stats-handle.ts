// [LAW:locality-or-seam] The seam between `launch.ts` and `RuntimeStats`.
// `launch.ts` cannot import `RuntimeStats` directly — that would couple every
// caller's runtime (Node fallback, install path) to the daemon's stats object.
// Instead, the daemon constructs a stats object that implements this
// interface and hands it to `setLaunchStats()` at startup. Other runtimes
// pass null; the launcher no-ops.

import type { LaunchCategory } from "./launch";

export interface LaunchStatsHandle {
  onStart(category: LaunchCategory): void;
  onEnd(category: LaunchCategory, durationMs: number): void;
}
