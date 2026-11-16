// [LAW:one-source-of-truth] The one undo history over every settings change a
// session makes (brandon-save-undo-bwi.jby). Before it, the only history was
// whole-file snapshots of the config file, so a session pick — the default
// destination of every settings click — could not be undone at all. Now a
// session's history holds whatever its clicks changed, wherever the change
// landed: a session pick, a config-file write, a structural edit, a reset.
//
// A STEP is one click. Its changes are recorded by the Journal the verb table
// opens around every top-level handler (src/renderer/verbs/index.ts), so a
// durable write and the session pick it releases are one step, undone
// together, exactly as they were made together.
//
// Another session's write to a file this session also wrote is not in this
// session's history, and undo never reaches it. Undo and redo apply a change
// only while its target still reads as the state the change promised to step
// from. A target changed since by anything else (another session's click, a
// hand edit) makes every change this session holds for that target
// unreachable, because each of them chains through the state that is gone. So
// the step refuses loudly, applies nothing, and drops those changes from both
// stacks. The session's other changes stay steppable.

import { observable, runInAction } from "mobx";
import { EDIT_MODE_KEY, EDIT_MODE_REF } from "../config/loader/edit-mode";
import type { EditStore } from "./config-file-store";
import { addressText, diffChanges } from "../config/config-changes";
import type { DaemonLogger } from "../utils/logger";
import { recordingView } from "./session-state";
import { type SessionStateRW } from "../renderer-interface/session-state";
import { BadVerbArgs } from "../daemon/foundations/verb-error";
import { type SessionId } from "../daemon/foundations/session-id";
import {
  type HistoryStorage,
  type LoadedHistory,
  type Change,
  type Step,
  type SessionHistory,
  type Savepoint,
  isSettingKey,
} from "../renderer-interface/history-storage";

// What the settings menu shows: how many steps undo and redo can take.
export interface HistoryDepth {
  readonly undo: number;
  readonly redo: number;
  // How many targets differ from when edit mode opened — what `↩ cancel`
  // would put back; 0 when edit mode is closed or nothing differs.
  readonly sinceEdit: number;
}

export const EMPTY_HISTORY_DEPTH: HistoryDepth = {
  undo: 0,
  redo: 0,
  sinceEdit: 0,
};

export const EPHEMERAL_HISTORY_STORAGE: HistoryStorage = {
  load: () => new Map(),
  save: () => {},
};

// [LAW:carrying-cost] A file change holds two whole-file snapshots, so what a
// history costs is its bytes, held in memory and rewritten on every step. It
// is bounded three ways: steps per session, sessions, and total snapshot text.
// Over either shared bound, the session that changed least recently goes
// first; a lone session over the byte bound loses its oldest steps.
const MAX_STEPS = 50;
const MAX_SESSIONS = 32;
const MAX_BYTES = 8 * 1024 * 1024;

const EMPTY: SessionHistory = { past: [], future: [] };

// Records one click's changes. Handlers write through `sessionState` (which
// records settings keys once they are written) and report their config-file
// writes through `file`; `commit` turns what was recorded so far into one
// step and starts the next one empty.
export interface Journal {
  readonly sessionState: SessionStateRW;
  file(
    sessionId: SessionId,
    file: string,
    before: string | null,
    after: string | null,
  ): void;
  commit(): void;
  // A write this journal holds no step for (a history step, the repo book).
  wrote(): void;
  // Whether the click wrote at all, a value it found included, across commits.
  written(): boolean;
}

// A pending change, keyed by what it touched so a click that writes one target
// twice records one change from its first `before` to its last `after`.
type Pending = Map<SessionId, Map<string, Change>>;

type Target =
  | { readonly kind: "session"; readonly key: string }
  | { readonly kind: "file"; readonly file: string };

const identity = (c: Target): string =>
  c.kind === "session" ? `session:${c.key}` : `file:${c.file}`;

export class SettingsHistory {
  // [LAW:no-ambient-temporal-coupling] Observable, so a view's payload over a
  // session's depth (`↶`/`↷`) is recomputed in the turn a step lands — a
  // refused `↶` that drops steps included, which moves no pick. Per key: a
  // whole next state is adopted by `replace`, which keeps its order (the
  // recency) and moves only the sessions whose history changed, so one
  // session's click recomputes no other session's payload.
  private readonly held = observable.map<SessionId, SessionHistory>(undefined, {
    deep: false,
  });
  private get state(): ReadonlyMap<SessionId, SessionHistory> {
    return this.held;
  }
  private set state(next: Map<SessionId, SessionHistory>) {
    runInAction(() => this.held.replace(next));
  }

  // `loaded` is what the storage held, read before the renderer starts.
  constructor(
    private readonly sessionState: SessionStateRW,
    private readonly logger: DaemonLogger,
    private readonly storage: HistoryStorage = EPHEMERAL_HISTORY_STORAGE,
    loaded: LoadedHistory = storage.load(),
  ) {
    this.state = new Map(loaded);
  }

  depth(sessionId: SessionId): HistoryDepth {
    const { past, future, savepoint } = this.state.get(sessionId) ?? EMPTY;
    return {
      undo: past.length,
      redo: future.length,
      sinceEdit: savepoint?.net.length ?? 0,
    };
  }

  history(sessionId: SessionId): SessionHistory {
    return this.state.get(sessionId) ?? EMPTY;
  }

  begin(): Journal {
    const pending: Pending = new Map();
    let written = false;
    const note = (sessionId: SessionId, change: Change): void => {
      written = true;
      const changes = pending.get(sessionId) ?? new Map<string, Change>();
      const earlier = changes.get(identity(change));
      changes.set(
        identity(change),
        earlier === undefined ? change : { ...change, before: earlier.before },
      );
      pending.set(sessionId, changes);
    };
    // [LAW:single-enforcer] Edit mode opening and closing is observed HERE,
    // on the one write path every click takes, so the savepoint is taken and
    // released by whichever control moved the key — `✎ arrange`, a
    // hand-authored toggle, `✓ save`, `↩ cancel` — and no control has to
    // remember to. The key itself is navigation, never a step.
    const toggles = new Map<SessionId, EditToggle>();
    const sessionState = recordingView(
      this.sessionState,
      // Every key, since a write of any can move a lane: only settings are steps.
      () => true,
      (sessionId, key, before, after) => {
        written = true;
        if (!isSettingKey(key) && key !== EDIT_MODE_KEY) return;
        if (key === EDIT_MODE_KEY) {
          const earlier = toggles.get(sessionId);
          toggles.set(sessionId, {
            before: earlier === undefined ? before : earlier.before,
            after,
          });
          return;
        }
        note(sessionId, { kind: "session", key, before, after });
      },
    );
    return {
      sessionState,
      file: (sessionId, file, before, after) =>
        note(sessionId, { kind: "file", file, before, after }),
      wrote: () => {
        written = true;
      },
      written: () => written,
      commit: () => {
        // Handed off before it is saved, so a save that fails is reported by
        // this commit alone and never recorded again by a later one.
        const committing = new Map(pending);
        const toggled = new Map(toggles);
        pending.clear();
        toggles.clear();
        for (const sessionId of new Set([
          ...committing.keys(),
          ...toggled.keys(),
        ])) {
          // A click that wrote a value already there changed nothing, and a
          // step that changes nothing would be an undo that visibly does
          // nothing.
          const step = [...(committing.get(sessionId)?.values() ?? [])].filter(
            (c) => c.before !== c.after,
          );
          const current = this.history(sessionId);
          // A fresh step abandons whatever was undone. The click's own steps
          // land BEFORE the savepoint a toggle in the same click takes: what
          // opened edit mode is not an edit made in it.
          const appended =
            step.length === 0 ? current : afterAppend(current, step);
          const toggle = toggled.get(sessionId);
          const next =
            toggle === undefined ? appended : withToggle(appended, toggle);
          if (next !== current) this.put(sessionId, next);
        }
      },
    };
  }

  // Returns the step it restored, so the caller can say what changed.
  undo(sessionId: SessionId, files: EditStore): Step {
    const history = this.history(sessionId);
    const step = history.past.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("undo: nothing to undo");
    }
    this.apply(
      sessionId,
      files,
      step,
      "before",
      "undo",
      afterUndo(history, step),
    );
    return step;
  }

  // [LAW:no-silent-failure] Cancel for edit mode: put every target edit mode
  // changed back to what it held when edit mode opened — one step, landing
  // whole or not at all (`apply`) — then give the stack back the shape it had,
  // with nothing to redo, so neither `↶` nor `↷` can bring back what was
  // discarded. A target changed since by anything else (a hand edit, another
  // session) is not put back: overwriting it would destroy that change, and no
  // later cancel could put it back either. Every other target is, and then the
  // refusal names what was kept, loudly. Edit mode stays where it is — the
  // click that cancels also leaves — so the savepoint is taken again at the
  // stack as it now stands. Returns what it put back.
  rewind(sessionId: SessionId, files: EditStore): Step {
    const history = this.history(sessionId);
    const { savepoint } = history;
    if (savepoint === undefined) {
      throw new BadVerbArgs(
        "rewind: edit mode has no savepoint — nothing to cancel",
      );
    }
    const stale = savepoint.net.filter(
      (c) => this.read(sessionId, files, c) !== c.after,
    );
    const gone = new Set(stale.map(identity));
    const putBack = savepoint.net.filter((c) => !gone.has(identity(c)));
    const past = capped(without(pastAt(history, savepoint), gone));
    this.apply(sessionId, files, putBack, "before", "rewind", {
      past,
      future: [],
      savepoint: { at: past.length, net: [], below: [] },
    });
    if (stale.length > 0) {
      throw new BadVerbArgs(
        `rewind: ${stale.map(describe).join(", ")} changed since edit mode opened — kept as it is; everything else edit mode changed was put back`,
      );
    }
    return putBack;
  }

  redo(sessionId: SessionId, files: EditStore): Step {
    const history = this.history(sessionId);
    const { past, future } = history;
    const step = future.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("redo: nothing to redo");
    }
    const all = [...past, step];
    const kept = capped(all);
    this.apply(sessionId, files, step, "after", "redo", {
      past: kept,
      future: future.slice(0, -1),
      ...savepointAfter(history.savepoint, all.length - kept.length, step),
    });
    return step;
  }

  // [LAW:no-silent-failure] A step lands whole, together with the history
  // that records it, or not at all: every change is checked before any is
  // written, and a failure while writing it or saving `then` puts back what
  // was already written before the error goes on. A stale target is refused
  // by name, naming the settings that moved in a file, and its now-unreachable
  // changes leave both stacks (see the header). A file's change is the
  // click's to land (`land`), so the host writes it.
  private apply(
    sessionId: SessionId,
    files: EditStore,
    step: Step,
    to: "before" | "after",
    verb: "undo" | "redo" | "rewind",
    then: SessionHistory,
  ): void {
    const from = to === "before" ? "after" : "before";
    const stale = step.flatMap((c) => {
      const now = this.read(sessionId, files, c);
      return now === c[from] ? [] : [c];
    });
    if (stale.length > 0) {
      this.forget(sessionId, new Set(stale.map(identity)));
      throw new BadVerbArgs(
        `${verb}: ${stale.map((c) => describeMoved(c, c[from], this.read(sessionId, files, c))).join(", ")} changed since that edit — refusing to overwrite it; this session's undo history no longer steps it`,
      );
    }
    const written: Change[] = [];
    try {
      for (const change of step) {
        this.write(sessionId, files, change, change[from], change[to]);
        written.push(change);
      }
      this.put(sessionId, then);
    } catch (e) {
      try {
        for (const change of written.reverse()) {
          this.write(sessionId, files, change, change[to], change[from]);
        }
      } catch (restoring) {
        throw new Error(
          `${(e as Error).message}; and putting the step back failed, so it is half-applied: ${(restoring as Error).message}`,
        );
      }
      throw e;
    }
  }

  // [LAW:single-enforcer] A file this session's change did not land in (the
  // host refused it, or could not write it): its history no longer chains
  // through that file, so every change it holds for the file leaves both
  // stacks, as a stale target's does.
  forgetFile(sessionId: SessionId, file: string): void {
    this.forget(sessionId, new Set([identity({ kind: "file", file })]));
  }

  // Every change to the targets `gone` names leaves both stacks. Edit mode's
  // net change forgets those targets too: putting them back would overwrite
  // whatever changed them.
  private forget(sessionId: SessionId, gone: ReadonlySet<string>): void {
    const { past, future, savepoint } = this.history(sessionId);
    this.put(sessionId, {
      past: without(past, gone),
      future: without(future, gone),
      ...(savepoint !== undefined && {
        savepoint: {
          // A step left empty leaves the stack, so the position counts the
          // steps below it that survive.
          at: without(
            [...past, ...[...future].reverse()].slice(0, savepoint.at),
            gone,
          ).length,
          net: savepoint.net.filter((c) => !gone.has(identity(c))),
          below: without(savepoint.below, gone),
        },
      }),
    });
  }

  private read(
    sessionId: SessionId,
    files: EditStore,
    change: Change,
  ): string | null {
    return change.kind === "session"
      ? this.sessionState.get(sessionId, change.key)
      : files.read(change.file);
  }

  private write(
    sessionId: SessionId,
    files: EditStore,
    change: Change,
    from: string | null,
    to: string | null,
  ): void {
    if (change.kind === "file") {
      files.land(change.file, from, to);
    } else if (to === null) {
      this.sessionState.clear(sessionId, change.key);
    } else {
      this.sessionState.set(sessionId, change.key, to);
    }
  }

  // Move-to-end keeps insertion order as recency, so the bounds drop the
  // session that changed least recently. The new state is adopted only once
  // it is saved, so memory never holds a step the file could not.
  private put(sessionId: SessionId, history: SessionHistory): void {
    const next = new Map(this.state);
    next.delete(sessionId);
    if (
      history.past.length > 0 ||
      history.future.length > 0 ||
      history.savepoint !== undefined
    ) {
      next.set(sessionId, history);
    }
    while (next.size > MAX_SESSIONS || weight(next) > MAX_BYTES) {
      const [oldest, h] = next.entries().next().value!;
      if (next.size > 1) next.delete(oldest);
      else if (h.past.length + h.future.length > 0) {
        next.set(oldest, withoutOldestStep(h));
      } else {
        // [LAW:no-silent-failure] Edit mode's net change alone is over the
        // bound: the savepoint goes, and with it cancel, said here.
        this.logger(
          "warn",
          `settings-history: edit mode's changes for session ${oldest} exceed ${MAX_BYTES} bytes; cancel is no longer available`,
        );
        next.delete(oldest);
      }
    }
    this.storage.save(Object.fromEntries(next));
    this.state = next;
  }
}

function weight(state: ReadonlyMap<SessionId, SessionHistory>): number {
  let bytes = 0;
  for (const { past, future, savepoint } of state.values()) {
    for (const step of [
      ...past,
      ...future,
      ...(savepoint === undefined ? [] : [savepoint.net, ...savepoint.below]),
    ]) {
      for (const c of step) {
        bytes += (c.before?.length ?? 0) + (c.after?.length ?? 0);
      }
    }
  }
  return bytes;
}

function withoutOldestStep({
  past,
  future,
  savepoint,
}: SessionHistory): SessionHistory {
  return past.length > 0
    ? { past: past.slice(1), future, ...savepointAfter(savepoint, 1, []) }
    : { past, future: future.slice(1), ...savepointAfter(savepoint, 0, []) };
}

function capped(steps: readonly Step[]): readonly Step[] {
  return steps.slice(-MAX_STEPS);
}

// ─── The savepoint ──────────────────────────────────────────────────────────

// What a click did to the edit-mode key: the value it held before and after.
interface EditToggle {
  readonly before: string | null;
  readonly after: string | null;
}

// [LAW:one-source-of-truth] Open is the member edit mode's own disclosure ref
// names — the reading every edit-mode gate gives the key.
const isOpen = (value: string | null): boolean =>
  value === EDIT_MODE_REF.member;

// The savepoint after a step landed and `dropped` steps left the front of
// `past`: its position moves down with them (never below the front), and the
// step joins its net change.
function savepointAfter(
  savepoint: Savepoint | undefined,
  dropped: number,
  step: Step,
): { readonly savepoint?: Savepoint } {
  return savepoint === undefined
    ? {}
    : {
        savepoint: {
          at: Math.max(0, savepoint.at - dropped),
          net: withNet(savepoint.net, step),
          below: savepoint.below,
        },
      };
}

// [LAW:dataflow-not-control-flow] A target's net change keeps the value it
// held when edit mode opened and takes each later value; one that is back
// where it started differs from nothing, so it leaves.
function withNet(net: Step, step: Step): Step {
  const byTarget = new Map(net.map((c) => [identity(c), c] as const));
  for (const c of step) {
    const first = byTarget.get(identity(c));
    byTarget.set(
      identity(c),
      first === undefined ? c : { ...first, after: c.after },
    );
  }
  return [...byTarget.values()].filter((c) => c.before !== c.after);
}

// A step applied backwards is the change from its `after` to its `before`.
const reversed = (step: Step): Step =>
  step.map((c) => ({ ...c, before: c.after, after: c.before }));

// A fresh step abandons whatever was undone. Steps from before edit mode
// among them are kept in the savepoint's `below`, so a cancel can still give
// the stack back the shape it had; the savepoint now stands at the top of
// what is left of `past`.
function afterAppend(history: SessionHistory, step: Step): SessionHistory {
  const all = [...history.past, step];
  const past = capped(all);
  const { savepoint } = history;
  const abandonedBelow =
    savepoint === undefined
      ? 0
      : Math.max(0, savepoint.at - history.past.length);
  return {
    past,
    future: [],
    ...savepointAfter(
      savepoint && {
        at: Math.min(savepoint.at, history.past.length),
        net: savepoint.net,
        below: [...redone(history.future, abandonedBelow), ...savepoint.below],
      },
      all.length - past.length,
      step,
    ),
  };
}

// The next `count` steps `↷` would take, in the order it would take them.
function redone(future: readonly Step[], count: number): Step[] {
  const n = Math.min(count, future.length);
  return future.slice(future.length - n).reverse();
}

function afterUndo(history: SessionHistory, step: Step): SessionHistory {
  return {
    past: history.past.slice(0, -1),
    future: capped([...history.future, step]),
    ...savepointAfter(history.savepoint, 0, reversed(step)),
  };
}

// The stack as it stood when edit mode opened: the steps made since leave,
// and the steps `↶` took back below it — still on the redo stack, or kept in
// `below` once a fresh step abandoned them — are past again.
function pastAt(history: SessionHistory, savepoint: Savepoint): Step[] {
  const { past, future } = history;
  const kept = past.slice(0, savepoint.at);
  return [
    ...kept,
    ...redone(future, savepoint.at - kept.length),
    ...savepoint.below,
  ];
}

// Opening takes the savepoint at the stack as it stands; closing releases it.
function withToggle(
  history: SessionHistory,
  toggle: EditToggle,
): SessionHistory {
  if (isOpen(toggle.after) && !isOpen(toggle.before)) {
    return {
      ...history,
      savepoint: { at: history.past.length, net: [], below: [] },
    };
  }
  if (!isOpen(toggle.after) && isOpen(toggle.before)) {
    const { past, future } = history;
    return { past, future };
  }
  return history;
}

function without(steps: readonly Step[], gone: ReadonlySet<string>): Step[] {
  return steps
    .map((step) => step.filter((c) => !gone.has(identity(c))))
    .filter((step) => step.length > 0);
}

export function describeStep(step: Step): string {
  return step.map(describe).join(", ");
}

function describe(change: Change): string {
  return change.kind === "session"
    ? `session setting "${change.key}"`
    : change.file;
}

// A stale target as its refusal names it: a file by the settings in it that
// moved from what the step expected.
function describeMoved(
  change: Change,
  expected: string | null,
  now: string | null,
): string {
  if (change.kind === "session") return describe(change);
  const moved = diffChanges(expected, now).map((c) => addressText(c.at));
  return `${moved.join(", ")} in ${change.file}`;
}
