// [LAW:effects-at-boundaries] The settings history's file: its load, checked
// shape by shape, and its atomic save.

import fs from "node:fs";
import path from "node:path";
import type { DaemonLogger } from "../utils/logger";
import { writeAtomic } from "../utils/atomic-write.js";
import { layerRoleOf } from "../config/layer-role";
import { sessionKeyed, type SessionId } from "./foundations/session-id";
import {
  type Change,
  type Step,
  type SessionHistory,
  type Savepoint,
  type HistoryState,
  type HistoryStorage,
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

function isSessionHistory(v: unknown): v is SessionHistory {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    isSteps(o.past) &&
    isSteps(o.future) &&
    (o.savepoint === undefined || isSavepoint(o.savepoint))
  );
}

// [LAW:types-are-the-program] A session change is a change to a SETTING key —
// the only kind the journal records. A key that has left that set since the
// file was written (brandon-menu-ia-q30.xuz renamed `look` and `progression`)
// names nothing a render reads, so undoing it would spend a click restoring
// nothing. Those changes alone leave, each one named in `retired`; every other
// change, and every other session, stays undoable. A step left empty leaves
// too, and the savepoint's `at` counts only the steps below it that remain.
function withoutRetiredKeys(
  history: SessionHistory,
  retired: Set<string>,
): SessionHistory {
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
  if (savepoint === undefined) return { past, future };
  return {
    past,
    future,
    savepoint: {
      at: steps(history.past.slice(0, savepoint.at)).length,
      net: savepoint.net.filter(keep),
      below: steps(savepoint.below),
    },
  };
}

// [LAW:no-silent-failure] A missing file is a first boot. An unreadable or
// wrong-shaped one is logged and dropped WHOLE rather than salvaged entry by
// entry. A write failure throws: the click's change landed, but saying it is
// undoable would be a lie.
export function fileHistoryStorage(
  file: string,
  logger: DaemonLogger,
): HistoryStorage {
  return {
    load: () => {
      const loaded = new Map<SessionId, SessionHistory>();
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logger(
            "warn",
            `settings-history read failed (${code}); starting empty`,
          );
        }
        return loaded;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Object.values(parsed).every(isSessionHistory)
        ) {
          const retired = new Set<string>();
          const keyed = sessionKeyed(parsed as HistoryState, (key, problem) =>
            logger(
              "warn",
              `settings-history load: dropped session key ${JSON.stringify(key)}: session id ${problem}`,
            ),
          );
          for (const [id, history] of keyed)
            loaded.set(id, withoutRetiredKeys(history, retired));
          if (retired.size > 0) {
            logger(
              "warn",
              `settings-history load: dropped the changes to ${[...retired].map((k) => `"${k}"`).join(", ")}, no longer a setting`,
            );
          }
          return loaded;
        }
      } catch {
        // reported below
      }
      logger("warn", "settings-history load: unexpected shape, starting empty");
      return loaded;
    },
    save: (state) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(state), 0o600);
      } catch (e) {
        const message = `settings-history write failed — the change landed but is not undoable: ${(e as Error).message}`;
        logger("error", message);
        throw new Error(message);
      }
    },
  };
}
