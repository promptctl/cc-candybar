import fs from "node:fs";
import path from "node:path";
import { quietLogger, type DaemonLogger } from "../utils/logger";
import type { SessionSnapshot, SessionStorage } from "./session-state";

// [LAW:no-silent-failure] Corrupt/missing file → empty state is the *defined*
// recovery, not a hidden fallback to different data: an empty store re-rolls
// random picks exactly as a first-ever boot would. Anything that isn't the
// expected sessionId→key→value shape is rejected here so the store never
// hydrates from a half-written or hand-edited file.
function isSnapshot(value: unknown): value is SessionSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const kv of Object.values(value)) {
    if (kv === null || typeof kv !== "object" || Array.isArray(kv))
      return false;
    for (const leaf of Object.values(kv)) {
      if (typeof leaf !== "string") return false;
    }
  }
  return true;
}

// [LAW:single-enforcer] The debounce + atomic write lives here, not in
// SessionState. The store calls save() on every mutation; this coalesces the
// bursty 22-session × 1 Hz write load into at most one disk write per window.
export class FileSessionStorage implements SessionStorage {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SessionSnapshot | null = null;
  // Whether a debounced write is on its way to the disk.
  private writing = false;
  // Counts synchronous flushes that landed: a debounced write begun before
  // the latest one is older than what it wrote. A flush the disk refused
  // counts for nothing, so the write it raced still publishes.
  private generation = 0;
  // The debounced write's temp file: what a flush removes to supersede it.
  private readonly writingPath: string;

  constructor(
    private readonly filePath: string,
    private readonly debounceMs: number = 500,
    // [LAW:locality-or-seam] Logging is injected, not hard-wired to
    // daemon.log: the daemon passes its log, every other caller stays quiet.
    private readonly logger: DaemonLogger = quietLogger,
  ) {
    this.writingPath = `${filePath}.writing`;
  }

  load(): SessionSnapshot {
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
          `session-state read failed (${code}); starting empty`,
        );
      }
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSnapshot(parsed)) return parsed;
      this.logger(
        "warn",
        `session-state load: unexpected shape, starting empty`,
      );
      return {};
    } catch {
      this.logger("warn", `session-state load: corrupt JSON, starting empty`);
      return {};
    }
  }

  save(snapshot: SessionSnapshot): void {
    this.pending = snapshot;
    this.schedule();
  }

  // One debounced write at a time, so snapshots land in the order they were
  // taken; a save that arrives while one is being written waits for it.
  private schedule(): void {
    if (this.timer !== null || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, this.debounceMs);
    this.timer.unref();
  }

  // [LAW:effects-at-boundaries] The debounced write takes all of its disk I/O
  // off the daemon's one thread: the bytes are written and synced through the
  // thread pool, and so is the rename that publishes them. A rename is a
  // journaled metadata op, and on a busy disk it waits on the journal like
  // any write: run synchronously here it held every bar and click for 180 ms
  // on a CI runner, past every client's reply budget.
  private async write(): Promise<void> {
    const snapshot = this.pending;
    if (snapshot === null) return;
    const generation = this.generation;
    const started = performance.now();
    const body = JSON.stringify(snapshot);
    const tmp = this.writingPath;
    this.writing = true;
    // The thread is held until the first await.
    const heldMs = performance.now() - started;
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const file = await fs.promises.open(tmp, "w", 0o600);
      try {
        await file.writeFile(body);
        await file.chmod(0o600);
        await file.datasync();
      } finally {
        await file.close();
      }
      // [LAW:no-ambient-temporal-coupling] A synchronous flush since this
      // write began wrote state at least as new: renaming this over it would
      // put older state back. A flush that lands while the rename is on its
      // way removes the temp file first (flush, below), so the rename finds
      // nothing: the one outcome in which this older state cannot land over
      // the newer.
      let landed = false;
      if (generation === this.generation) {
        try {
          await fs.promises.rename(tmp, this.filePath);
          landed = true;
        } catch (e) {
          if (
            (e as NodeJS.ErrnoException).code !== "ENOENT" ||
            generation === this.generation
          )
            throw e;
        }
      }
      // [LAW:nothing-unseen] A write a flush superseded, before or after its
      // rename, says so: its bytes were written and synced, and the last
      // `saved` line stays the flush's.
      if (generation !== this.generation) {
        if (!landed) await fs.promises.rm(tmp, { force: true });
        this.logger(
          "info",
          `session-state write superseded by a flush landed=${landed} took=${Math.round(performance.now() - started)}ms held=${Math.round(heldMs)}ms`,
        );
        return;
      }
      this.saved(body, snapshot, started, heldMs);
      if (this.pending === snapshot) this.pending = null;
    } catch (e) {
      this.logger("warn", `session-state save failed: ${(e as Error).message}`);
    } finally {
      this.writing = false;
      // A save that arrived while this one was written is written next. A
      // snapshot whose write failed waits for the next save or shutdown's
      // flush, so a disk that keeps refusing is not retried on a timer.
      if (this.pending !== null && this.pending !== snapshot) this.schedule();
    }
  }

  // The synchronous write, for shutdown and for callers that read the file
  // back at once.
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const snapshot = this.pending;
    const started = performance.now();
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const body = JSON.stringify(snapshot);
      // [LAW:single-enforcer] Daemon runtime files are owner-only (0o600), like
      // pid/spawn.lock. Session state carries conversation identifiers, so it
      // gets the same perms — chmod defeats umask and re-perms a reused tmp.
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      // [LAW:no-ambient-temporal-coupling] The debounced write's temp file goes
      // just before this write lands, whatever its rename is doing on the
      // thread pool: a rename and an unlink of one directory entry cannot
      // interleave, so either the older state landed already and is
      // overwritten below, or its rename finds nothing. Newer state is never
      // put back under older. A flush the disk refuses before this point
      // discards nothing; one it refuses at the rename below leaves both
      // writes saying they failed, and the newer state pending for the next
      // save.
      fs.rmSync(this.writingPath, { force: true });
      fs.renameSync(tmp, this.filePath);
      this.generation++;
      this.saved(body, snapshot, started, performance.now() - started);
      // [LAW:one-source-of-truth] `pending` is "state not yet durably written".
      // Clear it only once the rename lands, so a transient EIO/ENOSPC leaves
      // the snapshot for a later flush (e.g. shutdown) to retry rather than
      // silently dropping the last known state.
      this.pending = null;
    } catch (e) {
      this.logger("warn", `session-state save failed: ${(e as Error).message}`);
    }
  }

  // [LAW:nothing-unseen] Every write says what it wrote, how long it took, and
  // how much of that it held the daemon's one thread.
  private saved(
    body: string,
    snapshot: SessionSnapshot,
    started: number,
    heldMs: number,
  ): void {
    this.logger(
      "info",
      `session-state saved bytes=${Buffer.byteLength(body)} sessions=${Object.keys(snapshot).length} took=${Math.round(performance.now() - started)}ms held=${Math.round(heldMs)}ms`,
    );
  }
}
