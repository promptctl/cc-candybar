// [LAW:one-source-of-truth] The one back history over what a session has OPEN:
// its menu, tab, pickers, page cursors, edit mode and the placement it
// configures. It is the settings history's twin (src/daemon/settings-history.ts)
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
import { isSettingKey } from "./settings-history";
import { UPDATE_DISMISSED_KEY } from "./update-notice";
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

// [LAW:one-source-of-truth] The keys going back restores: everything those
// verbs write except a DECISION — a setting (undo's), a dismissed update
// notice, or a confirm's arming, which would come back one click from firing.
const isNavigationKey = (key: string): boolean =>
  !isSettingKey(key) && !isConfirmKey(key) && key !== UPDATE_DISMISSED_KEY;

// Records one click's navigation. Writes through `sessionState` land in the
// store it wraps and are recorded; `commit` turns them into one step.
export interface NavigationJournal {
  readonly sessionState: SessionStateRW;
  commit(): void;
}

export class NavigationHistory {
  private past: Map<string, readonly NavigationStep[]> = new Map();

  // [LAW:one-source-of-truth] How many steps going back can restore — the
  // stack `back` itself would walk, so `◁` shows exactly while a click on it
  // restores something.
  depth(sessionId: string, store: SessionStateRW): number {
    return this.current(sessionId, store).length;
  }

  // The session's steps, less those on top whose keys something else has
  // since rewritten (a layout edit releasing the placement it configured):
  // restoring one would write over a view that is gone.
  private current(
    sessionId: string,
    store: SessionStateRW,
  ): readonly NavigationStep[] {
    const holds = (step: NavigationStep): boolean =>
      step.every((c) => store.get(sessionId, c.key) === c.after);
    let steps = this.past.get(sessionId) ?? [];
    while (steps.length > 0 && !holds(steps.at(-1)!)) {
      steps = steps.slice(0, -1);
    }
    return steps;
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
        .filter(isNavigationKey)
        .map((key) => ({ key, before: store.get(sessionId, key) }));
      write();
      const changes = pending.get(sessionId) ?? new Map();
      for (const { key, before: b } of before) {
        changes.set(key, {
          key,
          // The key's first `before` in this click, null included.
          before: changes.has(key) ? changes.get(key)!.before : b,
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

  // Restores the last current step into `store` and returns it, with how many
  // stale steps it discarded first. Written through the bare store, never a
  // navigation journal, so going back is not itself a step.
  back(
    sessionId: string,
    store: SessionStateRW,
  ): { readonly step: NavigationStep; readonly discarded: number } {
    const all = this.past.get(sessionId) ?? [];
    const steps = this.current(sessionId, store);
    const discarded = all.length - steps.length;
    const step = steps.at(-1);
    if (step === undefined) {
      this.put(sessionId, steps);
      throw new BadVerbArgs(
        `back: nothing to go back to${discarded > 0 ? ` (${discarded} step(s) over state since rewritten, discarded)` : ""}`,
      );
    }
    for (const { key, before } of step) {
      if (before === null) store.clear(sessionId, key);
      else store.set(sessionId, key, before);
    }
    this.put(sessionId, steps.slice(0, -1));
    return { step, discarded };
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
