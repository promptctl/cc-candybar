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
import type { DaemonLogger } from "../utils/logger";
import { recordingView } from "./session-state";
import { type SessionStateRW } from "../renderer-interface/session-state";
import { BadVerbArgs } from "../daemon/foundations/verb-error";
import { type SessionId } from "../daemon/foundations/session-id";
import {
  type Change,
  type Step,
  type SessionHistory,
  holdsNothing,
  withoutRetiredChanges,
} from "../renderer-interface/history-storage";
import { isUndoStepKey } from "../config/session-key";
import {
  addressText,
  applyChanges,
  diffChanges,
} from "../config/config-changes.js";
import { requireLayerText, type ConfigWrites } from "./config-writes.js";
import { contentOfText, type LayerContent } from "../config/config-snapshot.js";
import type {
  StoredState,
  StoreWrite,
} from "../renderer-interface/stored-state.js";
import { digestOf } from "../utils/plain.js";
import { putNewest, toNewest } from "../utils/recency.js";
import { StoredMoves } from "./stored-moves.js";

// What the settings menu shows: how many steps undo and redo can take.
export interface HistoryDepth {
  readonly undo: number;
  readonly redo: number;
  // How many config files differ from when edit mode opened; 0 when edit
  // mode is closed or none does. Its drafts are the save cell's own count.
  readonly sinceEdit: number;
}

export const EMPTY_HISTORY_DEPTH: HistoryDepth = {
  undo: 0,
  redo: 0,
  sinceEdit: 0,
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
// [LAW:single-enforcer] `prove` is the gate every click's write passes: the
// text loads as the file it is written to, between the files as `read` gives
// them, or the click is refused.
// `roleOf` and `pathOf` name a file of the click's chain by its role and back.
export type ConfigFiles = Pick<
  ConfigWrites,
  "land" | "read" | "roleOf" | "pathOf"
> & {
  readonly prove: (
    file: string,
    text: string | null,
    read: (file: string) => LayerContent,
  ) => void;
};

// Records one click's changes. Handlers write through `sessionState` (which
// records settings keys once they are written, and holds every write until
// `commit`) and report their config-file writes through `file`. `undo`,
// `redo` step the session's history in the same click, each
// first making what the click changed so far a step of its own, so one click
// behaves exactly as the same clicks made one at a time; each returns the
// step it restored. `commit` is the click's consequence.
export interface Journal {
  readonly sessionState: SessionStateRW;
  file(
    sessionId: SessionId,
    file: string,
    before: string | null,
    after: string | null,
  ): void;
  undo(sessionId: SessionId): Step;
  redo(sessionId: SessionId): Step;
  writes(sessionId: SessionId): ReadonlyMap<string, string | null>;
  // [LAW:no-ambient-temporal-coupling] The session writes it landed, handed
  // back as a value, so no reader asks for them after they are gone.
  commit(): ClickWrites;
}

export type ClickWrites = ReadonlyMap<
  SessionId,
  ReadonlyMap<string, string | null>
>;

// A pending change, keyed by what it touched so a click that writes one target
// twice records one change from its first `before` to its last `after`.
type Pending = Map<SessionId, Map<string, Change>>;

const identity = (c: Change): string =>
  c.kind === "session" ? `session:${c.key}` : `layer:${c.role}:${c.digest}`;

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

  private readonly moved = new StoredMoves();

  // `loaded` is what the profile holds, oldest first, as the host handed it
  // in: held to the same bounds as every step that lands.
  constructor(
    private readonly sessionState: SessionStateRW,
    private readonly logger: DaemonLogger,
    loaded: StoredState["history"] = {},
  ) {
    this.adopt(
      new Map(Object.entries(loaded) as Array<[SessionId, SessionHistory]>),
    );
  }

  // A request from the session: it moves to the newest end, so the bounds
  // drop the session idle longest. [LAW:carrying-cost] It runs on every
  // request, so it moves the one entry in place: only that session's readers
  // hear of it, and they find what they read before.
  heard(sessionId: SessionId): void {
    if (runInAction(() => toNewest(this.held, sessionId)))
      this.moved.heard(sessionId);
  }

  // What the host has not yet been told: each session whose history moved, as
  // it now stands (null for one gone) or only its place, in the order they
  // last moved.
  drain(): StoreWrite[] {
    return this.moved.drain(
      (key, moved): StoreWrite =>
        moved === "heard"
          ? { kind: "heard", store: "settings-history", key }
          : {
              kind: "put",
              store: "settings-history",
              key,
              value: this.outliving(key),
            },
    );
  }

  // [LAW:single-enforcer] What the host keeps of a session's history is what
  // a load of its file keeps, so the file never holds a draft's step.
  private outliving(sessionId: SessionId): SessionHistory | null {
    const history = this.state.get(sessionId);
    if (history === undefined) return null;
    const outlives = withoutRetiredChanges(history);
    return outlives.kind === "ok" ? outlives.value.value : null;
  }

  depth(sessionId: SessionId): HistoryDepth {
    const { past, future } = this.history(sessionId);
    return {
      undo: past.length,
      redo: future.length,
      sinceEdit: 0,
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
    const note = (sessionId: SessionId, change: Change): void => {
      const changes = pending.get(sessionId) ?? new Map<string, Change>();
      const earlier = changes.get(identity(change));
      changes.set(
        identity(change),
        earlier === undefined ? change : { ...change, before: earlier.before },
      );
      pending.set(sessionId, changes);
    };
    const sessionState = recordingView(
      held,
      isUndoStepKey,
      (sessionId, key, before, after) => {
        note(sessionId, { kind: "session", key, before, after });
      },
    );
    const step = (): void => {
      for (const [sessionId, pendingChanges] of pending) {
        const changes = [...pendingChanges.values()].filter(
          (c) => c.before !== c.after,
        );
        if (changes.length > 0)
          click.move(sessionId, {
            past: capped([...click.historyOf(sessionId).past, changes]),
            future: [],
          });
      }
      pending.clear();
    };
    return {
      sessionState,
      writes: held.writes,
      file: (sessionId, file, before, after) => {
        note(sessionId, {
          kind: "layer",
          role: files.roleOf(file),
          digest: digestOf(file),
          before,
          after,
        });
        files.land(file, before, after);
      },
      undo: (sessionId) => {
        step();
        return this.undo(click, sessionId);
      },
      redo: (sessionId) => {
        step();
        return this.redo(click, sessionId);
      },
      commit: () => {
        step();
        const moved = new Map(working);
        working.clear();
        for (const [sessionId, history] of moved) this.put(sessionId, history);
        return held.flush();
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
    });
    return step;
  }

  // [LAW:no-silent-failure] A step is refused whole when a target it steps
  // has moved, a session pick or a setting of a file: what moved is named,
  // and the target's now-unreachable changes leave both stacks (see the
  // header). Otherwise each pick is written through the click, and each file
  // is written as the changes between the texts the step recorded, applied
  // over the file as the click reads it, so a write to another setting of the
  // file never stops it. [LAW:single-enforcer] That text has not been loaded
  // by anyone, so it passes the gate every click's write passes before it
  // lands.
  private apply(
    click: Click,
    sessionId: SessionId,
    step: Step,
    to: "before" | "after",
    verb: "undo" | "redo",
    then: SessionHistory,
  ): void {
    const stepped = step.map((c) => stepOf(click, sessionId, c, to));
    const stale = stepped.flatMap((s) => (s.kind === "moved" ? [s] : []));
    if (stale.length > 0) {
      click.move(
        sessionId,
        forgotten(
          click.historyOf(sessionId),
          new Set(stale.map((s) => s.target)),
        ),
      );
      throw new BadVerbArgs(
        `${verb}: ${stale.map((s) => s.what).join(", ")} changed since that edit — refusing to overwrite it; this session's undo history no longer steps it`,
      );
    }
    const files = stepped.flatMap((s) => (s.kind === "file" ? [s] : []));
    // Each file is proved between the others as the step leaves them: a step
    // that wrote two layers is only ever loaded whole.
    const stepTexts = new Map(files.map(({ file, text }) => [file, text]));
    const read = (file: string): LayerContent => {
      const text = stepTexts.get(file);
      return text === undefined ? click.files.read(file) : contentOfText(text);
    };
    for (const { file, text } of files) click.files.prove(file, text, read);
    for (const { file, text } of files)
      click.files.land(
        file,
        requireLayerText(file, click.files.read(file)),
        text,
      );
    for (const s of stepped)
      if (s.kind === "session")
        if (s.value === null) click.held.clear(sessionId, s.key);
        else click.held.set(sessionId, s.key, s.value);
    click.move(sessionId, then);
  }

  // Move-to-end keeps insertion order as recency, so the bounds drop the
  // session that changed least recently.
  private put(sessionId: SessionId, history: SessionHistory): void {
    const next = new Map(this.state);
    putNewest(next, sessionId, holdsNothing(history) ? null : history);
    // A history that moved to the end is told even when it holds what it
    // held, so the host's order is this one's.
    this.moved.put(sessionId);
    this.adopt(next);
  }

  // [LAW:single-enforcer] The one enforcer of the bounds, over what the
  // profile handed in and over every step: each session the bounds trim or
  // drop is told.
  private adopt(next: Map<SessionId, SessionHistory>): void {
    const before = new Map(next);
    this.bound(next);
    for (const [sessionId, history] of before)
      if (next.get(sessionId) !== history) this.moved.put(sessionId);
    this.state = next;
  }

  private bound(next: Map<SessionId, SessionHistory>): void {
    while (next.size > MAX_SESSIONS || weight(next) > MAX_BYTES) {
      const [oldest, h] = next.entries().next().value!;
      if (next.size > 1) {
        next.delete(oldest);
        continue;
      }
      const trimmed = withoutOldestStep(h);
      if (holdsNothing(trimmed)) next.delete(oldest);
      else next.set(oldest, trimmed);
      this.logger(
        "info",
        `settings-history: trimmed an old step for session ${oldest}`,
      );
    }
  }
}

function weight(state: ReadonlyMap<SessionId, SessionHistory>): number {
  let bytes = 0;
  for (const { past, future } of state.values()) {
    for (const step of [...past, ...future]) {
      for (const c of step) {
        bytes += (c.before?.length ?? 0) + (c.after?.length ?? 0);
      }
    }
  }
  return bytes;
}

function withoutOldestStep({ past, future }: SessionHistory): SessionHistory {
  return past.length > 0
    ? { past: past.slice(1), future }
    : { past, future: future.slice(1) };
}

function capped(steps: readonly Step[]): readonly Step[] {
  return steps.slice(-MAX_STEPS);
}

function afterUndo(history: SessionHistory, step: Step): SessionHistory {
  return {
    past: history.past.slice(0, -1),
    future: capped([...history.future, step]),
  };
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
    : `the ${change.role} layer`;
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

// What a change stepped to `to` writes, read in the click: a session pick's
// value, or the file's text with the changes between the two texts the step
// recorded applied over it; or, when the pick or a setting of the file no
// longer holds what the step stepped from, what moved.
type Stepped =
  | {
      readonly kind: "session";
      readonly key: string;
      readonly value: string | null;
    }
  | {
      readonly kind: "file";
      readonly file: string;
      readonly text: string | null;
    }
  | { readonly kind: "moved"; readonly target: string; readonly what: string };

function stepOf(
  click: Click,
  sessionId: SessionId,
  change: Change,
  to: "before" | "after",
): Stepped {
  const from = to === "before" ? "after" : "before";
  if (change.kind === "session")
    return click.held.get(sessionId, change.key) === change[from]
      ? { kind: "session", key: change.key, value: change[to] }
      : {
          kind: "moved",
          target: identity(change),
          what: `session setting "${change.key}"`,
        };
  // [LAW:no-silent-failure] A role the chain no longer holds, or one that now
  // resolves to another file, is a target that moved: the file the step was
  // made on is no file this click may write.
  const file = click.files.pathOf(change.role);
  if (file === null || digestOf(file) !== change.digest)
    return {
      kind: "moved",
      target: identity(change),
      what: `the ${change.role} layer (${file === null ? "this session renders from none now" : "it is another file now"})`,
    };
  const applied = applyChanges(
    requireLayerText(file, click.files.read(file)),
    diffChanges(change[from], change[to]),
  );
  return applied.kind === "applied"
    ? { kind: "file", file, text: applied.text }
    : {
        kind: "moved",
        target: identity(change),
        what: `${addressText(applied.at)} in the ${change.role} layer`,
      };
}

// The history with every change to the targets gone from both stacks.
function forgotten(
  { past, future }: SessionHistory,
  gone: ReadonlySet<string>,
): SessionHistory {
  return { past: without(past, gone), future: without(future, gone) };
}

// [LAW:no-ambient-temporal-coupling] A click's session writes, held over the
// store until its consequence lands (`flush`): nothing outside the click sees
// a write whose click may not land, and the click reads its own.
function heldWrites(store: SessionStateRW): SessionStateRW & {
  readonly writes: Journal["writes"];
  readonly flush: () => ClickWrites;
} {
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
    writes: (sessionId) => held.get(sessionId) ?? new Map(),
    set: (sessionId, key, value) => put(sessionId, key, value),
    setBatch: (sessionId, pairs) => {
      for (const { key, value } of pairs) put(sessionId, key, value);
    },
    clear: (sessionId, key) => put(sessionId, key, null),
    // One transaction, so no observer sees half a click.
    flush: () => {
      const landed = new Map(held);
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
      });
      return landed;
    },
  };
}
