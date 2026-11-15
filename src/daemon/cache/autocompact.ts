// Claude Code's auto-compact window: how full the context gets before Claude
// Code summarizes it. Its only writer is Claude Code's `/autocompact` command,
// which the bar types into the session (a `slash` action) — so the bar reads
// the value back from where that command stores it.
//
// Measured on Claude Code 2.1.285 (brandon-context-ceiling-xta.e3p):
//   - `/autocompact <tokens>` writes `autoCompactWindow` into the USER
//     settings file and applies it to the running session at once;
//     `/autocompact auto` deletes the key, handing the window back to Claude
//     Code's per-model tuning.
//   - It accepts 100,000 to 1,000,000 tokens and refuses the rest; a window
//     above the model's context window is capped to it.
//   - The statusline hook payload carries none of this.

import fs from "node:fs";
import { ObservableLru } from "../../utils/observable-lru.js";
import {
  RefreshLedger,
  type RefreshTrigger,
  type Refreshes,
} from "../../utils/refresh-ledger.js";
import type { SourceStats } from "../../utils/keyed-source.js";
import { quietLogger, type DaemonLogger } from "../../utils/logger.js";
import { valueOf } from "../../utils/logfmt.js";
import {
  failed,
  ok,
  pendingOf,
  type Outcome,
  type Reading,
} from "../../utils/outcome.js";
import { stampOf } from "../../utils/transcript-fs.js";
import { elapsedMs, type Timekeeper } from "../../time.js";
import { readClaudeSettingsOutcome } from "../../claude-settings-read.js";
import {
  LEAST,
  MOST,
  type AutoCompactWindow,
} from "../../segments/autocompact";

// How many settings files keep their last reading: one per Claude Code
// directory a session reported, which a user has few of.
const MAX_FILES = 64;

interface Known {
  readonly stamp: string;
  readonly outcome: Outcome<AutoCompactWindow>;
}

// [LAW:single-enforcer] The one owner of the auto-compact window
// (brandon-unfiled-3248.8ro6, step 1). Each session's transcript lanes ask
// (src/daemon/cache/transcript-lanes.ts), on a watch of this file and their
// period, and the file is read again only when its stamp moved — Claude Code
// rewrites it on `/autocompact`, and two sessions sharing one Claude Code
// directory read it once between them.
export class AutoCompactProvider {
  // Observable, so a view's payload over a window is recomputed in the turn
  // it is stored.
  private readonly known = new ObservableLru<string, Known>(MAX_FILES);
  private readonly refreshes: Refreshes<RefreshTrigger>;

  constructor(
    // [LAW:effects-at-boundaries] Times each read of the settings file.
    private readonly clock: Pick<Timekeeper, "monotonic">,
    logger: DaemonLogger = quietLogger,
    ledger: RefreshLedger = new RefreshLedger(logger),
  ) {
    this.refreshes = ledger.declare<RefreshTrigger>({
      name: "autocompact",
      scope: "configDir",
      refresh: ["first", "period", "change"],
    });
  }

  window(settingsPath: string, by: RefreshTrigger): Outcome<AutoCompactWindow> {
    const stamp = stampAt(settingsPath);
    const known = this.known.get(settingsPath);
    // [LAW:no-ambient-temporal-coupling] A hit is a use, which wakes no view:
    // a payload over the window recomputes only when a read stored a new one.
    if (known !== undefined && known.stamp === stamp) {
      this.known.touch(settingsPath);
      return known.outcome;
    }
    const startedAt = this.clock.monotonic();
    const outcome = readAutoCompactWindow(settingsPath);
    this.refreshes.recorded(
      `path=${valueOf(settingsPath)} stamp=${valueOf(stamp)}`,
      by,
      outcome,
      elapsedMs(this.clock, startedAt),
    );
    this.known.set(settingsPath, { stamp, outcome });
    return outcome;
  }

  // The window as the last refresh left it, for a draw: the file is not
  // touched.
  stored(settingsPath: string): Reading<AutoCompactWindow> {
    return this.known.get(settingsPath)?.outcome ?? pendingOf("unread");
  }

  getStats(): SourceStats {
    const { refreshes, failures, abandoned, lastMs } = this.refreshes.record();
    return { entries: this.known.size, refreshes, failures, abandoned, lastMs };
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

// [LAW:no-silent-failure] No key is Claude Code having written nothing —
// `auto`, exactly as Claude Code reads it. A file that does not read as a
// settings document, or a value `/autocompact` could not have written (a
// hand edit), is a refusal naming the file: the bar does not guess what
// Claude Code made of it.
export function readAutoCompactWindow(
  settingsPath: string,
): Outcome<AutoCompactWindow> {
  const read = readClaudeSettingsOutcome(settingsPath);
  if (read.kind !== "ok") return read;
  const window = read.value.autoCompactWindow;
  if (window === undefined) return ok("auto");
  return typeof window === "number" &&
    Number.isInteger(window) &&
    window >= LEAST &&
    window <= MOST
    ? ok(window)
    : failed(
        `${settingsPath}: autoCompactWindow is ${JSON.stringify(window)}, not a window /autocompact accepts (${LEAST}–${MOST} tokens)`,
        "parse",
      );
}
