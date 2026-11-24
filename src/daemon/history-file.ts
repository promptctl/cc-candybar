// [LAW:effects-at-boundaries] The settings history's file: its load, checked
// shape by shape, and its atomic save.

import fs from "node:fs";
import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import { writeAtomic } from "../utils/atomic-write.js";
import {
  sessionFileOnDisk,
  type SessionFileKind,
  type SessionFileStorage,
} from "./session-state-file";
import {
  type SessionHistory,
  parseSessionHistory,
  withoutRetiredChanges,
} from "../renderer-interface/history-storage";

// [LAW:parse-dont-validate] The history file's sessions: each history parsed
// and stripped of the changes to keys this build has no setting for.
const HISTORY_FILE: Pick<SessionFileKind<SessionHistory>, "parse"> = {
  parse: (value) => {
    const parsed = parseSessionHistory(value);
    return parsed.kind === "failed"
      ? parsed
      : withoutRetiredChanges(parsed.value);
  },
};

// [LAW:single-enforcer] Read as every per-session file is (session-state-file.ts).
// [LAW:one-type-per-behavior] exception: written at once, not behind as the
// other per-session files are. Each step is the undo of a config edit that
// has already landed, so it is on disk before the click answers, and a
// write that fails throws into the click's taking, which says it on the bar:
// the change landed and undoes until the daemon restarts, not after. A write
// behind would lose the step to a kill inside its window and say a failure
// only in the log; one beside this write could land older bytes over a
// newer step.
export function fileHistoryStorage(
  file: string,
  logger: DaemonLogger,
): SessionFileStorage<SessionHistory> {
  return {
    ...sessionFileOnDisk(HISTORY_FILE, file),
    save: (state) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // [LAW:effects-at-boundaries] The file's record of the histories, in
        // the order the owner holds them, written before this returns.
        writeAtomic(file, JSON.stringify(Object.fromEntries(state)), 0o600);
      } catch (e) {
        const message = `settings-history write failed — the change landed and undoes until the daemon restarts, not after: ${(e as Error).message}`;
        logger("error", message);
        throw new Error(message);
      }
    },
    flush: async () => {},
  };
}
