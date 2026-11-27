// [LAW:effects-at-boundaries] The settings history's file: its load, checked
// shape by shape, and its atomic save.

import fs from "node:fs";
import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import { asError, writeAtomic } from "../utils/atomic-write.js";
import type { SessionId } from "./foundations/session-id";
import { LANDED, Landings, type Landed } from "./foundations/stored-file";
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
// has already landed, so it is on disk before the click answers. A write
// behind would lose the step to a kill inside its window; one beside this
// write could land older bytes over a newer step. A write that fails is told
// as every file's is, through `landed`, and stays pending for the next save
// or the close's flush.
export function fileHistoryStorage(
  file: string,
  logger: DaemonLogger,
  // The step that writes the bytes, as `SessionFile`'s is, so a case can make
  // a write fail without a disk that does.
  publish: typeof writeAtomic = writeAtomic,
): SessionFileStorage<SessionHistory> {
  const landings = new Landings();
  let pending: ReadonlyMap<SessionId, SessionHistory> | null = null;
  const write = (): Landed => {
    if (pending === null) return LANDED;
    let landed: Landed = LANDED;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // [LAW:effects-at-boundaries] The file's record of the histories, in
      // the order the owner holds them, written before this returns.
      publish(file, JSON.stringify(Object.fromEntries(pending)), 0o600);
      pending = null;
    } catch (e) {
      const error = asError(e);
      logger("warn", `settings-history save failed: ${error.message}`);
      landed = { ok: false, error };
    }
    return landings.tell(landed);
  };
  return {
    ...sessionFileOnDisk(HISTORY_FILE, file),
    save: (state) => {
      pending = new Map(state);
      write();
    },
    landed: (listener) => landings.listen(listener),
    flush: async () => {
      const landed = write();
      if (!landed.ok) throw landed.error;
    },
  };
}
