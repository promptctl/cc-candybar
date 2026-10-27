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
  // Counts synchronous flushes: a debounced write begun before the latest one
  // is older than what it wrote.
  private generation = 0;

  constructor(
    private readonly filePath: string,
    private readonly debounceMs: number = 500,
    // [LAW:locality-or-seam] Logging is injected, not hard-wired to
    // daemon.log: the daemon passes `dlog`, every other caller stays quiet.
    private readonly logger: DaemonLogger = quietLogger,
  ) {}

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

  // [LAW:effects-at-boundaries] The debounced write takes its disk I/O off the
  // daemon's one thread: the bytes are written and synced through the thread
  // pool, so the rename that publishes them is a metadata step with nothing
  // left to flush. A synchronous write here held every bar and click for as
  // long as the disk took, hundreds of milliseconds on a busy one.
  private async write(): Promise<void> {
    const snapshot = this.pending;
    if (snapshot === null) return;
    const generation = this.generation;
    const started = performance.now();
    const body = JSON.stringify(snapshot);
    const tmp = `${this.filePath}.writing`;
    this.writing = true;
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
      // put older state back.
      if (generation !== this.generation) {
        await fs.promises.rm(tmp, { force: true });
        return;
      }
      const held = performance.now();
      fs.renameSync(tmp, this.filePath);
      this.saved(body, snapshot, started, performance.now() - held);
      if (this.pending === snapshot) this.pending = null;
    } catch (e) {
      this.logger("warn", `session-state save failed: ${(e as Error).message}`);
    } finally {
      this.writing = false;
      if (this.pending !== null) this.schedule();
    }
  }

  // The synchronous write, for shutdown and for callers that read the file
  // back at once.
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.generation++;
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
      fs.renameSync(tmp, this.filePath);
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
