import fs from "node:fs";
import path from "node:path";
import { dlog } from "./log";
import type { SessionSnapshot, SessionStorage } from "./session-state";

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
  ) {}

  load(): SessionSnapshot {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSnapshot(parsed)) return parsed;
      dlog("warn", `session-state load: unexpected shape, starting empty`);
      return {};
    } catch {
      dlog("warn", `session-state load: corrupt JSON, starting empty`);
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
    this.pending = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      dlog("warn", `session-state save failed: ${(e as Error).message}`);
    }
  }
}
