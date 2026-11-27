// [LAW:one-source-of-truth] A visit carries only the values the gesture
// changed. Each peer uses the same reducer to append it or move Back.
import { isPlainObject } from "../config/loader/validate-core.js";
import { isNavigationKey } from "../config/session-key.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { Asked } from "../utils/outcome.js";

import type { StoreWrite } from "./stored-state.js";
import type { SessionKeyChange } from "./session-state.js";
export type Visit = readonly SessionKeyChange[];
export interface Timeline {
  readonly visits: readonly Visit[];
  readonly cursor: number;
}
export const EMPTY_TIMELINE: Timeline = { visits: [], cursor: 0 };
export const MAX_NAVIGATION_SESSIONS = 32;
const MAX_VISITS = 20;

export type NavigationEdit =
  | { readonly kind: "visit"; readonly changes: Visit }
  | {
      readonly kind: "back";
      readonly at: number;
      readonly discard: readonly number[];
    };

export type NavigationWrite =
  | {
      readonly store: "navigation";
      readonly kind: "navigate";
      readonly key: SessionId;
      readonly edit: NavigationEdit;
    }
  | {
      readonly store: "navigation";
      readonly kind: "drop";
      readonly key: SessionId;
    };

export function navigationAfter(
  timeline: Timeline,
  edit: NavigationEdit,
): Timeline {
  if (edit.kind === "visit") {
    const visits = [
      ...timeline.visits.slice(0, timeline.cursor),
      edit.changes,
    ].slice(-MAX_VISITS);
    return { visits, cursor: visits.length };
  }
  if (edit.at !== timeline.cursor)
    throw new Error(
      `Back expected cursor ${edit.at}, current cursor is ${timeline.cursor}`,
    );
  const discard = new Set(edit.discard);
  if (edit.discard.some((i) => i >= timeline.cursor))
    throw new Error("Back discards a visit outside the current cursor");
  return {
    visits: discard.size
      ? timeline.visits.filter((_, i) => !discard.has(i))
      : timeline.visits,
    cursor: Math.max(0, timeline.cursor - discard.size - 1),
  };
}

// Prepare every relative cursor movement before publishing any of the
// surrounding transaction. Multiple moves for a session see each other.
export function stageNavigation(
  writes: readonly StoreWrite[],
  current: (key: SessionId) => Timeline,
): ReadonlyMap<SessionId, Timeline> {
  const staged = new Map<SessionId, Timeline>();
  for (const write of writes) {
    if (write.store !== "navigation") continue;
    const next =
      write.kind === "drop"
        ? EMPTY_TIMELINE
        : navigationAfter(
            staged.get(write.key) ?? current(write.key),
            write.edit,
          );
    staged.delete(write.key);
    staged.set(write.key, next);
  }
  return staged;
}

function isVisit(raw: unknown): raw is Visit {
  if (!Array.isArray(raw) || !raw.length) return false;
  const keys = new Set<string>();
  for (const change of raw) {
    if (
      !isPlainObject(change) ||
      Object.keys(change).length !== 3 ||
      typeof change.key !== "string" ||
      !isNavigationKey(change.key) ||
      keys.has(change.key) ||
      change.from === change.to ||
      (change.from !== null && typeof change.from !== "string") ||
      (change.to !== null && typeof change.to !== "string")
    )
      return false;
    keys.add(change.key);
  }
  return true;
}

export function isNavigationEdit(raw: unknown): raw is NavigationEdit {
  if (!isPlainObject(raw)) return false;
  if (raw.kind === "visit")
    return Object.keys(raw).length === 2 && isVisit(raw.changes);
  return (
    raw.kind === "back" &&
    Object.keys(raw).length === 3 &&
    typeof raw.at === "number" &&
    Number.isSafeInteger(raw.at) &&
    raw.at >= 0 &&
    raw.at <= MAX_VISITS &&
    Array.isArray(raw.discard) &&
    raw.discard.length <= MAX_VISITS &&
    raw.discard.every(
      (i) => Number.isSafeInteger(i) && i >= 0 && i < MAX_VISITS,
    ) &&
    new Set(raw.discard).size === raw.discard.length
  );
}

export function parseTimeline(
  raw: unknown,
  allowEmpty = false,
): Asked<Timeline> {
  return isPlainObject(raw) &&
    Object.keys(raw).length === 2 &&
    Array.isArray(raw.visits) &&
    (allowEmpty || raw.visits.length > 0) &&
    raw.visits.length <= MAX_VISITS &&
    raw.visits.every(isVisit) &&
    typeof raw.cursor === "number" &&
    Number.isSafeInteger(raw.cursor) &&
    raw.cursor >= 0 &&
    raw.cursor <= raw.visits.length
    ? { kind: "ok", value: { visits: raw.visits, cursor: raw.cursor } }
    : { kind: "failed", reason: "holds an invalid navigation timeline" };
}
