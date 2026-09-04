import fs from "node:fs";
import path from "node:path";

// [LAW:no-shared-mutable-globals] The one owner of the per-session diagnostic
// dump files — the complete diagnostic text the bar's strip links as a plain
// `file://` URL (src/render/diagnostic-strip.ts). Nothing else writes under
// its directory.
//
// [LAW:one-source-of-truth] The directory MIRRORS render state: a session's
// file exists iff that session's last render carried a diagnostic, and holds
// exactly the text that render showed an excerpt of. `sync` is the
// reconciler — it compares the desired text with what it last wrote and
// touches the disk only on a change, so a steady error costs no I/O per
// render and a repaired config removes its file on the next render.
//
// [LAW:carrying-cost] Bounded by construction: one file per session that has
// errored since the daemon started, and `reset` wipes the directory when the
// daemon starts (its memory of what it wrote is gone with the old process,
// so the files it named are stale by definition — like every other cold-
// rebuilt cache).
export class DiagnosticDump {
  private readonly written = new Map<string, string>();

  constructor(private readonly dir: string) {}

  // Pure: the path a session's dump lives at, whether or not it exists. The
  // strip names it before the daemon writes it, so the two agree by
  // construction rather than by return value.
  pathFor(sessionId: string): string {
    return path.join(this.dir, `${encodeURIComponent(sessionId)}.txt`);
  }

  // Bring the session's file in line with `text`: present with this content,
  // or absent when null.
  sync(sessionId: string, text: string | null): void {
    const file = this.pathFor(sessionId);
    // "Never written" and "absent" are the same desired state, so a session
    // that has never errored costs no syscall per render.
    const last = this.written.get(sessionId) ?? null;
    if (text === last) return;
    if (text === null) {
      fs.rmSync(file, { force: true });
      this.written.delete(sessionId);
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
    this.written.set(sessionId, text);
  }

  // Daemon start: forget everything, on disk and in memory.
  reset(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.written.clear();
  }
}
