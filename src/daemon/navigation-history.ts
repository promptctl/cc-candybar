// [LAW:one-source-of-truth] The one back history over what a session has OPEN:
// its menu, tab, pickers, page cursors, edit mode and the placement it
// configures. It is the settings history's twin (src/daemon/settings-history.ts)
// over the keys that one deliberately leaves out, so `↶` steps what a session
// SET and `◁` steps what it LOOKED AT, and neither can reach the other's keys.
//
// A STEP is one navigating click: what the `set-state`, `step-state` and
// toolbar verbs wrote, less every settings key. Those three verbs are the
// navigating ones by construction — they are how every disclosure, cursor and
// mode click lands — while the session keys other paths write (a doctor
// report, a click's error, the client's own hints) never pass through them.
// `back` writes each change's `before`; the history is held in memory only, so
// a daemon restart starts every session with nothing to go back to.

import { isSettingKey } from "./settings-history";
import type { SessionStateRW } from "./session-state";
import { BadVerbArgs } from "./verb-error";

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

// Records one click's navigation. Writes through `sessionState` land in the
// store it wraps and are recorded; `commit` turns them into one step.
export interface NavigationJournal {
  readonly sessionState: SessionStateRW;
  commit(): void;
}

export class NavigationHistory {
  private past: Map<string, readonly NavigationStep[]> = new Map();

  depth(sessionId: string): number {
    return this.past.get(sessionId)?.length ?? 0;
  }

  // `store` is the click's own view of session state — the settings journal's,
  // so a navigating click that also picks a setting still records the pick
  // where undo reaches it.
  begin(store: SessionStateRW): NavigationJournal {
    // Keyed by session, then key: a click that writes one key twice records
    // one change from its first `before` to its last `after`.
    const pending = new Map<string, Map<string, NavigationChange>>();
    const recorded = (
      sessionId: string,
      keys: readonly string[],
      write: () => void,
    ): void => {
      const before = keys
        .filter((key) => !isSettingKey(key))
        .map((key) => ({ key, before: store.get(sessionId, key) }));
      write();
      const changes = pending.get(sessionId) ?? new Map();
      for (const { key, before: b } of before) {
        changes.set(key, {
          key,
          before: changes.get(key)?.before ?? b,
          after: store.get(sessionId, key),
        });
      }
      pending.set(sessionId, changes);
    };
    return {
      sessionState: {
        get: (sessionId, key) => store.get(sessionId, key),
        set: (sessionId, key, value) =>
          recorded(sessionId, [key], () => store.set(sessionId, key, value)),
        setBatch: (sessionId, pairs) =>
          recorded(
            sessionId,
            pairs.map((p) => p.key),
            () => store.setBatch(sessionId, pairs),
          ),
        clear: (sessionId, key) =>
          recorded(sessionId, [key], () => store.clear(sessionId, key)),
      },
      commit: () => {
        for (const [sessionId, changes] of pending) {
          // A click that changed nothing on screen is no step: going back
          // over it would visibly do nothing.
          const step = [...changes.values()].filter(
            (c) => c.before !== c.after,
          );
          if (step.length > 0) this.push(sessionId, step);
        }
        pending.clear();
      },
    };
  }

  // Restores the last step into `store` and returns it. Written through the
  // bare store, never a navigation journal, so going back is not itself a step.
  back(sessionId: string, store: SessionStateRW): NavigationStep {
    const steps = this.past.get(sessionId) ?? [];
    const step = steps.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("back: nothing to go back to");
    }
    for (const { key, before } of step) {
      if (before === null) store.clear(sessionId, key);
      else store.set(sessionId, key, before);
    }
    this.put(sessionId, steps.slice(0, -1));
    return step;
  }

  private push(sessionId: string, step: NavigationStep): void {
    const steps = this.past.get(sessionId) ?? [];
    this.put(sessionId, [...steps, step].slice(-MAX_STEPS));
  }

  // Move-to-end keeps insertion order as recency.
  private put(sessionId: string, steps: readonly NavigationStep[]): void {
    this.past.delete(sessionId);
    if (steps.length > 0) this.past.set(sessionId, steps);
    while (this.past.size > MAX_SESSIONS) {
      this.past.delete(this.past.keys().next().value!);
    }
  }
}
