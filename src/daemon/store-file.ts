// [LAW:effects-at-boundaries] The file one of a profile's stores lives in
// (src/daemon/profile-store.ts): read once, at the daemon's start, and
// written through a debounce, so a store written on every request costs at
// most one disk write per window.

import fs from "node:fs";
import path from "node:path";
import type { Asked } from "../utils/outcome";
import { quietLogger, type DaemonLogger } from "../utils/logger";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time";

export interface StoreFile {
  // The file's text, null while there is none, or why it did not read.
  read(): Asked<string | null>;
  // [LAW:no-ambient-temporal-coupling] Owes a write of what the body reads
  // when the write is made, so saves owed meanwhile coalesce into one.
  save(): void;
  // The owed write, now and synchronously: for the daemon's close.
  flush(): void;
}

// [LAW:single-enforcer] The debounce and the atomic write of every store's
// file.
export class DebouncedStoreFile implements StoreFile {
  // What clears the debounce timer while one is armed.
  private clearTimer: (() => void) | null = null;
  // Saves made, and how many of them the file holds: a write is owed while
  // the file is behind.
  private saves = 0;
  private written = 0;
  // Whether a debounced write is on its way to the disk.
  private writing = false;
  // Counts synchronous flushes that landed: a debounced write begun before
  // the latest one is older than what it wrote. A flush the disk refused
  // counts for nothing, so the write it raced still publishes.
  private generation = 0;
  // The debounced write's temp file: what a flush removes to supersede it.
  private readonly writingPath: string;
  private readonly name: string;

  constructor(
    private readonly filePath: string,
    // What the file holds, read as each write is made.
    private readonly body: () => string,
    // [LAW:effects-at-boundaries] The machine's clock: the debounce and the
    // timings the write logs are real time, as the disk is.
    private readonly clock: Pick<Timekeeper, "after" | "monotonic">,
    // [LAW:no-silent-failure] A write the disk refused, said beyond the log:
    // the host puts it on every bar.
    private readonly failed: (reason: string) => void,
    // [LAW:locality-or-seam] Logging is injected, not hard-wired to
    // daemon.log: the daemon passes its log, every other caller stays quiet.
    private readonly logger: DaemonLogger = quietLogger,
    private readonly debounceMs: number = 500,
  ) {
    this.writingPath = `${filePath}.writing`;
    this.name = path.basename(filePath);
  }

  read(): Asked<string | null> {
    try {
      return { kind: "ok", value: fs.readFileSync(this.filePath, "utf8") };
    } catch (e) {
      // A missing file is a store that holds nothing yet.
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { kind: "ok", value: null };
      return {
        kind: "failed",
        reason: `${this.filePath}: ${(e as Error).message}`,
      };
    }
  }

  save(): void {
    this.saves++;
    this.schedule();
  }

  // One debounced write at a time, so bodies land in the order they were
  // read; a save that arrives while one is being written waits for it.
  private schedule(): void {
    if (this.clearTimer !== null || this.writing) return;
    this.clearTimer = this.clock.after(
      this.debounceMs,
      () => {
        this.clearTimer = null;
        void this.write();
      },
      { unref: true },
    );
  }

  // [LAW:effects-at-boundaries] The debounced write takes all of its disk I/O
  // off the daemon's one thread: the bytes are written and synced through the
  // thread pool, and so is the rename that publishes them. A rename is a
  // journaled metadata op, and on a busy disk it waits on the journal like
  // any write: run synchronously here it held every bar and click for 180 ms
  // on a CI runner, past every client's reply budget.
  private async write(): Promise<void> {
    // [LAW:one-source-of-truth] A save is owed until a write made after it
    // lands, so the close's flush still writes while this one is on its way.
    const upTo = this.saves;
    if (upTo === this.written) return;
    const generation = this.generation;
    const started = this.clock.monotonic();
    const body = this.body();
    const tmp = this.writingPath;
    this.writing = true;
    // The thread is held until the first await.
    const heldMs = elapsedMs(this.clock, started);
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
          `${this.name} write superseded by a flush landed=${landed} took=${elapsedMs(this.clock, started)}ms held=${heldMs}ms`,
        );
        return;
      }
      this.saved(body, started, heldMs);
      this.written = Math.max(this.written, upTo);
    } catch (e) {
      this.refused(e);
    } finally {
      this.writing = false;
      // A save that arrived while this one was written is written next. A
      // write that failed stays owed for the next save or the close's flush,
      // so a disk that keeps refusing is not retried on a timer.
      if (this.saves > upTo) this.schedule();
    }
  }

  // The synchronous write, for the daemon's close.
  flush(): void {
    this.clearTimer?.();
    this.clearTimer = null;
    const upTo = this.saves;
    if (upTo === this.written) return;
    const started = this.clock.monotonic();
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const body = this.body();
      // [LAW:single-enforcer] Daemon runtime files are owner-only (0o600), like
      // pid/spawn.lock. Stores carry conversation identifiers, so they get the
      // same perms — chmod defeats umask and re-perms a reused tmp.
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      // [LAW:no-ambient-temporal-coupling] The debounced write's temp file goes
      // just before this write lands, whatever its rename is doing on the
      // thread pool: a rename and an unlink of one directory entry cannot
      // interleave, so either the older state landed already and is
      // overwritten below, or its rename finds nothing. Newer state is never
      // put back under older. A flush the disk refuses before this point
      // discards nothing; one it refuses at the rename below leaves both
      // writes saying they failed, and the newer state owed for the next
      // save.
      fs.rmSync(this.writingPath, { force: true });
      fs.renameSync(tmp, this.filePath);
      this.generation++;
      this.saved(body, started, elapsedMs(this.clock, started));
      // Caught up only once the rename lands, so a transient EIO/ENOSPC
      // leaves the write owed for a later flush rather than dropping it.
      this.written = upTo;
    } catch (e) {
      this.refused(e);
    }
  }

  private refused(e: unknown): void {
    const reason = `${this.name} save failed: ${(e as Error).message}`;
    this.logger("warn", reason);
    this.failed(reason);
  }

  // [LAW:nothing-unseen] Every write says what it wrote, how long it took, and
  // how much of that it held the daemon's one thread.
  private saved(body: string, started: Monotonic, heldMs: number): void {
    this.logger(
      "info",
      `${this.name} saved bytes=${Buffer.byteLength(body)} took=${elapsedMs(this.clock, started)}ms held=${heldMs}ms`,
    );
  }
}
