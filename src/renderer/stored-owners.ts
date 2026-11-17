// The owners of the renderer's stored state (src/renderer/stored-registry.ts):
// each restores its store from what a start hands in, through the checks a
// file read always crossed, and names its entries for the registry to drain.
//
// [LAW:parse-dont-validate] What was handed in is the host's copy of what an
// earlier renderer wrote, possibly an older build's: every entry is read here,
// once, and one that does not read is dropped and said, never salvaged by
// guesswork. A dropped entry is written back as gone, so the host's copy
// holds only what this renderer holds.

import type { JsonValue } from "../var-system/types";
import type { DaemonLogger } from "../utils/logger";
import type { Asked } from "../utils/outcome";
import {
  DOCUMENT_KEY,
  type StoreName,
  type StoredStore,
} from "../renderer-interface/stored";
import { sessionKeyed, type SessionId } from "../daemon/foundations/session-id";
import { layerRoleOf } from "../config/layer-role";
import type { StoredOwner } from "./stored-registry";
import type { DocumentStore } from "../doctor/ports";
import type { SessionState } from "./session-state";
import type { SettingsHistory } from "./settings-history";
import {
  isSettingKey,
  type Change,
  type Savepoint,
  type SessionHistory,
  type Step,
} from "./history-steps";

type Entries = Readonly<Record<string, JsonValue>>;

// [LAW:no-silent-failure] A store whose file did not read is said, and the
// renderer holds it empty.
function entriesOf(
  name: string,
  stored: StoredStore,
  log: DaemonLogger,
): Entries {
  if (stored.kind === "read") return stored.entries;
  log("warn", `${name}: ${stored.reason}; starting empty`);
  return {};
}

// ─── Session state ──────────────────────────────────────────────────────────

// Keys only an older build wrote: a session's origin and client facts, which
// the host hands in with each click now.
const RETIRED_SESSION_KEYS: ReadonlySet<string> = new Set([
  "render-origin",
  "client-hints",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function sessionOwner(
  sessionState: SessionState,
  log: DaemonLogger,
): StoredOwner {
  return {
    store: "session",
    restore: (stored) => {
      const loaded = new Map<SessionId, Readonly<Record<string, string>>>();
      const keyed = sessionKeyed(
        entriesOf("session-state", stored, log),
        (key, problem) =>
          log(
            "warn",
            `session-state: dropped session key ${JSON.stringify(key)}: session id ${problem}`,
          ),
      );
      for (const [id, values] of keyed) {
        if (
          !isRecord(values) ||
          !Object.values(values).every((v) => typeof v === "string")
        ) {
          log("warn", `session-state: dropped session ${id}: not its values`);
          continue;
        }
        const kept = Object.entries(values as Record<string, string>).filter(
          ([key]) => !RETIRED_SESSION_KEYS.has(key),
        );
        if (kept.length > 0) loaded.set(id, Object.fromEntries(kept));
      }
      sessionState.restore(loaded);
    },
    versions: () => sessionState.versions(),
    value: (key) => sessionState.values(key as SessionId),
  };
}

// ─── Settings history ───────────────────────────────────────────────────────

// [LAW:types-are-the-program] A change this build can step, or why it cannot:
// a session key that has left the settings names nothing a render reads, and
// a change an older build named by its file's path names no layer. Anything
// else is a history that does not read.
type ReadChange =
  | { readonly kind: "kept"; readonly change: Change }
  | { readonly kind: "dropped"; readonly why: string }
  | null;

function readChange(v: unknown): ReadChange {
  if (!isRecord(v)) return null;
  const state = (x: unknown): x is string | null =>
    x === null || typeof x === "string";
  if (!state(v.before) || !state(v.after)) return null;
  const { before, after } = v;
  if (v.kind === "session" && typeof v.key === "string")
    return isSettingKey(v.key)
      ? { kind: "kept", change: { kind: "session", key: v.key, before, after } }
      : { kind: "dropped", why: `"${v.key}" (no longer a setting)` };
  if (v.kind === "layer") {
    const role = layerRoleOf(v.role);
    return role === null
      ? null
      : { kind: "kept", change: { kind: "layer", role, before, after } };
  }
  if (v.kind === "file" && typeof v.file === "string")
    return { kind: "dropped", why: "a file an older build named by its path" };
  return null;
}

// A history as this build reads it, its unsteppable changes gone and each
// named in `dropped`, or null for one that does not read. A step left empty
// leaves too, and the savepoint's `at` counts only the steps below it that
// remain.
function readHistory(v: unknown, dropped: Set<string>): SessionHistory | null {
  if (!isRecord(v)) return null;
  let readable = true;
  const steps = (list: unknown): Step[] => {
    if (!Array.isArray(list)) {
      readable = false;
      return [];
    }
    return list
      .map((step: unknown): Change[] => {
        if (!Array.isArray(step)) {
          readable = false;
          return [];
        }
        return step.flatMap((c: unknown): Change[] => {
          const read = readChange(c);
          if (read === null) readable = false;
          else if (read.kind === "dropped") dropped.add(read.why);
          else return [read.change];
          return [];
        });
      })
      .filter((step) => step.length > 0);
  };
  const past = steps(v.past);
  const future = steps(v.future);
  const savepoint = v.savepoint;
  if (savepoint === undefined) return readable ? { past, future } : null;
  if (
    !isRecord(savepoint) ||
    !Number.isInteger(savepoint.at) ||
    (savepoint.at as number) < 0 ||
    !Array.isArray(v.past)
  )
    return null;
  const at = steps(
    (v.past as unknown[]).slice(0, savepoint.at as number),
  ).length;
  const [net = []] = steps([savepoint.net]);
  const read: Savepoint = { at, net, below: steps(savepoint.below) };
  return readable ? { past, future, savepoint: read } : null;
}

export function historyOwner(
  history: SettingsHistory,
  log: DaemonLogger,
): StoredOwner {
  return {
    store: "history",
    restore: (stored) => {
      const loaded = new Map<SessionId, SessionHistory>();
      const dropped = new Set<string>();
      const keyed = sessionKeyed(
        entriesOf("settings-history", stored, log),
        (key, problem) =>
          log(
            "warn",
            `settings-history: dropped session key ${JSON.stringify(key)}: session id ${problem}`,
          ),
      );
      for (const [id, raw] of keyed) {
        const read = readHistory(raw, dropped);
        if (read === null)
          log("warn", `settings-history: dropped session ${id}: not a history`);
        else loaded.set(id, read);
      }
      if (dropped.size > 0)
        log(
          "warn",
          `settings-history: dropped the changes this build cannot step: ${[...dropped].join(", ")}`,
        );
      history.restore(loaded);
    },
    versions: () => history.versions(),
    value: (key) => history.history(key as SessionId) as unknown as JsonValue,
  };
}

// ─── The doctor's documents ─────────────────────────────────────────────────

// [LAW:one-type-per-behavior] Every document the doctor keeps holds to one
// policy: absent is the store's empty value, anything else must read, and
// nothing is filed over one that does not, so a document's other contents are
// never lost to a filing. Each differs only in its store, its empty value and
// its parser.
export type StoredDocument<T> = StoredOwner & DocumentStore<T>;

export function storedDocument<T extends JsonValue>(
  store: StoreName,
  empty: T,
  parse: (doc: unknown) => Asked<T>,
): StoredDocument<T> {
  let held: Asked<T> = { kind: "ok", value: empty };
  // The document as it was handed in: what is kept, untouched, while it does
  // not read. Undefined while the store holds none.
  let handed: JsonValue | undefined;
  return {
    store,
    restore: (stored) => {
      handed =
        stored.kind === "read" && DOCUMENT_KEY in stored.entries
          ? stored.entries[DOCUMENT_KEY]
          : undefined;
      if (stored.kind === "unreadable")
        held = { kind: "failed", reason: stored.reason };
      else if (handed === undefined) held = { kind: "ok", value: empty };
      else {
        const parsed = parse(handed);
        held =
          parsed.kind === "ok"
            ? parsed
            : { kind: "failed", reason: `${store} ${parsed.reason}` };
      }
    },
    // [LAW:one-source-of-truth] The value is its own version. One that does
    // not read stays as it was handed in, so no drain writes over it.
    versions: () =>
      handed === undefined
        ? new Map()
        : new Map([[DOCUMENT_KEY, held.kind === "ok" ? held.value : handed]]),
    value: () => (held.kind === "ok" ? held.value : (handed ?? null)),
    read: () => held,
    update: (next) => {
      if (held.kind === "failed") return held;
      const value = next(held.value);
      if (value !== held.value) {
        held = { kind: "ok", value };
        handed = value;
      }
      return held;
    },
  };
}
