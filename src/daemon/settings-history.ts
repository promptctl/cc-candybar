// [LAW:one-source-of-truth] The one undo history over every settings change a
// session makes (brandon-save-undo-bwi.jby). Before it, the only history was
// whole-file snapshots of the config file, so a session pick — the default
// destination of every settings click — could not be undone at all. Now a
// session's history holds whatever its clicks changed, wherever the change
// landed: a session pick, a config-file write, a structural edit, a reset.
//
// A STEP is one click. Its changes are recorded by the Journal the verb table
// opens around every top-level handler (src/daemon/verbs/index.ts), so a
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

import fs from "node:fs";
import path from "node:path";
import { SETTING_PROJECTIONS } from "../config/setting-projections";
import { DISCLOSURE_CLOSED } from "../config/disclosure";
import { EDIT_MODE_KEY, PLACEMENT_DRAFT_NS } from "../config/loader/edit-mode";
import { readConfigText, writeConfigText } from "./config-file-store";
import type { DaemonLogger } from "./log";
import { recordingView, type SessionStateRW } from "./session-state";
import { BadVerbArgs } from "./verb-error";
import { writeAtomic } from "../utils/atomic-write.js";

// [LAW:types-are-the-program] What a change touched and the two states it
// stepped between. `null` is absence on both kinds: an unset session key, a
// config file that does not exist (a first-ever write created it). Undo writes
// `before`, redo writes `after` — the same write either way.
export type Change =
  | {
      readonly kind: "session";
      readonly key: string;
      readonly before: string | null;
      readonly after: string | null;
    }
  | {
      readonly kind: "file";
      readonly file: string;
      readonly before: string | null;
      readonly after: string | null;
    };

export type Step = readonly Change[];

export interface SessionHistory {
  readonly past: readonly Step[];
  readonly future: readonly Step[];
  // [LAW:one-source-of-truth] The savepoint edit mode opens at: how many steps
  // of `past` were there before it opened, so the changes made since are the
  // steps above it and cancelling is stepping back to it. Present exactly
  // while edit mode is open. It is a position in the ORDER of steps, so it
  // moves only when steps leave the FRONT (`withoutOldestStep`, the cap in
  // `afterAppend`/`redo`) or when a fresh step abandons the redo stack it may
  // point into (`afterAppend`). An undo below it leaves it where it is, so
  // stepping forward again does not turn a step from before edit mode into one
  // made in it.
  readonly savepoint?: number;
}

// What the settings menu shows: how many steps undo and redo can take.
export interface HistoryDepth {
  readonly undo: number;
  readonly redo: number;
  // Steps taken since edit mode opened — what `✓ save N` counts and `↩ cancel`
  // would discard; 0 when edit mode is closed or nothing has changed in it.
  readonly sinceEdit: number;
}

export const EMPTY_HISTORY_DEPTH: HistoryDepth = {
  undo: 0,
  redo: 0,
  sinceEdit: 0,
};

export type HistoryState = Readonly<Record<string, SessionHistory>>;

// [LAW:locality-or-seam] Persistence is the storage's property, as with
// SessionStorage: the daemon binds a file, everything else keeps the ephemeral
// default and never touches disk.
export interface HistoryStorage {
  load(): HistoryState;
  save(state: HistoryState): void;
}

const EPHEMERAL_STORAGE: HistoryStorage = { load: () => ({}), save: () => {} };

// [LAW:one-source-of-truth] The session keys a settings control writes: a
// display setting's, and every placement setting's unsaved value, which
// configure mode mints under one namespace. Every other session key — an open
// menu, a page cursor, the edit-mode toggle — is the menu's own state, and
// undoing it would be undoing navigation.
const SETTING_SESSION_KEYS: ReadonlySet<string> = new Set(
  SETTING_PROJECTIONS.map((s) => s.sessionKey),
);
export const isSettingKey = (key: string): boolean =>
  SETTING_SESSION_KEYS.has(key) || key.startsWith(PLACEMENT_DRAFT_NS);

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
    sessionId: string,
    file: string,
    before: string | null,
    after: string,
  ): void;
  commit(): void;
}

// A pending change, keyed by what it touched so a click that writes one target
// twice records one change from its first `before` to its last `after`.
type Pending = Map<string, Map<string, Change>>;

const identity = (c: Change): string =>
  c.kind === "session" ? `session:${c.key}` : `file:${c.file}`;

export class SettingsHistory {
  private state: Map<string, SessionHistory> = new Map();

  constructor(
    private readonly sessionState: SessionStateRW,
    private readonly logger: DaemonLogger,
    private storage: HistoryStorage = EPHEMERAL_STORAGE,
  ) {
    this.state = new Map(Object.entries(storage.load()));
  }

  // [LAW:single-enforcer] Mirrors SessionState.useStorage: only the daemon
  // binds the file, after it has won the socket.
  useStorage(storage: HistoryStorage): void {
    this.storage = storage;
    this.state = new Map(Object.entries(storage.load()));
  }

  depth(sessionId: string): HistoryDepth {
    const { past, future, savepoint } = this.state.get(sessionId) ?? EMPTY;
    return {
      undo: past.length,
      redo: future.length,
      sinceEdit:
        savepoint === undefined ? 0 : Math.max(0, past.length - savepoint),
    };
  }

  history(sessionId: string): SessionHistory {
    return this.state.get(sessionId) ?? EMPTY;
  }

  begin(): Journal {
    const pending: Pending = new Map();
    const note = (sessionId: string, change: Change): void => {
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
    const toggles = new Map<string, EditToggle>();
    const sessionState = recordingView(
      this.sessionState,
      (key) => isSettingKey(key) || key === EDIT_MODE_KEY,
      (sessionId, key, before, after) => {
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
  undo(sessionId: string): Step {
    const history = this.history(sessionId);
    const step = history.past.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("undo: nothing to undo");
    }
    this.apply(sessionId, step, "before", "undo", afterUndo(history, step));
    return step;
  }

  // [LAW:no-silent-failure] Cancel for edit mode: return the stack to where
  // edit mode found it — step back through everything done since it opened,
  // and forward again through anything `↶` stepped back below that point — then
  // forget the savepoint. The discarded steps are NOT left on the redo stack:
  // a cancel discards, and a `↷` that brought the discarded edits back would
  // be the undo of a cancel nobody asked for. A step whose target
  // changed since (another session's click, a hand edit) refuses by name
  // through `apply`, exactly as `↶` does, and that refusal takes the savepoint
  // with it: the edits that cannot be stepped back cannot be cancelled either.
  // Returns the steps it undid, newest first, so the caller can say what it
  // discarded.
  rewind(sessionId: string): readonly Step[] {
    const { savepoint } = this.history(sessionId);
    if (savepoint === undefined) {
      throw new BadVerbArgs(
        "rewind: edit mode has no savepoint — nothing to cancel",
      );
    }
    const undone: Step[] = [];
    while (this.history(sessionId).past.length > savepoint) {
      undone.push(this.undo(sessionId));
    }
    while (this.history(sessionId).past.length < savepoint) {
      this.redo(sessionId);
    }
    this.put(sessionId, { past: this.history(sessionId).past, future: [] });
    return undone;
  }

  redo(sessionId: string): Step {
    const { past, future } = this.history(sessionId);
    const step = future.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("redo: nothing to redo");
    }
    const all = [...past, step];
    const kept = capped(all);
    this.apply(sessionId, step, "after", "redo", {
      past: kept,
      future: future.slice(0, -1),
      ...savepointDroppedBy(
        this.history(sessionId).savepoint,
        all.length - kept.length,
      ),
    });
    return step;
  }

  // [LAW:no-silent-failure] A step lands whole, together with the history
  // that records it, or not at all: every change is checked before any is
  // written, and a failure while writing it or saving `then` puts back what
  // was already written before the error goes on. A stale target is refused
  // by name, and its now-unreachable changes leave both stacks (see the
  // header).
  private apply(
    sessionId: string,
    step: Step,
    to: "before" | "after",
    verb: "undo" | "redo",
    then: SessionHistory,
  ): void {
    const from = to === "before" ? "after" : "before";
    const stale = step.filter((c) => this.read(sessionId, c) !== c[from]);
    if (stale.length > 0) {
      const gone = new Set(stale.map(identity));
      // The savepoint is released with the steps it counted: which of them
      // survive is no longer a fact it can state.
      this.put(sessionId, {
        past: without(this.history(sessionId).past, gone),
        future: without(this.history(sessionId).future, gone),
      });
      throw new BadVerbArgs(
        `${verb}: ${stale.map(describe).join(", ")} changed since that edit — refusing to overwrite it; this session's undo history no longer steps it`,
      );
    }
    const written: Change[] = [];
    try {
      for (const change of step) {
        this.write(sessionId, change, change[to]);
        written.push(change);
      }
      this.put(sessionId, then);
    } catch (e) {
      try {
        for (const change of written.reverse()) {
          this.write(sessionId, change, change[from]);
        }
      } catch (restoring) {
        throw new Error(
          `${(e as Error).message}; and putting the step back failed, so it is half-applied: ${(restoring as Error).message}`,
        );
      }
      throw e;
    }
  }

  private read(sessionId: string, change: Change): string | null {
    return change.kind === "session"
      ? this.sessionState.get(sessionId, change.key)
      : readConfigText(change.file);
  }

  private write(sessionId: string, change: Change, value: string | null): void {
    if (change.kind === "file") {
      writeConfigText(change.file, value, this.logger);
    } else if (value === null) {
      this.sessionState.clear(sessionId, change.key);
    } else {
      this.sessionState.set(sessionId, change.key, value);
    }
  }

  // Move-to-end keeps insertion order as recency, so the bounds drop the
  // session that changed least recently. The new state is adopted only once
  // it is saved, so memory never holds a step the file could not.
  private put(sessionId: string, history: SessionHistory): void {
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
      else next.set(oldest, withoutOldestStep(h));
    }
    this.storage.save(Object.fromEntries(next));
    this.state = next;
  }
}

function weight(state: ReadonlyMap<string, SessionHistory>): number {
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

function withoutOldestStep({
  past,
  future,
  savepoint,
}: SessionHistory): SessionHistory {
  return past.length > 0
    ? { past: past.slice(1), future, ...savepointDroppedBy(savepoint, 1) }
    : { past, future: future.slice(1), ...savepointDroppedBy(savepoint, 0) };
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

// [LAW:types-are-the-program] Open is "anything but closed or absent", the
// same reading every disclosure gate gives its key.
const isOpen = (value: string | null): boolean =>
  value !== null && value !== DISCLOSURE_CLOSED;

// `dropped` steps left the front of `past`, so a savepoint counted from the
// front moves down with them, never below the front itself.
function savepointDroppedBy(
  savepoint: number | undefined,
  dropped: number,
): { readonly savepoint?: number } {
  return savepoint === undefined
    ? {}
    : { savepoint: Math.max(0, savepoint - dropped) };
}

// A fresh step abandons whatever was undone, so a savepoint that pointed into
// the undone steps now points at the top of what is left: the step is above it.
function afterAppend(history: SessionHistory, step: Step): SessionHistory {
  const all = [...history.past, step];
  const past = capped(all);
  const reachable =
    history.savepoint === undefined
      ? undefined
      : Math.min(history.savepoint, history.past.length);
  return {
    past,
    future: [],
    ...savepointDroppedBy(reachable, all.length - past.length),
  };
}

function afterUndo(history: SessionHistory, step: Step): SessionHistory {
  return {
    past: history.past.slice(0, -1),
    future: capped([...history.future, step]),
    ...(history.savepoint !== undefined && { savepoint: history.savepoint }),
  };
}

// Opening takes the savepoint at the stack as it stands; closing releases it.
function withToggle(
  history: SessionHistory,
  toggle: EditToggle,
): SessionHistory {
  if (isOpen(toggle.after) && !isOpen(toggle.before)) {
    return { ...history, savepoint: history.past.length };
  }
  if (
    !isOpen(toggle.after) &&
    isOpen(toggle.before) &&
    history.savepoint !== undefined
  ) {
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

// ─── The file ───────────────────────────────────────────────────────────────

function isChange(v: unknown): v is Change {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const state = (x: unknown) => x === null || typeof x === "string";
  return (
    ((o.kind === "session" && typeof o.key === "string") ||
      (o.kind === "file" && typeof o.file === "string")) &&
    state(o.before) &&
    state(o.after)
  );
}

function isSteps(v: unknown): v is Step[] {
  return (
    Array.isArray(v) &&
    v.every((step) => Array.isArray(step) && step.every(isChange))
  );
}

function isSessionHistory(v: unknown): v is SessionHistory {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    isSteps(o.past) &&
    isSteps(o.future) &&
    (o.savepoint === undefined ||
      (Number.isInteger(o.savepoint) &&
        (o.savepoint as number) >= 0 &&
        (o.savepoint as number) <= o.past.length + o.future.length))
  );
}

// [LAW:no-silent-failure] A missing file is a first boot. An unreadable or
// wrong-shaped one is logged and dropped WHOLE rather than salvaged entry by
// entry. A write failure throws: the click's change landed, but saying it is
// undoable would be a lie.
export function fileHistoryStorage(
  file: string,
  logger: DaemonLogger,
): HistoryStorage {
  return {
    load: () => {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logger(
            "warn",
            `settings-history read failed (${code}); starting empty`,
          );
        }
        return {};
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Object.values(parsed).every(isSessionHistory)
        ) {
          return parsed as HistoryState;
        }
      } catch {
        // reported below
      }
      logger("warn", "settings-history load: unexpected shape, starting empty");
      return {};
    },
    save: (state) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(state), 0o600);
      } catch (e) {
        const message = `settings-history write failed — the change landed but is not undoable: ${(e as Error).message}`;
        logger("error", message);
        throw new Error(message);
      }
    },
  };
}
