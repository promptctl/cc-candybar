// [LAW:one-source-of-truth] A legacy profile can be edited by a rolled-back
// daemon. Only changes since its own last export belong to that writer.
// Initial import uses an empty basis. The already accepted state wins a
// contested value. Both sources remain available in the migration archive.
import { isDeepStrictEqual as equal } from "node:util";
import type { SessionId } from "./foundations/session-id.js";
import type {
  SessionPicks,
  StoredState,
} from "../renderer-interface/stored-state.js";
import {
  EMPTY_HISTORY,
  targetKey,
  type SessionHistory,
  type Step,
} from "../renderer-interface/history-storage.js";
import { ownValue } from "../utils/plain.js";

export interface ProfileConflict {
  readonly session: SessionId;
  readonly store: keyof StoredState;
}

type Choice = "current" | "incoming" | "conflict";
function choose<T>(basis: T, current: T, incoming: T): Choice {
  if (equal(incoming, basis) || equal(incoming, current)) return "current";
  return equal(current, basis) ? "incoming" : "conflict";
}

function mergePicks(
  basis: SessionPicks = {},
  current: SessionPicks = {},
  incoming: SessionPicks = {},
  conflict: () => void,
): SessionPicks | undefined {
  const kept = new Map(Object.entries(current));
  for (const key of new Set([
    ...Object.keys(basis),
    ...Object.keys(incoming),
  ])) {
    const value = ownValue(incoming, key);
    switch (choose(ownValue(basis, key), kept.get(key), value)) {
      case "conflict":
        conflict();
        break;
      case "current":
        break;
      case "incoming":
        if (value === undefined) kept.delete(key);
        else kept.set(key, value);
    }
  }
  return kept.size ? Object.fromEntries(kept) : undefined;
}

// A step is one click. If a click changed A and B, their histories have to
// come from the same source. Steps sharing either target join that group,
// across all three versions and both the undo and redo stacks.
function groupsOf(
  histories: readonly SessionHistory[],
): (step: Step) => string {
  const parents = new Map<string, string>();
  const root = (key: string): string => {
    let top = key;
    while (parents.has(top)) top = parents.get(top)!;
    while (parents.has(key)) {
      const parent = parents.get(key)!;
      parents.set(key, top);
      key = parent;
    }
    return top;
  };
  for (const history of histories)
    for (const stack of [history.past, history.future])
      for (const step of stack) {
        const first = root(targetKey(step[0]!));
        for (const change of step) {
          const other = root(targetKey(change));
          if (first !== other) parents.set(other, first);
        }
      }
  return (step) => root(targetKey(step[0]!));
}

function mergeHistory(
  basis: SessionHistory = EMPTY_HISTORY,
  current: SessionHistory = EMPTY_HISTORY,
  incoming: SessionHistory = EMPTY_HISTORY,
  conflict: () => void,
): SessionHistory | undefined {
  const present = (history: SessionHistory) =>
    history.past.length || history.future.length ? history : undefined;
  const whole = choose(basis, current, incoming);
  if (whole !== "conflict")
    return present(whole === "current" ? current : incoming);
  const group = groupsOf([basis, current, incoming]);
  const partition = (history: SessionHistory) => {
    const groups = new Map<string, { past: Step[]; future: Step[] }>();
    for (const stack of ["past", "future"] as const)
      for (const step of history[stack]) {
        const key = group(step);
        let part = groups.get(key);
        if (part === undefined) {
          part = { past: [], future: [] };
          groups.set(key, part);
        }
        part[stack].push(step);
      }
    return groups;
  };
  const before = partition(basis),
    held = partition(current),
    offered = partition(incoming);
  const selected = new Set<string>();
  for (const key of new Set([
    ...before.keys(),
    ...held.keys(),
    ...offered.keys(),
  ])) {
    const choice = choose(before.get(key), held.get(key), offered.get(key));
    if (choice === "incoming") selected.add(key);
    else if (choice === "conflict") conflict();
  }
  const stack = (side: keyof SessionHistory): Step[] => [
    ...current[side].filter((step) => !selected.has(group(step))),
    ...incoming[side].filter((step) => selected.has(group(step))),
  ];
  return present({ past: stack("past"), future: stack("future") });
}

// A legacy file keeps recency in object key order. After deletions, its
// longest surviving ordered prefix was already in that order. The remaining
// suffix is exactly the minimum set of hearings that reproduces the file.
// Concurrent additions to the host retain their relative order.
function mergeSessions<T>(
  basis: Readonly<Record<SessionId, T>>,
  current: Readonly<Record<SessionId, T>>,
  incoming: Readonly<Record<SessionId, T>>,
  merge: (
    basis: T | undefined,
    held: T | undefined,
    offered: T | undefined,
    conflict: () => void,
  ) => T | undefined,
  onConflict: (id: SessionId) => void,
): Readonly<Record<SessionId, T>> {
  const ids = (entries: Readonly<Record<SessionId, T>>) =>
    Object.keys(entries) as SessionId[];
  const before = ids(basis);
  const next = ids(incoming);
  const kept = new Map<SessionId, T>(
    ids(current).map((id) => [id, current[id]!]),
  );
  for (const id of new Set([...before, ...next])) {
    let conflicted = false;
    const value = merge(
      ownValue(basis, id),
      kept.get(id),
      ownValue(incoming, id),
      () => {
        conflicted = true;
      },
    );
    if (conflicted) onConflict(id);
    if (value === undefined) kept.delete(id);
    else kept.set(id, value);
  }
  const priorIndex = new Map(before.map((id, i) => [id, i]));
  let last = -1;
  for (const id of next) {
    const index = priorIndex.get(id) ?? -1;
    if (last < index) {
      last = index;
      continue;
    }
    last = Infinity;
    const value = kept.get(id);
    if (value !== undefined) {
      kept.delete(id);
      kept.set(id, value);
    }
  }
  return Object.fromEntries(kept);
}

export function reconcileSessionProfile(
  basis: StoredState,
  current: StoredState,
  incoming: StoredState,
): { state: StoredState; conflicts: ProfileConflict[] } {
  const conflicts: ProfileConflict[] = [];
  const report = (store: keyof StoredState) => (session: SessionId) => {
    conflicts.push({ store, session });
  };
  return {
    state: {
      sessions: mergeSessions(
        basis.sessions,
        current.sessions,
        incoming.sessions,
        mergePicks,
        report("sessions"),
      ),
      history: mergeSessions(
        basis.history,
        current.history,
        incoming.history,
        mergeHistory,
        report("history"),
      ),
    },
    conflicts,
  };
}
