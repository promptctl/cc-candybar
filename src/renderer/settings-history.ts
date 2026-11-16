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
// from: a session pick is checked here, and a file's settings by the host,
// which refuses a change whose setting moved (src/config/config-changes.ts).
// A target changed since by anything else (another session's click, a hand
// edit) makes every change this session holds for that target unreachable,
// because each of them chains through the state that is gone. So the step
// refuses loudly, applies nothing, and drops those changes from both stacks.
// The session's other changes stay steppable.
//
// [LAW:no-ambient-temporal-coupling] A click lands whole or not at all. Its
// session writes are held in its journal, which it reads its own through, and
// its config writes are changes the host performs after its turn. The
// journal's commit is the click's consequence: the held writes reach the store
// and the history moves together. It runs once the click's changes land, or
// at once for a click that made none, and never for a click whose changes the
// host refused.

import { observable, runInAction } from "mobx";
import { EDIT_MODE_KEY, EDIT_MODE_REF } from "../config/loader/edit-mode";
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

// Where a click's config writes go: changes its turn returns
// (src/renderer/config-writes.ts).
export interface ConfigFiles {
  land(file: string, before: string | null, after: string | null): void;
}

// Records one click's changes. Handlers write through `sessionState` (which
// records settings keys once they are written, and holds every write until
// `commit`) and report their config-file writes through `file`. `undo`,
// `redo` and `rewind` step the session's history in the same click, each
// first making what the click changed so far a step of its own, so one click
// behaves exactly as the same clicks made one at a time; each returns the
// step it restored. `commit` is the click's consequence.
export interface Journal {
  readonly sessionState: SessionStateRW;
  file(
    sessionId: SessionId,
    file: string,
    before: string | null,
    after: string,
  ): void;
  undo(sessionId: SessionId): Step;
  redo(sessionId: SessionId): Step;
  rewind(sessionId: SessionId): Step;
  commit(): void;
  // A write this journal holds no step for (a history step, the repo book).
  wrote(): void;
  // Whether the click wrote at all, a value it found included, across commits.
  written(): boolean;
}

// A pending change, keyed by what it touched so a click that writes one target
// twice records one change from its first `before` to its last `after`.
type Pending = Map<SessionId, Map<string, Change>>;

const identity = (c: Change): string =>
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

  begin(files: ConfigFiles): Journal {
    const held = heldWrites(this.sessionState);
    // Each session's history as this click leaves it.
    const working = new Map<SessionId, SessionHistory>();
    const click: Click = {
      held,
      files,
      historyOf: (sessionId) =>
        working.get(sessionId) ?? this.history(sessionId),
      move: (sessionId, history) => working.set(sessionId, history),
    };
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
      held,
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
    // What the click changed so far, as one step of its history.
    const step = (): void => {
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
        const changes = [...(committing.get(sessionId)?.values() ?? [])].filter(
          (c) => c.before !== c.after,
        );
        const current = click.historyOf(sessionId);
        // A fresh step abandons whatever was undone. The click's own steps
        // land BEFORE the savepoint a toggle in the same click takes: what
        // opened edit mode is not an edit made in it.
        const appended =
          changes.length === 0 ? current : afterAppend(current, changes);
        const toggle = toggled.get(sessionId);
        const next =
          toggle === undefined ? appended : withToggle(appended, toggle);
        if (next !== current) click.move(sessionId, next);
      }
    };
    return {
      sessionState,
      file: (sessionId, file, before, after) => {
        note(sessionId, { kind: "file", file, before, after });
        files.land(file, before, after);
      },
      wrote: () => {
        written = true;
      },
      written: () => written,
      undo: (sessionId) => {
        step();
        return this.undo(click, sessionId);
      },
      redo: (sessionId) => {
        step();
        return this.redo(click, sessionId);
      },
      rewind: (sessionId) => {
        step();
        return this.rewind(click, sessionId);
      },
      commit: () => {
        step();
        // Handed off before it is saved, so a save that fails is reported by
        // this commit alone and never recorded again by a later one.
        const moved = new Map(working);
        working.clear();
        // [LAW:no-ambient-temporal-coupling] The step is saved before the
        // session's writes are applied: the save is what can fail, and a
        // click whose step was not saved applies nothing of its own.
        for (const [sessionId, history] of moved) this.put(sessionId, history);
        held.flush();
      },
    };
  }

  private undo(click: Click, sessionId: SessionId): Step {
    const history = click.historyOf(sessionId);
    const step = history.past.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("undo: nothing to undo");
    }
    this.apply(
      click,
      sessionId,
      step,
      "before",
      "undo",
      afterUndo(history, step),
    );
    return step;
  }

  // [LAW:no-silent-failure] Cancel for edit mode: put every target edit mode
  // changed back to what it held when edit mode opened — one step, landing
  // whole or not at all — then give the stack back the shape it had, with
  // nothing to redo, so neither `↶` nor `↷` can bring back what was discarded.
  // A session pick changed since by anything else is not put back:
  // overwriting it would destroy that change, and no later cancel could put it
  // back either. Every other target is, and then the refusal names what was
  // kept, loudly. A file's settings are the host's to check, and a refusal
  // there refuses the whole cancel. Edit mode stays where it is — the click
  // that cancels also leaves — so the savepoint is taken again at the stack as
  // it now stands. Returns what it put back.
  private rewind(click: Click, sessionId: SessionId): Step {
    const history = click.historyOf(sessionId);
    const { savepoint } = history;
    if (savepoint === undefined) {
      throw new BadVerbArgs(
        "rewind: edit mode has no savepoint — nothing to cancel",
      );
    }
    const stale = savepoint.net.filter((c) =>
      moved(click, sessionId, c, "after"),
    );
    const gone = new Set(stale.map(identity));
    const putBack = savepoint.net.filter((c) => !gone.has(identity(c)));
    const past = capped(without(pastAt(history, savepoint), gone));
    this.apply(click, sessionId, putBack, "before", "rewind", {
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

  private redo(click: Click, sessionId: SessionId): Step {
    const history = click.historyOf(sessionId);
    const { past, future } = history;
    const step = future.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("redo: nothing to redo");
    }
    const all = [...past, step];
    const kept = capped(all);
    this.apply(click, sessionId, step, "after", "redo", {
      past: kept,
      future: future.slice(0, -1),
      ...savepointAfter(history.savepoint, all.length - kept.length, step),
    });
    return step;
  }

  // [LAW:no-silent-failure] A step is refused whole when a session pick it
  // steps has moved: the pick is named, and its now-unreachable changes leave
  // both stacks (see the header). Otherwise each pick is written through the
  // click, and each file's step is a change the click returns, from what the
  // step recorded, so the host refuses it when a setting in it moved.
  private apply(
    click: Click,
    sessionId: SessionId,
    step: Step,
    to: "before" | "after",
    verb: "undo" | "redo" | "rewind",
    then: SessionHistory,
  ): void {
    const from = to === "before" ? "after" : "before";
    const stale = step.filter((c) => moved(click, sessionId, c, from));
    if (stale.length > 0) {
      click.move(
        sessionId,
        forgotten(click.historyOf(sessionId), new Set(stale.map(identity))),
      );
      throw new BadVerbArgs(
        `${verb}: ${stale.map(describe).join(", ")} changed since that edit — refusing to overwrite it; this session's undo history no longer steps it`,
      );
    }
    for (const change of step) {
      const value = change[to];
      if (change.kind === "file")
        click.files.land(change.file, change[from], value);
      else if (value === null) click.held.clear(sessionId, change.key);
      else click.held.set(sessionId, change.key, value);
    }
    click.move(sessionId, then);
  }

  // [LAW:single-enforcer] A file a change of this session's did not land in
  // (the host refused it, or could not write it): its history no longer
  // chains through that file, so every change it holds for the file leaves
  // both stacks, as a stale target's does.
  forgetFile(sessionId: SessionId, file: string): void {
    this.put(
      sessionId,
      forgotten(this.history(sessionId), new Set([`file:${file}`])),
    );
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

// ─── A click ─────────────────────────────────────────────────────────────────

// What a click steps its history through: the session writes it holds, the
// files its changes go to, and each session's history as the click leaves it.
interface Click {
  readonly held: SessionStateRW;
  readonly files: ConfigFiles;
  readonly historyOf: (sessionId: SessionId) => SessionHistory;
  readonly move: (sessionId: SessionId, history: SessionHistory) => void;
}

// A session pick that no longer holds the value a step would step from. A
// file's settings are the host's to check, as its change lands.
function moved(
  click: Click,
  sessionId: SessionId,
  change: Change,
  from: "before" | "after",
): boolean {
  return (
    change.kind === "session" &&
    click.held.get(sessionId, change.key) !== change[from]
  );
}

// The history with every change to the targets `gone` names gone from both
// stacks. Edit mode's net change forgets those targets too: putting them back
// would overwrite whatever changed them.
function forgotten(
  { past, future, savepoint }: SessionHistory,
  gone: ReadonlySet<string>,
): SessionHistory {
  return {
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
  };
}

// [LAW:no-ambient-temporal-coupling] A click's session writes, held over the
// store until its consequence lands (`flush`): nothing outside the click sees
// a write whose click may not land, and the click reads its own.
function heldWrites(
  store: SessionStateRW,
): SessionStateRW & { readonly flush: () => void } {
  const held = new Map<SessionId, Map<string, string | null>>();
  const put = (sessionId: SessionId, key: string, value: string | null) => {
    const writes = held.get(sessionId) ?? new Map<string, string | null>();
    writes.set(key, value);
    held.set(sessionId, writes);
  };
  return {
    get: (sessionId, key) => {
      const writes = held.get(sessionId);
      return writes?.has(key) ? writes.get(key)! : store.get(sessionId, key);
    },
    revision: (sessionId) => store.revision(sessionId),
    set: (sessionId, key, value) => put(sessionId, key, value),
    setBatch: (sessionId, pairs) => {
      for (const { key, value } of pairs) put(sessionId, key, value);
    },
    clear: (sessionId, key) => put(sessionId, key, null),
    // One transaction, so no observer sees half a click.
    flush: () =>
      runInAction(() => {
        for (const [sessionId, writes] of held) {
          const sets = [...writes].flatMap(([key, value]) =>
            value === null ? [] : [{ key, value }],
          );
          if (sets.length > 0) store.setBatch(sessionId, sets);
          for (const [key, value] of writes)
            if (value === null) store.clear(sessionId, key);
        }
        held.clear();
      }),
  };
}
