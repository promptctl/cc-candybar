// A menu visit has a source view and a destination view in one session.
// [LAW:effects-at-boundaries] The cursor moves between these views. Back
// installs a destination as state and never invokes the action that drew it.

import { observable, runInAction } from "mobx";
import { EDIT_MODE_KEY } from "../config/loader/edit-mode.js";
import { isConfirmKey } from "../config/confirm-step";
import { isSettingKey } from "../renderer-interface/history-storage";
import { DIAGNOSTICS_VIEWING } from "../config/door";
import type { StateWrite } from "../config/disclosure-nest";
import type { SessionStateRW } from "../renderer-interface/session-state";
import type { Gate } from "../daemon/foundations/validator-registry";
import { BadVerbArgs } from "../daemon/foundations/verb-error";
import type { SessionId } from "../daemon/foundations/session-id";

// [LAW:types-are-the-program] A complete view of the configured menu keys.
// An absent key follows its config default. Config-authored disclosures and
// page cursors use the same representation as built-in menus.
export interface MenuContext {
  readonly gate: Gate;
}

interface MenuView {
  readonly values: ReadonlyMap<string, string>;
}

interface Visit {
  readonly from: MenuView;
  readonly to: MenuView;
}

interface Timeline {
  readonly visits: readonly Visit[];
  readonly cursor: number;
}

const EMPTY: Timeline = { visits: [], cursor: 0 };

// [LAW:carrying-cost] Bound both the visits of one session and the
// number of sessions. A configuration can only contribute its gate's keys.
const MAX_VISITS = 20;
const MAX_SESSIONS = 32;

// [LAW:one-source-of-truth] The gate supplies the menu's keys. Settings,
// transaction lifecycle, confirmations and independently owned UI state
// cannot be restored by visiting a prior menu.
const isMenuKey = (key: string): boolean =>
  key !== EDIT_MODE_KEY &&
  !isSettingKey(key) &&
  !isConfirmKey(key) &&
  key !== DIAGNOSTICS_VIEWING;

const menuKeys = new WeakMap<Gate, readonly string[]>();
function capture(
  store: SessionStateRW,
  sid: SessionId,
  { gate }: MenuContext,
): MenuView {
  let keys = menuKeys.get(gate);
  if (keys === undefined) {
    keys = gate.listKeys().filter(isMenuKey);
    menuKeys.set(gate, keys);
  }
  const values = new Map<string, string>();
  for (const key of keys) {
    const value = store.get(sid, key);
    if (value !== null) values.set(key, value);
  }
  return { values };
}

function movedKeys(from: MenuView, to: MenuView): string[] {
  return [...new Set([...from.values.keys(), ...to.values.keys()])].filter(
    (key) => from.values.get(key) !== to.values.get(key),
  );
}

// [LAW:single-enforcer] The search supplies both Back and its displayed
// depth. An overwritten control or an invalid destination skips its visit.
// A closed edit's own state is no value the session holds, so a step that
// moved it is never one the session can go back to.
function previous(
  timeline: Timeline,
  current: MenuView,
  context: MenuContext,
): {
  readonly destination: MenuView | null;
  readonly depth: number;
  readonly invalid: ReadonlySet<Visit>;
} {
  const invalid = new Set<Visit>();
  const values = new Map(current.values);
  let destination: MenuView | null = null;
  let depth = 0;
  for (let cursor = timeline.cursor - 1; cursor >= 0; cursor--) {
    const visit = timeline.visits[cursor]!;
    const keys = movedKeys(visit.from, visit.to);
    const step = keys.flatMap((key) => {
      const from = visit.from.values.get(key);
      const to = visit.to.values.get(key);
      return from === to ? [] : [{ key, from, to }];
    });
    if (
      step.length === 0 ||
      !step.every(
        ({ key, from, to }) =>
          values.get(key) === to &&
          (from === undefined || context.gate.validate(key, from).ok),
      )
    ) {
      invalid.add(visit);
      continue;
    }
    for (const { key, from } of step) {
      if (from === undefined) values.delete(key);
      else values.set(key, from);
    }
    destination ??= { values: new Map(values) };
    depth++;
  }
  return { destination, depth, invalid };
}

interface RestoredView {
  readonly writes: ReadonlyArray<{
    readonly key: string;
    readonly value: string | null;
  }>;
  readonly discarded: number;
}

export interface NavigationTurn {
  choose(
    sessionId: SessionId,
    writes: readonly StateWrite[],
    context: () => MenuContext,
  ): void;
  back(sessionId: SessionId, context: MenuContext): RestoredView;
  commit(): void;
}

export class NavigationHistory {
  private readonly timelines = observable.map<SessionId, Timeline>(undefined, {
    deep: false,
  });

  depth(
    sessionId: SessionId,
    store: SessionStateRW,
    context: MenuContext,
  ): number {
    const timeline = this.timelines.get(sessionId);
    return timeline === undefined || timeline.cursor === 0
      ? 0
      : previous(timeline, capture(store, sessionId, context), context).depth;
  }

  // [LAW:no-ambient-temporal-coupling] The transition and its navigation
  // cursor are staged alongside the click's settings. A guarded write that
  // does not land publishes neither.
  begin(
    store: SessionStateRW,
    choose: SessionStateRW["setBatch"],
  ): NavigationTurn {
    const before = new Map<
      SessionId,
      { readonly view: MenuView; readonly context: MenuContext }
    >();
    const next = new Map<SessionId, Timeline>();
    const timelineOf = (sid: SessionId) =>
      next.get(sid) ?? this.timelines.get(sid) ?? EMPTY;

    const endVisit = (sid: SessionId): void => {
      const start = before.get(sid);
      if (start === undefined) return;
      before.delete(sid);
      const to = capture(store, sid, start.context);
      if (movedKeys(start.view, to).length === 0) return;
      const { visits, cursor } = timelineOf(sid);
      const followed = [
        ...visits.slice(0, cursor),
        { from: start.view, to },
      ].slice(-MAX_VISITS);
      next.set(sid, { visits: followed, cursor: followed.length });
    };

    return {
      choose: (sid, writes, contextOf) => {
        if (!before.has(sid) && writes.some(({ key }) => isMenuKey(key))) {
          const context = contextOf();
          before.set(sid, { view: capture(store, sid, context), context });
        }
        choose(sid, writes);
      },
      back: (sid, context) => {
        endVisit(sid);
        const timeline = timelineOf(sid);
        const at = capture(store, sid, context);
        const { destination, invalid } = previous(timeline, at, context);
        const discarded = invalid.size;
        const cursor = Math.max(0, timeline.cursor - discarded - 1);
        next.set(sid, {
          visits: timeline.visits.filter((visit) => !invalid.has(visit)),
          cursor,
        });
        if (destination === null)
          throw new BadVerbArgs(
            `back: nothing to go back to${discarded > 0 ? ` (${discarded} step(s) over a view since gone, discarded)` : ""}`,
          );
        const writes = movedKeys(at, destination).map((key) => ({
          key,
          value: destination.values.get(key) ?? null,
        }));
        runInAction(() => {
          store.setBatch(
            sid,
            writes.flatMap(({ key, value }) =>
              value === null ? [] : [{ key, value }],
            ),
          );
          for (const { key, value } of writes)
            if (value === null) store.clear(sid, key);
        });
        return { writes, discarded };
      },
      commit: () => {
        for (const sid of before.keys()) endVisit(sid);
        this.publish(next);
        next.clear();
      },
    };
  }

  private publish(timelines: ReadonlyMap<SessionId, Timeline>): void {
    runInAction(() => {
      for (const [sid, timeline] of timelines) {
        this.timelines.delete(sid);
        if (timeline.visits.length > 0) this.timelines.set(sid, timeline);
      }
      while (this.timelines.size > MAX_SESSIONS)
        this.timelines.delete(this.timelines.keys().next().value!);
    });
  }
}
