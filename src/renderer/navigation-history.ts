// [LAW:one-source-of-truth] The one back history over what a session has OPEN:
// its menu, tab, pickers, page cursors, edit mode and the placement it
// configures. It is the settings history's twin (src/renderer/settings-history.ts)
// over the keys that one deliberately leaves out, so `↶` steps what a session
// SET and `◁` steps what it LOOKED AT, and neither can reach the other's keys.
//
// A STEP is one navigating click: what the `set-state`, `step-state` and
// toolbar verbs wrote to navigation keys (isNavigationKey). Those three verbs are the
// navigating ones by construction — they are how every disclosure, cursor and
// mode click lands — while the session keys other paths write (a doctor
// report, a click's error, the client's own hints) never pass through them.
// `back` writes each change's `before`; the history is held in memory only, so
// a daemon restart starts every session with nothing to go back to.

import { isConfirmKey } from "../config/confirm-step";
import { isSettingKey } from "../renderer-interface/history-storage";
import { UPDATE_DISMISSED_KEY } from "../daemon/foundations/update-keys";
import { DIAGNOSTICS_VIEWING } from "../config/door";
import { observable, runInAction } from "mobx";
import { recordingView } from "./session-state";
import { type SessionStateRW } from "../renderer-interface/session-state";
import type { Gate } from "../daemon/foundations/validator-registry";
import { BadVerbArgs } from "../daemon/foundations/verb-error";
import type { SessionId } from "../daemon/foundations/session-id";
import type { Owner } from "../config/placement-keys";

export interface NavigationChange {
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
}

export type NavigationStep = readonly NavigationChange[];

// [LAW:carrying-cost] Bounded per session and in sessions; over the session
// bound, the session that navigated least recently goes first.
const MAX_STEPS = 20;
const MAX_SESSIONS = 32;

// [LAW:one-source-of-truth] The keys going back restores: everything those
// verbs write except a DECISION — a setting (undo's), a dismissed update
// notice, or a confirm's arming, which would come back one click from firing —
// and the diagnostics viewer, which is paged and closed by its own ‹ › ✕, so
// a step through the messages never fills the history ◁ walks.
const isNavigationKey = (key: string): boolean =>
  !isSettingKey(key) &&
  !isConfirmKey(key) &&
  key !== UPDATE_DISMISSED_KEY &&
  key !== DIAGNOSTICS_VIEWING;

// Records one click's navigation. Writes through `sessionState` land in the
// store it wraps and are recorded; `commit` turns them into one step.
export interface NavigationJournal {
  readonly sessionState: SessionStateRW;
  commit(): void;
}

// A step, and the chain the session rendered from when it was made
// (src/config/placement-keys.ts): its keys name that chain's placements in
// their owner-free form, so in any other chain the view it was made over is
// gone. Null for a session with no config.
interface Made {
  readonly owner: Owner | null;
  readonly step: NavigationStep;
}

export class NavigationHistory {
  // Observable, so a view's payload over a session's depth (`◁`) is
  // recomputed in the turn a step lands.
  private readonly past = observable.map<SessionId, readonly Made[]>(
    undefined,
    { deep: false },
  );

  // [LAW:one-source-of-truth] How many clicks on `◁` restore something — the
  // walk `back` itself makes, so the count cannot promise a step it discards.
  depth(
    sessionId: SessionId,
    store: SessionStateRW,
    gate: Gate,
    owner: Owner,
  ): number {
    return this.restorable(sessionId, store, gate, owner).length;
  }

  // The steps going back would restore, oldest first: walking down from the
  // newest over the state as each restore would leave it, a step is restored
  // while every key it changed still holds what it left there and every value
  // it would write back passes `gate` — the session's config's, as it reads
  // now — and it was made in the chain `owner` names. Any other step is over a
  // view that is gone — rewritten since (a layout edit releasing the placement
  // it configured), or no longer one the config admits (that placement
  // removed, a group renamed, another chain's ✚ that shares the id) — and is
  // discarded rather than replayed.
  private restorable(
    sessionId: SessionId,
    store: SessionStateRW,
    gate: Gate,
    owner: Owner,
  ): readonly Made[] {
    const state = new Map<string, string | null>();
    const read = (key: string): string | null =>
      state.has(key) ? state.get(key)! : store.get(sessionId, key);
    const kept: Made[] = [];
    for (const made of [...(this.past.get(sessionId) ?? [])].reverse()) {
      const { step } = made;
      const holds =
        made.owner === owner &&
        step.every(
          (c) =>
            read(c.key) === c.after &&
            (c.before === null || gate.validate(c.key, c.before).ok),
        );
      if (!holds) continue;
      kept.unshift(made);
      for (const c of step) state.set(c.key, c.before);
    }
    return kept;
  }

  // `store` is the click's own view of session state — the settings journal's,
  // so a navigating click that also picks a setting still records the pick
  // where undo reaches it.
  begin(store: SessionStateRW, owner: Owner | null): NavigationJournal {
    // Keyed by session, then key: a click that writes one key twice records
    // one change from its first `before` to its last `after`.
    const pending = new Map<SessionId, Map<string, NavigationChange>>();
    const sessionState = recordingView(
      store,
      isNavigationKey,
      (sessionId, key, before, after) => {
        const changes = pending.get(sessionId) ?? new Map();
        const first: NavigationChange | undefined = changes.get(key);
        changes.set(key, { key, before: first ? first.before : before, after });
        pending.set(sessionId, changes);
      },
    );
    return {
      sessionState,
      commit: () => {
        for (const [sessionId, changes] of pending) {
          // A click that changed nothing on screen is no step: going back
          // over it would visibly do nothing.
          const step = [...changes.values()].filter(
            (c) => c.before !== c.after,
          );
          if (step.length > 0) this.push(sessionId, { owner, step });
        }
        pending.clear();
      },
    };
  }

  // Restores the newest restorable step into `store` as one transaction and
  // returns it, with how many steps it discarded (restorable). Written through
  // the bare store, never a navigation journal, so going back is not itself a
  // step.
  back(
    sessionId: SessionId,
    store: SessionStateRW,
    gate: Gate,
    owner: Owner,
  ): { readonly step: NavigationStep; readonly discarded: number } {
    const all = this.past.get(sessionId) ?? [];
    const steps = this.restorable(sessionId, store, gate, owner);
    const step = steps.at(-1)?.step;
    const discarded = all.length - steps.length;
    if (step === undefined) {
      this.put(sessionId, steps);
      throw new BadVerbArgs(
        `back: nothing to go back to${discarded > 0 ? ` (${discarded} step(s) over a view since gone, discarded)` : ""}`,
      );
    }
    // [LAW:no-ambient-temporal-coupling] One reactive transaction: no
    // observer sees the door reopened with its tab still folded.
    runInAction(() => {
      const restored = step.flatMap(({ key, before }) =>
        before === null ? [] : [{ key, value: before }],
      );
      if (restored.length > 0) store.setBatch(sessionId, restored);
      for (const { key, before } of step) {
        if (before === null) store.clear(sessionId, key);
      }
    });
    this.put(sessionId, steps.slice(0, -1));
    return { step, discarded };
  }

  private push(sessionId: SessionId, made: Made): void {
    const steps = this.past.get(sessionId) ?? [];
    this.put(sessionId, [...steps, made].slice(-MAX_STEPS));
  }

  // Move-to-end keeps insertion order as recency.
  private put(sessionId: SessionId, steps: readonly Made[]): void {
    runInAction(() => {
      this.past.delete(sessionId);
      if (steps.length > 0) this.past.set(sessionId, steps);
      while (this.past.size > MAX_SESSIONS) {
        this.past.delete(this.past.keys().next().value!);
      }
    });
  }
}
