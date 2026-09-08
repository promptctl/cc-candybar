import fs from "node:fs";
import path from "node:path";

// [LAW:no-shared-mutable-globals] The one owner of this directory.
// [LAW:one-source-of-truth] It MIRRORS render state: a session's file exists iff
// its last render carried a diagnostic, and `sync` touches disk only on a change.
export class DiagnosticDump {
  private readonly written = new Map<string, string>();

  constructor(private readonly dir: string) {}

  pathFor(sessionId: string): string {
    return path.join(this.dir, `${encodeURIComponent(sessionId)}.txt`);
  }

  // Best-effort beside the strip, which already shows the text: a failed write
  // returns its reason and leaves the memory alone, so the next render retries.
  sync(sessionId: string, text: string | null): string | null {
    const file = this.pathFor(sessionId);
    const last = this.written.get(sessionId) ?? null;
    if (text === last) return null;
    try {
      if (text === null) {
        fs.rmSync(file, { force: true });
        this.written.delete(sessionId);
      } else {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, text, { mode: 0o600 });
        this.written.set(sessionId, text);
      }
      return null;
    } catch (e) {
      return `${file}: ${(e as Error).message}`;
    }
  }

  // A refused wipe is a reason, never a throw that takes the daemon down.
  reset(): string | null {
    this.written.clear();
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      return null;
    } catch (e) {
      return `${this.dir}: ${(e as Error).message}`;
    }
  }
}
