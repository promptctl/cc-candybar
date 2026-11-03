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
  // A pipe that outlived its launch, held by a process that left the group:
  // opened when the launch settles, closed when the pipe does — after `bytes`
  // read and dropped after the launch, and how it ended: on its own, cut by
  // the launcher at the bound, or on a read error.
  onDrainOpen(category: LaunchCategory): void;
  onDrainClose(category: LaunchCategory, bytes: number, end: DrainEnd): void;
}

export type DrainEnd = "closed" | "cut" | "errored";
