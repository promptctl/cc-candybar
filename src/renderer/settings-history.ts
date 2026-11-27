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
  historyAfter,
  historyTarget,
  targetKey,
  type HistoryTarget,
  type HistoryEdit,
  EMPTY_HISTORY,
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
import { RecencyMap } from "../utils/recency.js";
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
const MAX_SESSIONS = 32;
const MAX_BYTES = 8 * 1024 * 1024;

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

export class SettingsHistory {
  // [LAW:dataflow-not-control-flow] Reading a session's depth subscribes only
  // to that session. A hearing changes the budget's eviction order alone.
  private readonly held = observable.map<SessionId, SessionHistory>(undefined, {
    deep: false,
  });
  private readonly costs = new RecencyMap<SessionId, number>();
  private readonly stepCosts = new WeakMap<Step, number>();
  private totalCost = 0;

  private readonly moved = new StoredMoves();
  private readonly edits = new Map<SessionId, HistoryEdit[]>();

  // `loaded` is what the profile holds, oldest first, as the host handed it
  // in: held to the same bounds as every step that lands.
  constructor(
    private readonly sessionState: SessionStateRW,
    private readonly logger: DaemonLogger,
    loaded: StoredState["history"] = {},
    private readonly destination: "host" | "private" = "host",
  ) {
    runInAction(() => {
      for (const [id, history] of Object.entries(loaded))
        this.keep(id as SessionId, history);
      this.bound();
    });
  }

  heard(sessionId: SessionId): void {
    if (!this.costs.touch(sessionId)) return;
    if (this.destination === "host") this.moved.heard(sessionId);
  }

  drain(): StoreWrite[] {
    const writes = this.moved.drain(
      (key, moved): StoreWrite =>
        moved === "heard"
          ? { kind: "heard", store: "settings-history", key }
          : {
              kind: "steps",
              store: "settings-history",
              key,
              edits: this.edits.get(key)!,
            },
    );
    this.edits.clear();
    return writes;
  }

  private record(session: SessionId, edits: readonly HistoryEdit[]): void {
    if (this.destination === "private") return;
    this.moved.put(session);
    if (!this.held.has(session)) this.edits.set(session, [{ kind: "clear" }]);
    else {
      const pending = this.edits.get(session);
      if (pending === undefined) this.edits.set(session, [...edits]);
      else pending.push(...edits);
    }
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
    return this.held.get(sessionId) ?? EMPTY_HISTORY;
  }

  begin(files: ConfigFiles): Journal {
    const held = heldWrites(this.sessionState);
    // Each session's history as this click leaves it.
    const working = new Map<
      SessionId,
      { history: SessionHistory; edits: HistoryEdit[] }
    >();
    const historyOf = (sid: SessionId) =>
      working.get(sid)?.history ?? this.history(sid);
    const click: Click = {
      held,
      files,
      historyOf,
      move: (sid, edit) => {
        const history = historyAfter(historyOf(sid), edit);
        const edits = working.get(sid)?.edits ?? [];
        edits.push(edit);
        working.set(sid, { history, edits });
      },
    };
    const pending: Pending = new Map();
    const note = (sessionId: SessionId, change: Change): void => {
      const changes = pending.get(sessionId) ?? new Map<string, Change>();
      const earlier = changes.get(targetKey(change));
      changes.set(
        targetKey(change),
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
          click.move(sessionId, { kind: "append", step: changes });
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
        return this.travel(click, sessionId, "undo");
      },
      redo: (sessionId) => {
        step();
        return this.travel(click, sessionId, "redo");
      },
      commit: () => {
        step();
        return runInAction(() => {
          for (const [sessionId, { history, edits }] of working) {
            if (holdsNothing(history)) this.drop(sessionId);
            else this.keep(sessionId, history);
            this.record(sessionId, edits);
          }
          working.clear();
          this.bound();
          return held.flush();
        });
      },
    };
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
  private travel(
    click: Click,
    sessionId: SessionId,
    verb: "undo" | "redo",
  ): Step {
    const history = click.historyOf(sessionId);
    const step = (verb === "undo" ? history.past : history.future).at(-1);
    if (step === undefined)
      throw new BadVerbArgs(`${verb}: nothing to ${verb}`);
    const to = verb === "undo" ? "before" : "after";
    const stepped = step.map((c) => stepOf(click, sessionId, c, to));
    const stale = stepped.flatMap((s) => (s.kind === "moved" ? [s] : []));
    if (stale.length > 0) {
      click.move(sessionId, {
        kind: "forget",
        targets: stale.map((s) => s.target),
      });
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
    click.move(sessionId, { kind: verb });
    return step;
  }

  // [LAW:single-enforcer] Account immutable steps once. Only the affected
  // session changes its contribution to the shared budget. Keep the original
  // weight in string code units so an upgrade preserves eviction decisions.
  private keep(sessionId: SessionId, history: SessionHistory): void {
    let cost = 0;
    for (const stack of [history.past, history.future]) {
      for (const step of stack) {
        let weight = this.stepCosts.get(step);
        if (weight === undefined) {
          weight = step.reduce(
            (sum, change) =>
              sum + (change.before?.length ?? 0) + (change.after?.length ?? 0),
            0,
          );
          this.stepCosts.set(step, weight);
        }
        cost += weight;
      }
    }
    this.totalCost += cost - (this.costs.get(sessionId) ?? 0);
    this.costs.set(sessionId, cost);
    this.held.set(sessionId, history);
  }

  private drop(sessionId: SessionId): void {
    this.totalCost -= this.costs.get(sessionId) ?? 0;
    this.costs.delete(sessionId);
    this.held.delete(sessionId);
  }

  private bound(): void {
    while (this.costs.size > MAX_SESSIONS || this.totalCost > MAX_BYTES) {
      const oldest = this.costs.oldest!;
      if (this.costs.size > 1) {
        this.drop(oldest);
        this.record(oldest, []);
        continue;
      }
      const history = this.held.get(oldest)!;
      let remaining = this.totalCost;
      let count = 0;
      for (const stack of [history.past, history.future]) {
        for (const step of stack) {
          if (remaining <= MAX_BYTES) break;
          remaining -= this.stepCosts.get(step)!;
          count++;
        }
      }
      const edit = { kind: "trim", count } as const;
      const trimmed = historyAfter(history, edit);
      if (holdsNothing(trimmed)) this.drop(oldest);
      else this.keep(oldest, trimmed);
      this.record(oldest, [edit]);
      for (let i = 0; i < count; i++)
        this.logger(
          "info",
          `settings-history: trimmed an old step for session ${oldest}`,
        );
    }
  }
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
  readonly move: (sessionId: SessionId, edit: HistoryEdit) => void;
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
  | {
      readonly kind: "moved";
      readonly target: HistoryTarget;
      readonly what: string;
    };

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
          target: historyTarget(change),
          what: `session setting "${change.key}"`,
        };
  // [LAW:no-silent-failure] A role the chain no longer holds, or one that now
  // resolves to another file, is a target that moved: the file the step was
  // made on is no file this click may write.
  const file = click.files.pathOf(change.role);
  if (file === null || digestOf(file) !== change.digest)
    return {
      kind: "moved",
      target: historyTarget(change),
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
        target: historyTarget(change),
        what:
          applied.kind === "incomplete"
            ? `${file}: ${applied.reason}`
            : `${addressText(applied.at)} in the ${change.role} layer`,
      };
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
