// [LAW:locality-or-seam] Keeps `launch.ts` from importing the daemon's stats object; non-daemon runtimes pass null and the launcher no-ops.

import type { LaunchCategory } from "./launch";

export interface LaunchStatsHandle {
  onStart(category: LaunchCategory): void;
  onEnd(category: LaunchCategory, durationMs: number): void;
}
