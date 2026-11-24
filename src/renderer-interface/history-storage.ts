// The settings history's shapes and the storage port it saves through: the
// renderer's history writes them, and the host's file stores them
// (src/daemon/history-file.ts).

import { type SessionId } from "../daemon/foundations/session-id";
import { layerRoleOf, type LayerRole } from "../config/layer-role";
import { isPlainObject } from "../config/loader/validate-core";
import type { Asked } from "../utils/outcome";

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
