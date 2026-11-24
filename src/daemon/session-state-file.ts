import fs from "node:fs";
import path from "node:path";
import { quietLogger, type DaemonLogger } from "../utils/logger";
import {
  asError,
  publishByRenameAsync,
  resolvedTarget,
} from "../utils/atomic-write";
import { sessionKeyed, type SessionId } from "./foundations/session-id";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time";
import { ok, type Asked } from "../utils/outcome";
import { isPlainObject } from "../config/loader/validate-core";
import {
  parseSessionPicks,
  withoutRetiredKeys,
  type SessionPicks,
} from "../renderer-interface/stored-state";
import { stateFile, type StateObservation } from "./state-file";
import { setAside, type FileRetirement } from "./file-rewrites";
import type { Dropped, Kept } from "./foundations/stored-file";
export type { SessionPicks } from "../renderer-interface/stored-state";

// [LAW:one-type-per-behavior] What one per-session file holds: the name its
// log lines say, each session's value as the file keeps it, and as a load
// parses it back, or why not, read after "its value". A value the parse
// keeps can still give up parts this build reads nothing of, each named in
// what the load dropped.
export interface SessionFileKind<V> {
  readonly name: string;
  readonly record: (value: V) => unknown;
  readonly parse: (value: unknown) => Asked<Kept<V>>;
}

// What a per-session file's load holds: its sessions, oldest first, and what
// it dropped of what the file held.
export interface Loaded<V> {
  readonly sessions: ReadonlyMap<SessionId, V>;
  readonly dropped: readonly Dropped[];
}

export const nothingLoaded = <V>(): Loaded<V> => ({
  sessions: new Map(),
  dropped: [],
});

// [LAW:locality-or-seam] Where one per-session file's sessions are kept: its
// file, or nowhere. Its holder (src/daemon/held-file.ts) decides what a read
// means; persistence is the storage's.
export interface SessionFileStorage<V> {
  // Where it is kept, as the bar names it.
  readonly file: string;
  // The file's read, by the rule every state file keeps (state-file.ts).
  observe(): StateObservation<Loaded<V>>;
  // Sets aside the file a read named as unread (`setAside` in
  // file-rewrites.ts), and says where it went.
  setAside(file: string): FileRetirement;
  // The sessions as they stand, oldest first. The storage keeps its own copy
  // until the write behind lands, so the owner may go on changing its map;
  // the file keeps their order.
  save(snapshot: ReadonlyMap<SessionId, V>): void;
  flush(): Promise<void>;
}

// [LAW:dataflow-not-control-flow] Kept nowhere: it reads as absent and
// writes nothing, so a daemon that keeps no files (the page) runs the same
// path.
export const ephemeralSessionFile = <V>(): SessionFileStorage<V> => ({
  file: "(kept nowhere)",
  observe: () => ({ result: ok(nothingLoaded<V>()), paths: [], source: null }),
  setAside: () => {
    throw new Error("a file kept nowhere always reads");
  },
  save: () => {},
  flush: async () => {},
});

// The session picks' file uses the same value shape as a renderer profile,
// less the picks nothing reads now.
export const SESSION_STATE_FILE: SessionFileKind<SessionPicks> = {
  name: "session-state",
  record: (kv) => kv,
  parse: (value) => {
    const picks = parseSessionPicks(value);
    return picks.kind === "ok" ? withoutRetiredKeys(picks.value) : picks;
  },
};

// [LAW:single-enforcer] The parse of every per-session file, keyed by session
// id: each key crosses the session-id checkpoint and each value the kind's
// parse, and an entry either refuses is named and dropped alone, so the
// store never hydrates from a half-written or hand-edited entry. What did
// not read as a whole is state-file's to classify.
export const sessionsOf =
  <V>(kind: Pick<SessionFileKind<V>, "parse">) =>
  (doc: unknown): Asked<Loaded<V>> => {
    if (!isPlainObject(doc))
      return { kind: "failed", reason: "is not an object keyed by session" };
    const sessions = new Map<SessionId, V>();
    const dropped: Dropped[] = [];
    const keyed = sessionKeyed(doc, (key, problem) =>
      dropped.push({ session: key, part: null, why: `session id ${problem}` }),
    );
    for (const [id, value] of keyed) {
      const entry = kind.parse(value);
      if (entry.kind === "failed")
        dropped.push({
          session: id,
          part: null,
          why: `its value ${entry.reason}`,
        });
      else {
        sessions.set(id, entry.value.value);
        for (const part of entry.value.dropped)
          dropped.push({ session: id, ...part });
      }
    }
    return ok({ sessions, dropped });
  };

// [LAW:effects-at-boundaries] A per-session file as the disk holds it: read
// through the one rule, a file that did not read renamed aside.
export function sessionFileOnDisk<V>(
  kind: Pick<SessionFileKind<V>, "parse">,
  filePath: string,
): Pick<SessionFileStorage<V>, "file" | "observe" | "setAside"> {
  const file = stateFile([filePath], nothingLoaded<V>(), sessionsOf(kind));
  return {
    file: filePath,
    observe: file.observe,
    setAside,
  };
}

// What one write came to, its error kept whole. Nothing pending is landed:
// an earlier write landed it.
type Landed =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };
const LANDED: Landed = { ok: true };

// [LAW:single-enforcer] The debounce + atomic write of every per-session
// file. Its owner calls save() on every change; this coalesces the bursty
// 22-session × 1 Hz write load into at most one disk write per window.
export class SessionFile<V> implements SessionFileStorage<V> {
  readonly file: string;
  private readonly disk: Pick<SessionFileStorage<V>, "observe" | "setAside">;
  // What clears the debounce timer while one is armed.
  private clearTimer: (() => void) | null = null;
  // [LAW:one-source-of-truth] State not yet written: cleared only once its
  // write lands, so a disk that refuses leaves it for the next write.
  private pending: ReadonlyMap<SessionId, V> | null = null;
  // [LAW:no-ambient-temporal-coupling] Every write joins the end of this
  // chain, so writes land in the order they began and none overtakes
  // another: older state still on its way never lands over newer.
  private written: Promise<void> = Promise.resolve();
  // The write queued behind the one in flight and not yet begun.
  private waiting: Promise<Landed> | null = null;

  constructor(
    private readonly kind: SessionFileKind<V>,
    private readonly filePath: string,
    // [LAW:effects-at-boundaries] The machine's clock: the debounce and the
    // timings the write logs are real time, as the disk is.
    private readonly clock: Pick<Timekeeper, "after" | "monotonic">,
    private readonly debounceMs: number = 500,
    // [LAW:locality-or-seam] Logging is injected, not hard-wired to
    // daemon.log: the daemon passes its log, every other caller stays quiet.
    private readonly logger: DaemonLogger = quietLogger,
  ) {
    this.disk = sessionFileOnDisk(kind, filePath);
    this.file = filePath;
  }

  observe(): StateObservation<Loaded<V>> {
    return this.disk.observe();
  }

  setAside(file: string): FileRetirement {
    return this.disk.setAside(file);
  }

  save(snapshot: ReadonlyMap<SessionId, V>): void {
    // [LAW:no-ambient-temporal-coupling] A copy of its own: the landing
    // clears what is pending only if it is the copy that write began with,
    // and an owner's map that moved while the write was on its way is a new
    // copy, so it stays pending.
    this.pending = new Map(snapshot);
    this.schedule();
  }

  // One debounce window at a time: the saves inside it coalesce into the
  // write it ends with.
  private schedule(): void {
    if (this.clearTimer !== null) return;
    this.clearTimer = this.clock.after(
      `${this.kind.name} write`,
      this.debounceMs,
      async () => {
        this.clearTimer = null;
        await this.write();
      },
      { unref: true },
    );
  }

  // Joins a write of what is pending to the chain. At most one write waits
  // behind the one in flight, since it writes whatever is pending when it
  // begins: a stalled disk queues one write, not one per window.
  private write(): Promise<Landed> {
    if (this.waiting === null) {
      const waiting = this.written.then(() => {
        this.waiting = null;
        return this.land();
      });
      this.waiting = waiting;
      // [LAW:no-silent-failure] The chain settles whatever a write did, so no
      // write's failure stops the next; the write's own promise keeps it.
      this.written = waiting.then(
        () => {},
        () => {},
      );
    }
    return this.waiting;
  }

  // [LAW:effects-at-boundaries] The file's record of the sessions, in the
  // order the owner holds them.
  private body(snapshot: ReadonlyMap<SessionId, V>): string {
    return JSON.stringify(
      Object.fromEntries(
        [...snapshot].map(([id, value]) => [id, this.kind.record(value)]),
      ),
    );
  }

  // [LAW:effects-at-boundaries] The debounced write takes its disk writes off
  // the daemon's one thread: the bytes are written through the thread pool,
  // and so is the rename that publishes them. A rename is a journaled
  // metadata op, and on a busy disk it waits on the journal like any write:
  // run synchronously here it held every bar and click for 180 ms on a CI
  // runner, past every client's reply budget. Only the walk of the path's
  // links, a read of metadata the journal does not hold up, runs here.
  // [LAW:no-silent-failure] A write that fails says so and is a value; the
  // next write still runs.
  private async land(): Promise<Landed> {
    // An earlier write in the chain may have landed this snapshot already.
    const snapshot = this.pending;
    if (snapshot === null) return LANDED;
    const started = this.clock.monotonic();
    let body: string;
    let heldMs: number;
    try {
      body = this.body(snapshot);
      // The thread is held until the first await.
      heldMs = elapsedMs(this.clock, started);
      // [LAW:single-enforcer] Published where a write to the path lands, as
      // every state file is (`resolvedTarget`), so a symlinked file stays a
      // link, and a set-aside and the next write agree on the file.
      const file = resolvedTarget(this.filePath);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      // [LAW:single-enforcer] Daemon runtime files are owner-only, like
      // pid/spawn.lock: a session file carries conversation identifiers.
      await publishByRenameAsync(file, body, 0o600);
    } catch (e) {
      // A snapshot whose write failed waits for the next save or shutdown's
      // flush, so a disk that keeps refusing is not retried on a timer.
      const error = asError(e);
      this.logger("warn", `${this.kind.name} save failed: ${error.message}`);
      return { ok: false, error };
    }
    // [LAW:no-ambient-temporal-coupling] An identity, not a value: a newer
    // save made while this one was on its way stays pending.
    if (this.pending === snapshot) this.pending = null;
    this.saved(body, snapshot, started, heldMs);
    return LANDED;
  }

  // For shutdown and for callers that read the file back: what is pending
  // lands now, behind any write already on its way. [LAW:no-silent-failure]
  // A write that fails rejects, so a shutdown that lost state says so.
  async flush(): Promise<void> {
    this.clearTimer?.();
    this.clearTimer = null;
    const landed = await this.write();
    if (!landed.ok) throw landed.error;
  }

  // [LAW:nothing-unseen] Every write that writes says what it wrote, how long
  // it took, and how much of that it held the daemon's one thread.
  private saved(
    body: string,
    snapshot: ReadonlyMap<SessionId, V>,
    started: Monotonic,
    heldMs: number,
  ): void {
    this.logger(
      "info",
      `${this.kind.name} saved bytes=${Buffer.byteLength(body)} sessions=${snapshot.size} took=${elapsedMs(this.clock, started)}ms held=${heldMs}ms`,
    );
  }
}

// The session picks' file, as a profile keeps it.
export const sessionStateFile = (
  filePath: string,
  clock: Pick<Timekeeper, "after" | "monotonic">,
  debounceMs?: number,
  logger?: DaemonLogger,
): SessionFileStorage<SessionPicks> =>
  new SessionFile(SESSION_STATE_FILE, filePath, clock, debounceMs, logger);
