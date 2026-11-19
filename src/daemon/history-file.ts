// [LAW:effects-at-boundaries] The settings history's file: its load, checked
// shape by shape, and its atomic save.

import fs from "node:fs";
import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import { writeAtomic } from "../utils/atomic-write.js";
import { loadSessionFile, type SessionFileKind } from "./session-state-file";
import {
  type Change,
  type Step,
  type SessionHistory,
  type HistoryStorage,
  holdsNothing,
  parseSessionHistory,
  isSettingKey,
} from "../renderer-interface/history-storage";

// ─── The file ───────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] A session change is a change to a SETTING key —
// the only kind the journal records. A key that has left that set since the
// file was written (brandon-menu-ia-q30.xuz renamed `look` and `progression`)
// names nothing a render reads, so undoing it would spend a click restoring
// nothing. Those changes alone leave, and the keys they named come back with
// what stays; every other change, and every other session, stays undoable. A
// step left empty leaves too.
interface Stripped {
  readonly history: SessionHistory;
  readonly retired: ReadonlySet<string>;
}
function withoutRetiredKeys(history: SessionHistory): Stripped {
  const retired = new Set<string>();
  const keep = (change: Change): boolean => {
    if (change.kind === "layer" || isSettingKey(change.key)) return true;
    retired.add(change.key);
    return false;
  };
  const steps = (list: readonly Step[]): Step[] =>
    list.map((step) => step.filter(keep)).filter((step) => step.length > 0);
  return {
    history: { past: steps(history.past), future: steps(history.future) },
    retired,
  };
}

const quoted = (keys: Iterable<string>): string =>
  [...keys].map((k) => `"${k}"`).join(", ");

// [LAW:parse-dont-validate] The history file's sessions: each history parsed
// and stripped of its retired keys. One left holding nothing is dropped, its
// retired keys named in why, so it takes no place in the bound.
const HISTORY_FILE: Pick<SessionFileKind<Stripped>, "name" | "parse"> = {
  name: "settings-history",
  parse: (value) => {
    const parsed = parseSessionHistory(value);
    if (parsed.kind === "failed") return parsed;
    const stripped = withoutRetiredKeys(parsed.value);
    if (!holdsNothing(stripped.history)) return { kind: "ok", value: stripped };
    return {
      kind: "failed",
      reason:
        stripped.retired.size > 0
          ? `holds only changes to ${quoted(stripped.retired)}, no longer a setting`
          : "holds nothing to undo or redo",
    };
  },
};

// [LAW:single-enforcer] Loaded as every per-session file is: a session whose
// key or history is refused is named and dropped alone, and the rest load.
// [LAW:one-type-per-behavior] exception: written at once, not behind as the
// other per-session files are. Each step is the undo of a config edit that
// has already landed, so it is on disk before the click answers, and a
// write that fails throws into the click's taking, which says it on the bar:
// the change landed and undoes until the daemon restarts, not after. A write
// behind would lose the step to a kill inside its window and say a failure
// only in the log.
export function fileHistoryStorage(
  file: string,
  logger: DaemonLogger,
): HistoryStorage {
  return {
    load: () => {
      const loaded = loadSessionFile(HISTORY_FILE, file, logger);
      // [LAW:no-silent-failure] Each kept session names the changes it lost,
      // as a dropped one does in why it was dropped.
      for (const [id, { retired }] of loaded)
        if (retired.size > 0)
          logger(
            "warn",
            `settings-history load: session ${JSON.stringify(id)} dropped the changes to ${quoted(retired)}, no longer a setting`,
          );
      return new Map(
        [...loaded].map(([id, { history }]) => [id, history] as const),
      );
    },
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
  };
}
