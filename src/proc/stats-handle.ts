// [LAW:locality-or-seam] The seam between `launch.ts` and `RuntimeStats`.
// `launch.ts` cannot import `RuntimeStats` directly — that would couple every
// caller's runtime (Node fallback, install path) to the daemon's stats object.
// Instead, the daemon constructs a stats object that implements this
// interface and hands it to `createLauncher()`. Other runtimes pass none; the
// launcher no-ops.

import type { LaunchCategory } from "./launch";

export interface LaunchStatsHandle {
  onStart(category: LaunchCategory): void;
  onEnd(category: LaunchCategory, durationMs: number): void;
  // A launch the launcher refused: no child started, so neither of the above.
  onRefused(category: LaunchCategory): void;
}
