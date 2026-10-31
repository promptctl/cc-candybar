import type { DaemonInputs } from "./daemon";
import { dlog } from "./log";
import { sessionStatePath, settingsHistoryPath } from "./paths";
import { FileSessionStorage } from "./session-state-file";
import { fileHistoryStorage } from "./settings-history";

// [LAW:one-source-of-truth] What a daemon keeps on disk, at the paths the
// environment names. A process and a test's daemon build this one thing, so a
// click in a test waits in the debounce a real one does, and a close has the
// same write to land.
export function fileStorage(): DaemonInputs["storage"] {
  return {
    session: new FileSessionStorage(sessionStatePath(), 500, dlog),
    history: fileHistoryStorage(settingsHistoryPath(), dlog),
  };
}
