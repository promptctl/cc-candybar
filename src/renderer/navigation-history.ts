// A menu visit has a source view and a destination view in one session.
// [LAW:effects-at-boundaries] The cursor moves between these views. Back
// installs a destination as state and never invokes the action that drew it.

import { observable, runInAction } from "mobx";
import { isEditModeKey, isNavigationKey } from "../config/session-key";
import {
  EMPTY_TIMELINE,
  MAX_NAVIGATION_SESSIONS,
  navigationAfter,
  type NavigationEdit,
  type NavigationWrite,
  type Timeline,
  type Visit,
} from "../renderer-interface/navigation.js";
import type { StateWrite } from "../config/disclosure-nest";
import type { SessionStateRW } from "../renderer-interface/session-state";
import type { Journal } from "./settings-history.js";
import type { Gate } from "../daemon/foundations/validator-registry";
import { BadVerbArgs } from "../daemon/foundations/verb-error";
import type { SessionId } from "../daemon/foundations/session-id";

// [LAW:types-are-the-program] A complete view of the configured menu keys.
// An absent key follows its config default. Config-authored disclosures and
// page cursors use the same representation as built-in menus.
export interface MenuContext {
  readonly gate: Gate;
}

export type EndedVisits = ReadonlyMap<SessionId, Visit>;
type Move = Extract<NavigationWrite, { kind: "navigate" }>;

// [LAW:types-are-the-program] A closed edit's steps are never destinations,
// by construction: edit mode's state lives only in its open edit, so no view
// outside it holds the value such a step went to.
// [LAW:single-enforcer] The search supplies both Back and its displayed
// depth. An overwritten control or an invalid destination skips its visit.
function previous(
  timeline: Timeline,
  store: Pick<SessionStateRW, "get">,
  sid: SessionId,
  { gate }: MenuContext,
) {
  const discard: number[] = [];
  const values = new Map<string, string | null>();
  const valueOf = (key: string) => {
    if (!values.has(key))
      values.set(key, gate.hasKey(key) ? store.get(sid, key) : null);
    return values.get(key) ?? null;
  };
  let destination: Visit | undefined;
  let depth = 0;
  for (let i = timeline.cursor - 1; i >= 0; i--) {
    const visit = timeline.visits[i]!;
    if (
      !visit.every(
        ({ key, from, to }) =>
          valueOf(key) === to && (from === null || gate.validate(key, from).ok),
      )
    ) {
      discard.push(i);
      continue;
    }
    for (const change of visit) values.set(change.key, change.from);
    destination ??= visit;
    depth++;
  }
  return { destination, depth, discard };
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
  visits(): EndedVisits;
  proposed(): readonly NavigationWrite[];
  commit(alreadyCommitted?: boolean): EndedVisits;
}

export class NavigationHistory {
  private readonly timelines = observable.map<SessionId, Timeline>(undefined, {
    deep: false,
  });

  private readonly pending: Move[] = [];
  private readonly prior = new Map<SessionId, Timeline>();

  constructor(
    private readonly shared = false,
    initial: Readonly<Record<SessionId, Timeline>> = {},
  ) {
    runInAction(() => {
      for (const [id, timeline] of Object.entries(initial))
        this.install(id as SessionId, timeline);
    });
  }

  drain(): NavigationWrite[] {
    return this.pending.splice(0);
  }
  beginInput(): void {
    this.prior.clear();
  }
  beforeCommit(sid: SessionId): Timeline {
    return this.prior.get(sid) ?? this.timelines.get(sid) ?? EMPTY_TIMELINE;
  }
  observe(sid: SessionId, timeline: Timeline): void {
    this.prior.delete(sid);
    this.install(sid, timeline);
  }

  private install(sid: SessionId, timeline: Timeline): void {
    if (timeline.visits.length) this.timelines.set(sid, timeline);
    else this.timelines.delete(sid);
  }

  depth(
    sessionId: SessionId,
    store: Pick<SessionStateRW, "get">,
    context: MenuContext,
  ): number {
    const timeline = this.timelines.get(sessionId);
    return timeline === undefined || timeline.cursor === 0
      ? 0
      : previous(timeline, store, sessionId, context).depth;
  }

  // [LAW:no-ambient-temporal-coupling] The transition and its navigation
  // cursor are staged alongside the click's settings. A guarded write that
  // does not land publishes neither.
  begin(
    journal: Pick<Journal, "sessionState" | "changesSince">,
    choose: SessionStateRW["setBatch"],
  ): NavigationTurn {
    const store = journal.sessionState;
    const before = new Map<
      SessionId,
      {
        readonly changes: ReturnType<Journal["changesSince"]>;
        readonly context: MenuContext;
      }
    >();
    const next = new Map<SessionId, Timeline>();
    const ended = new Map<SessionId, Visit>();
    const moves: Move[] = [];
    const timelineOf = (sid: SessionId) =>
      next.get(sid) ?? this.timelines.get(sid) ?? EMPTY_TIMELINE;

    const move = (key: SessionId, edit: NavigationEdit) => {
      moves.push({ kind: "navigate", store: "navigation", key, edit });
      next.set(key, navigationAfter(timelineOf(key), edit));
    };
    const endVisit = (sid: SessionId): void => {
      const start = before.get(sid);
      if (start === undefined) return;
      before.delete(sid);
      const changes = start
        .changes()
        .filter(
          ({ key }) => isNavigationKey(key) && start.context.gate.hasKey(key),
        );
      if (!changes.length) return;
      ended.set(sid, changes);
      move(sid, { kind: "visit", changes });
    };
    const visits = () => {
      for (const sid of before.keys()) endVisit(sid);
      return ended;
    };

    return {
      choose: (sid, writes, contextOf) => {
        if (
          !before.has(sid) &&
          writes.some(({ key }) => isNavigationKey(key))
        ) {
          const context = contextOf();
          before.set(sid, { changes: journal.changesSince(sid), context });
        }
        choose(sid, writes);
      },
      back: (sid, context) => {
        endVisit(sid);
        const timeline = timelineOf(sid);
        const { destination, discard } = previous(
          timeline,
          store,
          sid,
          context,
        );
        const discarded = discard.length;
        if (timeline.visits.length)
          move(sid, { kind: "back", at: timeline.cursor, discard });
        if (destination === undefined)
          throw new BadVerbArgs(
            `back: nothing to go back to${discarded > 0 ? ` (${discarded} step(s) over a view since gone, discarded)` : ""}`,
          );
        const writes = destination.map(({ key, from }) => ({
          key,
          value: from,
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
      visits,
      proposed: () => {
        visits();
        return this.shared ? moves : [];
      },
      commit: (alreadyCommitted) => {
        visits();
        if (!this.shared || !alreadyCommitted) this.publish(moves);
        moves.length = 0;
        next.clear();
        return ended;
      },
    };
  }

  // Only the gesture that leaves an edit can add a visit outside it.
  private outside(visits: EndedVisits): Move[] {
    const result: Move[] = [];
    for (const [key, visit] of visits) {
      const changes = visit.filter((change) => !isEditModeKey(change.key));
      if (changes.length)
        result.push({
          kind: "navigate",
          store: "navigation",
          key,
          edit: { kind: "visit", changes },
        });
    }
    return result;
  }

  proposedOutside(visits: EndedVisits): readonly NavigationWrite[] {
    return this.shared ? this.outside(visits) : [];
  }

  landOutsideEdit(visits: EndedVisits, alreadyCommitted?: boolean): void {
    if (!this.shared || !alreadyCommitted) this.publish(this.outside(visits));
  }

  private publish(moves: readonly Move[]): void {
    runInAction(() => {
      for (const move of moves) {
        const before = this.timelines.get(move.key) ?? EMPTY_TIMELINE;
        if (this.shared) {
          if (!this.prior.has(move.key)) this.prior.set(move.key, before);
          this.pending.push(move);
        } else this.timelines.delete(move.key);
        this.install(move.key, navigationAfter(before, move.edit));
      }
      if (!this.shared)
        while (this.timelines.size > MAX_NAVIGATION_SESSIONS)
          this.timelines.delete(this.timelines.keys().next().value!);
    });
  }
}
