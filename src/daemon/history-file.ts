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
  type Change,
  type Step,
  type SessionHistory,
  holdsNothing,
  parseSessionHistory,
} from "../renderer-interface/history-storage";
import type { Asked } from "../utils/outcome";
import { kept, type Kept } from "./foundations/stored-file";
import { isSettingKey } from "../config/session-key";

// [LAW:types-are-the-program] A session change is a change to a SETTING key —
// the only kind this history records, since a placement's draft lives and dies
// with its edit. A key that is not a setting in this build names nothing a
// render reads, so undoing it would spend a click restoring nothing. Those
// changes alone leave, each named in what the load dropped, and the keys they
// named come back with what stays; every other change, and every other
// session, stays undoable. A step left empty leaves too.
function withoutRetiredKeys(
  history: SessionHistory,
): Asked<Kept<SessionHistory>> {
  const retired = new Set<string>();
  const keep = (change: Change): boolean => {
    if (change.kind === "layer" || isSettingKey(change.key)) return true;
    retired.add(change.key);
    return false;
  };
  const steps = (list: readonly Step[]): Step[] =>
    list.map((step) => step.filter(keep)).filter((step) => step.length > 0);
  const stripped = { past: steps(history.past), future: steps(history.future) };
  const why = "its changes are to a key that is not a setting in this build";
  // A session left holding nothing is refused, so it takes no place in the
  // bound.
  if (holdsNothing(stripped))
    return {
      kind: "failed",
      reason:
        retired.size > 0
          ? `holds only changes to ${quoted(retired)}, not a setting in this build`
          : "holds nothing to undo or redo",
    };
  return kept(
    stripped,
    [...retired].map((key) => ({ part: key, why })),
  );
}

const quoted = (keys: Iterable<string>): string =>
  [...keys].map((k) => `"${k}"`).join(", ");

// [LAW:parse-dont-validate] The history file's sessions: each history parsed
// and stripped of the changes to keys this build has no setting for.
const HISTORY_FILE: Pick<SessionFileKind<SessionHistory>, "parse"> = {
  parse: (value) => {
    const parsed = parseSessionHistory(value);
    return parsed.kind === "failed" ? parsed : withoutRetiredKeys(parsed.value);
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
