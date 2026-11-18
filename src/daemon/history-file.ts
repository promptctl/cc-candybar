// [LAW:effects-at-boundaries] The settings history's file: its load, checked
// shape by shape, and its atomic save.

import fs from "node:fs";
import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import { writeAtomic } from "../utils/atomic-write.js";
import { layerRoleOf } from "../config/layer-role";
import {
  isRecord,
  loadSessionFile,
  type ParsedEntry,
  type SessionFileKind,
} from "./session-state-file";
import {
  type Change,
  type Step,
  type SessionHistory,
  type Savepoint,
  type HistoryStorage,
  holdsNothing,
  isSettingKey,
} from "../renderer-interface/history-storage";

// ─── The file ───────────────────────────────────────────────────────────────

function isChange(v: unknown): v is Change {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const state = (x: unknown) => x === null || typeof x === "string";
  return (
    ((o.kind === "session" && typeof o.key === "string") ||
      (o.kind === "layer" &&
        layerRoleOf(o.role) !== null &&
        typeof o.digest === "string")) &&
    state(o.before) &&
    state(o.after)
  );
}

function isSteps(v: unknown): v is Step[] {
  return (
    Array.isArray(v) &&
    v.every((step) => Array.isArray(step) && step.every(isChange))
  );
}

function isSavepoint(v: unknown): v is Savepoint {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    Number.isInteger(o.at) &&
    (o.at as number) >= 0 &&
    Array.isArray(o.net) &&
    o.net.every(isChange) &&
    isSteps(o.below)
  );
}

// [LAW:parse-dont-validate] A session's history as its file spelled it, or
// the field that is not what a history holds.
function parseSessionHistory(v: unknown): ParsedEntry<SessionHistory> {
  if (!isRecord(v)) return { ok: false, problem: "is not an object" };
  const problem = !isSteps(v.past)
    ? "has a 'past' that is not a list of steps"
    : !isSteps(v.future)
      ? "has a 'future' that is not a list of steps"
      : v.savepoint !== undefined && !isSavepoint(v.savepoint)
        ? "has a 'savepoint' that is not a savepoint"
        : null;
  return problem === null
    ? { ok: true, value: v as unknown as SessionHistory }
    : { ok: false, problem };
}

// [LAW:types-are-the-program] A session change is a change to a SETTING key —
// the only kind the journal records. A key that has left that set since the
// file was written (brandon-menu-ia-q30.xuz renamed `look` and `progression`)
// names nothing a render reads, so undoing it would spend a click restoring
// nothing. Those changes alone leave, and the keys they named come back with
// what stays; every other change, and every other session, stays undoable. A
// step left empty leaves too, and the savepoint's `at` counts only the steps
// below it that remain.
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
  const { savepoint } = history;
  const past = steps(history.past);
  const future = steps(history.future);
  if (savepoint === undefined) return { history: { past, future }, retired };
  return {
    history: {
      past,
      future,
      savepoint: {
        at: steps(history.past.slice(0, savepoint.at)).length,
        net: savepoint.net.filter(keep),
        below: steps(savepoint.below),
      },
    },
    retired,
  };
}

const quoted = (keys: Iterable<string>): string =>
  [...keys].map((k) => `"${k}"`).join(", ");

// [LAW:parse-dont-validate] The history file's sessions: each history parsed
// and stripped of its retired keys. One left holding nothing is dropped by
// name, so it takes no place in the bound.
const HISTORY_FILE: Pick<SessionFileKind<Stripped>, "name" | "parse"> = {
  name: "settings-history",
  parse: (value) => {
    const parsed = parseSessionHistory(value);
    if (!parsed.ok) return parsed;
    const stripped = withoutRetiredKeys(parsed.value);
    if (!holdsNothing(stripped.history)) return { ok: true, value: stripped };
    return {
      ok: false,
      problem:
        stripped.retired.size > 0
          ? `holds only changes to ${quoted(stripped.retired)}, no longer a setting`
          : "holds nothing to undo, redo or cancel",
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
      const retired = new Set(
        [...loaded.values()].flatMap(({ retired }) => [...retired]),
      );
      if (retired.size > 0) {
        logger(
          "warn",
          `settings-history load: dropped the changes to ${quoted(retired)}, no longer a setting`,
        );
      }
      return new Map(
        [...loaded].map(([id, { history }]) => [id, history] as const),
      );
    },
    save: (state) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // [LAW:effects-at-boundaries] The file is the one place the
        // sessions are a record.
        writeAtomic(file, JSON.stringify(Object.fromEntries(state)), 0o600);
      } catch (e) {
        const message = `settings-history write failed — the change landed and undoes until the daemon restarts, not after: ${(e as Error).message}`;
        logger("error", message);
        throw new Error(message);
      }
    },
  };
}
