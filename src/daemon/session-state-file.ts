import fs from "node:fs";
import path from "node:path";
import { debug } from "../utils/logger";
import type { DaemonLogger } from "./log";
import type { SessionSnapshot, SessionStorage } from "./session-state";

// [LAW:locality-or-seam] Logging is injected; this quiet default keeps unit tests off the real daemon log stream.
const quietLogger: DaemonLogger = (_level, message) => debug(message);

// [LAW:no-silent-fallbacks] Corrupt/missing → empty state is the DEFINED recovery, identical to a first-ever boot; anything off-shape is rejected here.
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
      // [LAW:single-enforcer] Owner-only, like pid/spawn.lock — chmod defeats umask and re-perms a reused tmp.
      fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.filePath);
      // [LAW:one-source-of-truth] Clear `pending` only once the rename lands, so a transient EIO leaves the snapshot for a later flush to retry.
      this.pending = null;
    } catch (e) {
      this.logger("warn", `session-state save failed: ${(e as Error).message}`);
    }
  }
}
