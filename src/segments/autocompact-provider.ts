import fs from "node:fs";
import {
  readAutoCompactWindow,
  type AutoCompactWindow,
} from "./autocompact.js";
import type { SourceStats } from "../utils/keyed-source.js";
import { quietLogger, type DaemonLogger } from "../utils/logger.js";
import type { Outcome } from "../utils/outcome.js";
import { stampOf } from "../utils/transcript-fs.js";

// How many settings files keep their last reading: one per Claude Code
// directory a session reported, which a user has few of.
const MAX_FILES = 64;

interface Known {
  readonly stamp: string;
  readonly outcome: Outcome<AutoCompactWindow>;
}

// [LAW:single-enforcer] The one owner of the auto-compact window
// (brandon-unfiled-3248.8ro6, step 1). Each statusline request asks, and the
// file is read again only when its stamp moved — Claude Code rewrites it on
// `/autocompact`, so the session's next request reads what it wrote, and two
// sessions sharing one Claude Code directory read it once between them.
export class AutoCompactProvider {
  private readonly known = new Map<string, Known>();
  private reads = 0;
  private failures = 0;

  constructor(private readonly logger: DaemonLogger = quietLogger) {}

  window(settingsPath: string): Outcome<AutoCompactWindow> {
    const stamp = stampAt(settingsPath);
    const known = this.known.get(settingsPath);
    // LRU touch: re-inserting moves the file to the newest end.
    this.known.delete(settingsPath);
    if (known !== undefined && known.stamp === stamp) {
      this.known.set(settingsPath, known);
      return known.outcome;
    }
    const startedAt = Date.now();
    const outcome = readAutoCompactWindow(settingsPath);
    this.recorded(settingsPath, stamp, outcome, Date.now() - startedAt);
    this.known.set(settingsPath, { stamp, outcome });
    for (const oldest of this.known.keys()) {
      if (this.known.size <= MAX_FILES) break;
      this.known.delete(oldest);
    }
    return outcome;
  }

  getStats(): SourceStats<"request"> {
    return {
      entries: this.known.size,
      refreshes: { request: this.reads },
      failures: this.failures,
    };
  }

  // [LAW:no-silent-failure] One event per read, a failed one at warn: a
  // request answered from the stored reading never logs it again.
  private recorded(
    settingsPath: string,
    stamp: string,
    outcome: Outcome<AutoCompactWindow>,
    took: number,
  ): void {
    this.reads++;
    if (outcome.kind === "failed") this.failures++;
    const why =
      outcome.kind === "failed"
        ? ` reason=${JSON.stringify(outcome.reason)}`
        : "";
    this.logger(
      outcome.kind === "failed" ? "warn" : "info",
      `autocompact refresh ${JSON.stringify(settingsPath)} by=request stamp=${stamp} outcome=${outcome.kind}${why} took=${took}ms`,
    );
  }
}

// What a read of the file would find, as one stat sees it: its `mtime:size`,
// its absence, or the error a stat could not see past — each a stamp, so a
// failure that persists is read (and logged) once. The stat comes before the
// read, so a write landing between them moves the next stat and is read then.
function stampAt(settingsPath: string): string {
  try {
    const st = fs.statSync(settingsPath, { throwIfNoEntry: false });
    return st === undefined ? "absent" : stampOf(st);
  } catch (e) {
    return `unread:${(e as NodeJS.ErrnoException).code ?? "error"}`;
  }
}
