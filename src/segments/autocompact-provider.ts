import fs from "node:fs";
import {
  readAutoCompactWindow,
  type AutoCompactWindow,
} from "./autocompact.js";
import { Refreshes, type SourceStats } from "../utils/keyed-source.js";
import { quietLogger, type DaemonLogger } from "../utils/logger.js";
import { valueOf } from "../utils/logfmt.js";
import { PENDING, type Outcome, type Reading } from "../utils/outcome.js";
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
  private readonly refreshes: Refreshes<"request">;

  constructor(logger: DaemonLogger = quietLogger) {
    this.refreshes = new Refreshes("autocompact", ["request"], logger);
  }

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
    this.refreshes.recorded(
      `path=${valueOf(settingsPath)} stamp=${valueOf(stamp)}`,
      "request",
      outcome,
      Date.now() - startedAt,
    );
    this.known.set(settingsPath, { stamp, outcome });
    for (const oldest of this.known.keys()) {
      if (this.known.size <= MAX_FILES) break;
      this.known.delete(oldest);
    }
    return outcome;
  }

  // The window as the last request left it, for a draw: the file is not
  // touched.
  stored(settingsPath: string): Reading<AutoCompactWindow> {
    return this.known.get(settingsPath)?.outcome ?? PENDING;
  }

  getStats(): SourceStats<"request"> {
    return this.refreshes.stats(this.known.size);
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
