import type { DaemonStorage } from "./daemon";
import type { DaemonPaths } from "./paths";
import { FileSessionStorage } from "./session-state-file";
import { fileHistoryStorage } from "./settings-history";
import type { DaemonLogger } from "../utils/logger";
import type { Timekeeper } from "../time";

// [LAW:one-source-of-truth] What a daemon keeps on disk, at the paths it is
// given. A process and a test's daemon build this one thing, so a click in a
// test waits in the debounce a real one does, and a close has the same write to
// land.
export function fileStorage(
  paths: Pick<DaemonPaths, "sessionState" | "settingsHistory" | "storedRoot">,
  log: DaemonLogger,
  clock: Pick<Timekeeper, "after" | "monotonic">,
): DaemonStorage {
  return {
    session: new FileSessionStorage(paths.sessionState, clock, 500, log),
    history: fileHistoryStorage(paths.settingsHistory, paths.storedRoot, log),
  };
}
