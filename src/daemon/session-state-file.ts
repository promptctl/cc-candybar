import fs from "node:fs";
import path from "node:path";
import { debug } from "../utils/logger";
import type { DaemonLogger } from "./log";
import type { SessionSnapshot, SessionStorage } from "./session-state";

// [LAW:locality-or-seam] Logging is injected, not hard-wired to daemon.log.
// The daemon passes `dlog`; tests and non-daemon callers take this quiet
// default, which stays silent unless CC_CANDYBAR_DEBUG is set — so unit tests
// never open the real daemon log stream.
const quietLogger: DaemonLogger = (_level, message) => debug(message);

// [LAW:no-silent-fallbacks] Corrupt/missing file → empty state is the *defined*
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

  constructor(
    private readonly filePath: string,
    private readonly debounceMs: number = 500,
    private readonly logger: DaemonLogger = quietLogger,
  ) {}

  load(): SessionSnapshot {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      // [LAW:no-silent-fallbacks] A missing file is the expected first-boot
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
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const snapshot = this.pending;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      // [LAW:single-enforcer] Daemon runtime files are owner-only (0o600), like
      // pid/spawn.lock. Session state carries conversation identifiers, so it
      // gets the same perms — chmod defeats umask and re-perms a reused tmp.
      fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.filePath);
      // [LAW:one-source-of-truth] `pending` is "state not yet durably written".
      // Clear it only once the rename lands, so a transient EIO/ENOSPC leaves
      // the snapshot for a later flush (e.g. shutdown) to retry rather than
      // silently dropping the last known state.
      this.pending = null;
    } catch (e) {
      this.logger("warn", `session-state save failed: ${(e as Error).message}`);
    }
  }
}
