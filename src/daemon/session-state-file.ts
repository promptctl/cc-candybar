import fs from "node:fs";
import path from "node:path";
import { quietLogger, type DaemonLogger } from "../utils/logger";
import { asError, publishByRenameAsync } from "../utils/atomic-write";
import { sessionKeyed, type SessionId } from "./foundations/session-id";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time";
import type { Asked } from "../utils/outcome";
import { isPlainObject } from "../config/loader/validate-core";
import {
  parseSessionPicks,
  type SessionPicks,
} from "../renderer-interface/stored-state";
export type { SessionPicks } from "../renderer-interface/stored-state";

// [LAW:one-type-per-behavior] What one per-session file holds: the name its
// log lines say, each session's value as the file keeps it, and as a load
// parses it back, or why not, read after "its value".
export interface SessionFileKind<V> {
  readonly name: string;
  readonly record: (value: V) => unknown;
  readonly parse: (value: unknown) => Asked<V>;
}

// [LAW:locality-or-seam] Where one per-session file's sessions are kept: its
// file, or nowhere. Its owner holds them, and persistence is the storage's.
export interface SessionFileStorage<V> {
  load(): ReadonlyMap<SessionId, V>;
  // The sessions as they stand, oldest first. The storage keeps its own copy
  // until the write behind lands, so the owner may go on changing its map;
  // the file keeps their order.
  save(snapshot: ReadonlyMap<SessionId, V>): void;
  flush(): Promise<void>;
}

// [LAW:dataflow-not-control-flow] Kept nowhere: it loads nothing and writes
// nothing, so a daemon that keeps no files (the page) runs the same path.
export const ephemeralSessionFile = <V>(): SessionFileStorage<V> => ({
  load: () => new Map(),
  save: () => {},
  flush: async () => {},
});

// The session picks' file uses the same value shape as a renderer profile.
export const SESSION_STATE_FILE: SessionFileKind<SessionPicks> = {
  name: "session-state",
  record: (kv) => kv,
  parse: parseSessionPicks,
};

// [LAW:single-enforcer] The load of every per-session file, keyed by session
// id: each key crosses the session-id checkpoint and each value the kind's
// parse, and an entry either refuses is named and dropped alone.
// [LAW:no-silent-failure] Corrupt/missing file → empty state is the
// *defined* recovery, not a hidden fallback to different data: an empty
// store re-rolls random picks exactly as a first-ever boot would. Only the
// read and the JSON parse are caught: a throw past them is a bug, and stays one.
// [LAW:nothing-unseen] Every load says what it found: no file, a file it
// could not use, or how many sessions it loaded and dropped.
export function loadSessionFile<V>(
  kind: Pick<SessionFileKind<V>, "name" | "parse">,
  filePath: string,
  logger: DaemonLogger,
): Map<SessionId, V> {
  const loaded = new Map<SessionId, V>();
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      logger("info", `${kind.name} load: no file, starting empty`);
    else logger("warn", `${kind.name} read failed (${code}); starting empty`);
    return loaded;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger("warn", `${kind.name} load: corrupt JSON, starting empty`);
    return loaded;
  }
  if (!isPlainObject(parsed)) {
    logger("warn", `${kind.name} load: unexpected shape, starting empty`);
    return loaded;
  }
  // [LAW:no-silent-failure] A key the session id checkpoint refuses, or a
  // value its kind refuses, is reported and dropped, and the sessions beside
  // it load whole: the store never hydrates from a half-written or
  // hand-edited entry.
  let dropped = 0;
  const keyed = sessionKeyed(parsed, (key, problem) => {
    dropped += 1;
    logger(
      "warn",
      `${kind.name} load: dropped session key ${JSON.stringify(key)}: session id ${problem}`,
    );
  });
  for (const [id, value] of keyed) {
    const entry = kind.parse(value);
    if (entry.kind === "ok") loaded.set(id, entry.value);
    else {
      dropped += 1;
      logger(
        "warn",
        `${kind.name} load: dropped session ${JSON.stringify(id)}: its value ${entry.reason}`,
      );
    }
  }
  logger(
    "info",
    `${kind.name} loaded sessions=${loaded.size} dropped=${dropped}`,
  );
  return loaded;
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
  ) {}

  load(): ReadonlyMap<SessionId, V> {
    return loadSessionFile(this.kind, this.filePath, this.logger);
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

  // [LAW:effects-at-boundaries] The debounced write takes all of its disk I/O
  // off the daemon's one thread: the bytes are written through the thread
  // pool, and so is the rename that publishes them. A rename is a journaled
  // metadata op, and on a busy disk it waits on the journal like any write:
  // run synchronously here it held every bar and click for 180 ms on a CI
  // runner, past every client's reply budget.
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
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      // [LAW:single-enforcer] Daemon runtime files are owner-only, like
      // pid/spawn.lock: a session file carries conversation identifiers.
      await publishByRenameAsync(this.filePath, body, 0o600);
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
