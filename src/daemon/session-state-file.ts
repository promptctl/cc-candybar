import fs from "node:fs";
import path from "node:path";
import { quietLogger, type DaemonLogger } from "../utils/logger";
import { publishByRenameAsync } from "../utils/atomic-write";
import { sessionKeyed, type SessionId } from "./foundations/session-id";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time";

// [LAW:one-type-per-behavior] What one per-session file holds: the name its
// log lines say, each session's value as the file keeps it, and as a load
// parses it back, null for one of the wrong shape.
export interface SessionFileKind<V> {
  readonly name: string;
  readonly record: (value: V) => unknown;
  readonly parse: (value: unknown) => V | null;
}

// [LAW:locality-or-seam] Where one per-session file's sessions are kept: its
// file, or nowhere. Its owner holds them, and persistence is the storage's.
export interface SessionFileStorage<V> {
  load(): ReadonlyMap<SessionId, V>;
  save(snapshot: Readonly<Record<SessionId, V>>): void;
  flush(): Promise<void>;
}

// [LAW:dataflow-not-control-flow] Kept nowhere: it loads nothing and writes
// nothing, so a daemon that keeps no files (the page) runs the same path.
export const ephemeralSessionFile = <V>(): SessionFileStorage<V> => ({
  load: () => new Map(),
  save: () => {},
  flush: async () => {},
});

// A session's picks: its key → value strings.
export type SessionPicks = Readonly<Record<string, string>>;

// The session picks' file.
export const SESSION_STATE_FILE: SessionFileKind<SessionPicks> = {
  name: "session-state",
  record: (kv) => kv,
  parse: (kv) =>
    kv !== null &&
    typeof kv === "object" &&
    !Array.isArray(kv) &&
    Object.values(kv).every((leaf) => typeof leaf === "string")
      ? (kv as SessionPicks)
      : null,
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// [LAW:single-enforcer] The debounce + atomic write of every per-session
// file. Its owner calls save() on every change; this coalesces the bursty
// 22-session × 1 Hz write load into at most one disk write per window.
export class SessionFile<V> implements SessionFileStorage<V> {
  // What clears the debounce timer while one is armed.
  private clearTimer: (() => void) | null = null;
  // [LAW:one-source-of-truth] State not yet durably written: cleared only once
  // its write lands, so a disk that refuses leaves it for the next write.
  private pending: Readonly<Record<SessionId, V>> | null = null;
  // [LAW:no-ambient-temporal-coupling] Every write joins the end of this
  // chain, so writes land in the order they began and none overtakes
  // another: older state still on its way never lands over newer.
  private written: Promise<void> = Promise.resolve();

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

  // [LAW:no-silent-failure] Corrupt/missing file → empty state is the
  // *defined* recovery, not a hidden fallback to different data: an empty
  // store re-rolls random picks exactly as a first-ever boot would.
  load(): ReadonlyMap<SessionId, V> {
    const loaded = new Map<SessionId, V>();
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      // [LAW:no-silent-failure] A missing file is the expected first-boot
      // recovery (silent → empty). Any other read failure (EACCES, EIO) is an
      // anomaly worth surfacing before recovering to empty.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger(
          "warn",
          `${this.kind.name} read failed (${code}); starting empty`,
        );
      }
      return loaded;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        // [LAW:no-silent-failure] A key the session id checkpoint refuses, or
        // a value of the wrong shape, is reported and dropped, and the
        // sessions beside it load whole: the store never hydrates from a
        // half-written or hand-edited entry.
        const keyed = sessionKeyed(parsed, (key, problem) =>
          this.logger(
            "warn",
            `${this.kind.name} load: dropped session key ${JSON.stringify(key)}: session id ${problem}`,
          ),
        );
        for (const [id, value] of keyed) {
          const held = this.kind.parse(value);
          if (held !== null) loaded.set(id, held);
          else
            this.logger(
              "warn",
              `${this.kind.name} load: dropped session ${JSON.stringify(id)}: its value has the wrong shape`,
            );
        }
        return loaded;
      }
      this.logger(
        "warn",
        `${this.kind.name} load: unexpected shape, starting empty`,
      );
      return loaded;
    } catch {
      this.logger(
        "warn",
        `${this.kind.name} load: corrupt JSON, starting empty`,
      );
      return loaded;
    }
  }

  save(snapshot: Readonly<Record<SessionId, V>>): void {
    this.pending = snapshot;
    this.schedule();
  }

  // One debounce window at a time: the saves inside it coalesce into the
  // write it ends with.
  private schedule(): void {
    if (this.clearTimer !== null) return;
    this.clearTimer = this.clock.after(
      this.debounceMs,
      () => {
        this.clearTimer = null;
        void this.write();
      },
      { unref: true },
    );
  }

  // Joins a write of what is pending to the chain, settling once it lands or
  // fails.
  private write(): Promise<void> {
    this.written = this.written.then(() => this.land());
    return this.written;
  }

  private body(snapshot: Readonly<Record<SessionId, V>>): string {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(snapshot).map(([id, value]) => [
          id,
          this.kind.record(value as V),
        ]),
      ),
    );
  }

  // [LAW:effects-at-boundaries] The debounced write takes all of its disk I/O
  // off the daemon's one thread: the bytes are written and synced through the
  // thread pool, and so is the rename that publishes them. A rename is a
  // journaled metadata op, and on a busy disk it waits on the journal like
  // any write: run synchronously here it held every bar and click for 180 ms
  // on a CI runner, past every client's reply budget.
  private async land(): Promise<void> {
    // An earlier write in the chain may have landed this snapshot already.
    const snapshot = this.pending;
    if (snapshot === null) return;
    const started = this.clock.monotonic();
    const body = this.body(snapshot);
    // The thread is held until the first await.
    const heldMs = elapsedMs(this.clock, started);
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      // [LAW:single-enforcer] Daemon runtime files are owner-only, like
      // pid/spawn.lock: a session file carries conversation identifiers.
      await publishByRenameAsync(this.filePath, body, 0o600);
      this.saved(body, snapshot, started, heldMs);
      if (this.pending === snapshot) this.pending = null;
    } catch (e) {
      // A snapshot whose write failed waits for the next save or shutdown's
      // flush, so a disk that keeps refusing is not retried on a timer.
      this.logger(
        "warn",
        `${this.kind.name} save failed: ${(e as Error).message}`,
      );
    }
  }

  // For shutdown and for callers that read the file back: what is pending
  // lands now, behind any write already on its way.
  flush(): Promise<void> {
    this.clearTimer?.();
    this.clearTimer = null;
    return this.write();
  }

  // [LAW:nothing-unseen] Every write says what it wrote, how long it took, and
  // how much of that it held the daemon's one thread.
  private saved(
    body: string,
    snapshot: Readonly<Record<SessionId, V>>,
    started: Monotonic,
    heldMs: number,
  ): void {
    this.logger(
      "info",
      `${this.kind.name} saved bytes=${Buffer.byteLength(body)} sessions=${Object.keys(snapshot).length} took=${elapsedMs(this.clock, started)}ms held=${heldMs}ms`,
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
