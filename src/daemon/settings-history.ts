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
import { readConfigText, writeConfigText } from "./config-file-store";
import type { DaemonLogger } from "./log";
import type { SessionStateRW } from "./session-state";
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
}

// What the settings menu shows: how many steps undo and redo can take.
export interface HistoryDepth {
  readonly undo: number;
  readonly redo: number;
}

export const EMPTY_HISTORY_DEPTH: HistoryDepth = { undo: 0, redo: 0 };

export type HistoryState = Readonly<Record<string, SessionHistory>>;

// [LAW:locality-or-seam] Persistence is the storage's property, as with
// SessionStorage: the daemon binds a file, everything else keeps the ephemeral
// default and never touches disk.
export interface HistoryStorage {
  load(): HistoryState;
  save(state: HistoryState): void;
}

const EPHEMERAL_STORAGE: HistoryStorage = { load: () => ({}), save: () => {} };

// [LAW:one-source-of-truth] The session keys a settings control writes. Every
// other session key — an open menu, a page cursor, the edit-mode toggle — is
// the menu's own state, and undoing it would be undoing navigation.
const SETTING_SESSION_KEYS: ReadonlySet<string> = new Set(
  SETTING_PROJECTIONS.map((s) => s.sessionKey),
);

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
    const { past, future } = this.state.get(sessionId) ?? EMPTY;
    return { undo: past.length, redo: future.length };
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
    const inner = this.sessionState;
    // A change is recorded only once its write has landed, and its `after` is
    // what the store then reads — a write that throws records nothing.
    const recorded = (
      sessionId: string,
      keys: readonly string[],
      write: () => void,
    ): void => {
      const before = keys
        .filter((key) => SETTING_SESSION_KEYS.has(key))
        .map((key) => ({ key, before: inner.get(sessionId, key) }));
      write();
      for (const { key, before: b } of before) {
        note(sessionId, {
          kind: "session",
          key,
          before: b,
          after: inner.get(sessionId, key),
        });
      }
    };
    const sessionState: SessionStateRW = {
      get: (sessionId, key) => inner.get(sessionId, key),
      set: (sessionId, key, value) =>
        recorded(sessionId, [key], () => inner.set(sessionId, key, value)),
      setBatch: (sessionId, pairs) =>
        recorded(
          sessionId,
          pairs.map((p) => p.key),
          () => inner.setBatch(sessionId, pairs),
        ),
      clear: (sessionId, key) =>
        recorded(sessionId, [key], () => inner.clear(sessionId, key)),
    };
    return {
      sessionState,
      file: (sessionId, file, before, after) =>
        note(sessionId, { kind: "file", file, before, after }),
      commit: () => {
        // Handed off before it is saved, so a save that fails is reported by
        // this commit alone and never recorded again by a later one.
        const committing = [...pending];
        pending.clear();
        for (const [sessionId, changes] of committing) {
          // A click that wrote a value already there changed nothing, and a
          // step that changes nothing would be an undo that visibly does
          // nothing.
          const step = [...changes.values()].filter(
            (c) => c.before !== c.after,
          );
          if (step.length === 0) continue;
          // A fresh step abandons whatever was undone.
          this.put(sessionId, {
            past: capped([...this.history(sessionId).past, step]),
            future: [],
          });
        }
      },
    };
  }

  // Returns the step it restored, so the caller can say what changed.
  undo(sessionId: string): Step {
    const { past, future } = this.history(sessionId);
    const step = past.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("undo: nothing to undo");
    }
    this.apply(sessionId, step, "before", "undo", {
      past: past.slice(0, -1),
      future: capped([...future, step]),
    });
    return step;
  }

  redo(sessionId: string): Step {
    const { past, future } = this.history(sessionId);
    const step = future.at(-1);
    if (step === undefined) {
      throw new BadVerbArgs("redo: nothing to redo");
    }
    this.apply(sessionId, step, "after", "redo", {
      past: capped([...past, step]),
      future: future.slice(0, -1),
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
    if (history.past.length > 0 || history.future.length > 0) {
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

function withoutOldestStep({ past, future }: SessionHistory): SessionHistory {
  return past.length > 0
    ? { past: past.slice(1), future }
    : { past, future: future.slice(1) };
}

function capped(steps: readonly Step[]): readonly Step[] {
  return steps.slice(-MAX_STEPS);
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
  return isSteps(o.past) && isSteps(o.future);
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
