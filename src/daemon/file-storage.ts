import type { ProfilePaths } from "./paths";
import { sessionStateFile } from "./session-state-file";
import { fileHistoryStorage } from "./history-file";
import type { DaemonLogger } from "../utils/logger";
import type { Timekeeper } from "../time";
import type { ProfileStorage } from "./held-stores";

// [LAW:one-source-of-truth] Where a profile's stores are kept on disk, at the
// paths it is given. A process and a test's daemon build this one thing, so a
// click in a test waits in the debounce a real one does, and a close has the
// same write to land.
export function fileStorage(
  paths: ProfilePaths,
  log: DaemonLogger,
  clock: Pick<Timekeeper, "after" | "monotonic">,
): ProfileStorage {
  return {
    session: sessionStateFile(paths.sessionState, clock, 500, log),
    history: fileHistoryStorage(paths.settingsHistory, log),
  };
}
