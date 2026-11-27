// Ordered settings-history changes shared by the renderer, host and replay.
// The file projection retains the steps a restarted daemon can restore.

import { type SessionId } from "../daemon/foundations/session-id";
import { layerRoleOf, type LayerRole } from "../config/layer-role";
import { isPlainObject } from "../config/loader/validate-core";
import type { Asked } from "../utils/outcome";
import { isSettingKey } from "../config/session-key";
import { kept, type Kept } from "../daemon/foundations/stored-file";

// [LAW:types-are-the-program] What a change touched and the two states it
// stepped between. `null` is absence on both kinds: an unset session key, a
// config file that does not exist (a first-ever write created it). Undo writes
// `before`, redo writes `after` — the same write either way.
// [LAW:single-enforcer] A config layer is named by its role in the session's
// chain and a digest of the file that role resolved to, never by its path
// (spec I-10): a step reaches only a file the chain still names, and only the
// one it was made on.
export type Change =
  | {
      readonly kind: "session";
      readonly key: string;
      readonly before: string | null;
      readonly after: string | null;
    }
  | {
      readonly kind: "layer";
      readonly role: LayerRole;
      readonly digest: string;
      readonly before: string | null;
      readonly after: string | null;
    };

export type Step = readonly Change[];

export interface SessionHistory {
  readonly past: readonly Step[];
  readonly future: readonly Step[];
}

export type HistoryTarget =
  | { readonly kind: "session"; readonly key: string }
  | {
      readonly kind: "layer";
      readonly role: LayerRole;
      readonly digest: string;
    };

export function historyTarget(change: Change): HistoryTarget {
  return change.kind === "session"
    ? { kind: "session", key: change.key }
    : { kind: "layer", role: change.role, digest: change.digest };
}

export const targetKey = (c: HistoryTarget): string =>
  c.kind === "session" ? `session:${c.key}` : `layer:${c.role}:${c.digest}`;

// [LAW:types-are-the-program] A new step carries its contents once. Moving
// between stacks refers to the step in the receiver's ordered history.
export type HistoryEdit =
  | { readonly kind: "append"; readonly step: Step }
  | { readonly kind: "undo" | "redo" | "clear" }
  | { readonly kind: "trim"; readonly count: number }
  | { readonly kind: "forget"; readonly targets: readonly HistoryTarget[] };

export const EMPTY_HISTORY: SessionHistory = { past: [], future: [] };
const MAX_STEPS = 50;

const appended = (stack: readonly Step[], step: Step): readonly Step[] => [
  ...stack.slice(1 - MAX_STEPS),
  step,
];

// [LAW:single-enforcer] The click, the host and offline replay fold the same
// recorded decision. Applying it performs no file or session action.
export function historyAfter(
  history: SessionHistory,
  edit: HistoryEdit,
): SessionHistory {
  const { past, future } = history;
  switch (edit.kind) {
    case "append":
      return { past: appended(past, edit.step), future: [] };
    case "undo": {
      const step = past.at(-1);
      if (step === undefined)
        throw new Error("history delta cannot undo an empty stack");
      return { past: past.slice(0, -1), future: appended(future, step) };
    }
    case "redo": {
      const step = future.at(-1);
      if (step === undefined)
        throw new Error("history delta cannot redo an empty stack");
      return { past: appended(past, step), future: future.slice(0, -1) };
    }
    case "clear":
      return EMPTY_HISTORY;
    case "trim":
      if (
        !Number.isSafeInteger(edit.count) ||
        edit.count < 1 ||
        edit.count > past.length + future.length
      )
        throw new Error("history delta trims beyond the held steps");
      return {
        past: past.slice(edit.count),
        future:
          edit.count > past.length
            ? future.slice(edit.count - past.length)
            : future,
      };
    case "forget": {
      const gone = new Set(edit.targets.map(targetKey));
      const kept = (steps: readonly Step[]): Step[] =>
        steps.flatMap((step) => {
          if (!step.length) return [];
          if (!step.some((change) => gone.has(targetKey(change))))
            return [step];
          const rest = step.filter((change) => !gone.has(targetKey(change)));
          return rest.length ? [rest] : [];
        });
      return { past: kept(past), future: kept(future) };
    }
  }
}

// An empty result has no session slot or place in recency order.
export function historyAfterEdits(
  prior: SessionHistory | undefined,
  edits: readonly HistoryEdit[],
): SessionHistory | null {
  const next = edits.reduce(historyAfter, prior ?? EMPTY_HISTORY);
  return holdsNothing(next) ? null : next;
}

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

// [LAW:parse-dont-validate] Only committed steps cross a restart. A stored
// savepoint from an older file cannot become a new live edit transaction.
export function parseSessionHistory(v: unknown): Asked<SessionHistory> {
  if (!isPlainObject(v)) return { kind: "failed", reason: "is not an object" };
  if (!isSteps(v.past))
    return {
      kind: "failed",
      reason: "has a 'past' that is not a list of steps",
    };
  if (!isSteps(v.future))
    return {
      kind: "failed",
      reason: "has a 'future' that is not a list of steps",
    };
  return { kind: "ok", value: { past: v.past, future: v.future } };
}

export const holdsNothing = ({ past, future }: SessionHistory): boolean =>
  past.length + future.length === 0;

export type HistoryState = Readonly<Record<SessionId, SessionHistory>>;

// [LAW:types-are-the-program] A session change that outlives the renderer is
// a change to a SETTING key, since a placement's draft lives and dies with its
// edit. A key that is not a setting in this build names nothing a
// render reads, so undoing it would spend a click restoring nothing. Those
// changes alone leave, each named in what was dropped, and the keys they
// named come back with what stays; every other change, and every other
// session, stays undoable. A step left empty leaves too.
// [LAW:single-enforcer] Saving a durable history and loading an older file
// apply the same rule to its steps.
export function withoutRetiredChanges(
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

// What an older release can restore from its profile or compare in a recording.
export function durableHistory(history: SessionHistory): SessionHistory | null {
  const parsed = withoutRetiredChanges(history);
  return parsed.kind === "ok" ? parsed.value.value : null;
}
