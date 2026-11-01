// --- binary self-restart ---
//
// If the daemon's compiled output changes on disk (rebuild, upgrade, edit) or
// stops existing (a pruned `pnpm dlx` cache, a moved or deleted checkout),
// exit at the next sample so the next client respawns from code a file holds.
// Cheap (one stat per target a minute); the timer is unref()'d so it never
// holds the process alive. `checkNow` is the same sampler the interval runs,
// for the moment the daemon itself changed the bundle (the update notice's
// rebuild) and need not wait a minute to notice.
//
// [LAW:no-ambient-temporal-coupling] A sample awaits `held`, which waits on the
// update watch's act queue, so `ended` is read after that await: of two samples
// overlapping there, or one the close landed on, none exits twice or late.

import { changeLogger, type DaemonLogger } from "../utils/logger";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";

/** `fs.statSync`'s shape: the edge the watch reads the disk through. */
export type BundleStat = (path: string) => { readonly mtimeMs: number };

// [LAW:one-type-per-behavior] A target's stamp is the provider outcome over
// its mtime: `absent` is the file (or a directory above it) no longer
// existing — the bundle the daemon runs is no longer on disk; `failed` is
// every other stat failure (EACCES, EIO), which says nothing about the bundle.
function mtimeOf(path: string, stat: BundleStat): Outcome<number> {
  try {
    return ok(stat(path).mtimeMs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? ABSENT
      : failed((e as Error).message);
  }
}

function sameStamp(a: Outcome<number>, b: Outcome<number>): boolean {
  return a.kind === "ok" && b.kind === "ok"
    ? a.value === b.value
    : a.kind === b.kind;
}

export interface BinaryWatchOptions {
  readonly targets: readonly string[];
  readonly intervalMs: number;
  readonly stat: BundleStat;
  /** True while something the restart would kill is rewriting the bundle. */
  readonly held: () => Promise<boolean>;
  /** The daemon's one exit funnel, which owns running only once. */
  readonly exit: () => void;
  readonly log: DaemonLogger;
}

export interface BinaryWatch {
  arm(): void;
  // Settles when this check has run; never rejects, so it can be left running.
  checkNow(): Promise<void>;
  close(): void;
}

export function makeBinaryWatch(opts: BinaryWatchOptions): BinaryWatch {
  const { targets, intervalMs, stat, held, exit, log } = opts;
  const logHeld = changeLogger(log);
  // The stamps the daemon booted with, taken the same way every sample is.
  const boot = targets.map((path) => ({ path, stamp: mtimeOf(path, stat) }));
  // [LAW:types-are-the-program] A stat that failed at boot leaves nothing to
  // compare against: that target is reported once, when the watch arms, and
  // not watched. A stat failing later says nothing about the bundle either,
  // so it can neither match nor move the stamp.
  const watched = boot.filter(({ stamp }) => stamp.kind !== "failed");
  let timer: NodeJS.Timeout | null = null;
  // Ended by the exit or the close: a check after either decides nothing.
  let ended = false;
  const end = (): void => {
    ended = true;
    if (timer) clearInterval(timer);
  };
  const sample = async (): Promise<void> => {
    if (ended) return;
    for (const { path, stamp } of watched) {
      const now = mtimeOf(path, stat);
      if (now.kind === "failed") {
        log("warn", `binary stat failed (${path}): ${now.reason}`);
        continue;
      }
      if (!sameStamp(stamp, now)) {
        const what = `binary ${now.kind === "absent" ? "gone" : "changed"} (${path})`;
        const waiting = await held();
        if (ended) return;
        if (waiting) {
          logHeld([
            "info",
            `${what}; the restart waits for the running update`,
          ]);
          return;
        }
        log("info", `${what}; shutting down`);
        end();
        exit();
        return;
      }
    }
  };
  // [LAW:no-silent-failure] Nothing awaits a check, and a rejection nobody
  // holds is the daemon's death (server.ts): a check that failed is logged, and
  // the next one looks again.
  const check = (): Promise<void> =>
    sample().catch((e: unknown) => {
      log("error", `binary check failed: ${(e as Error).message}`);
    });
  return {
    arm() {
      for (const { path, stamp } of boot) {
        if (stamp.kind === "failed") {
          log(
            "warn",
            `binary stat failed at boot (${path}): ${stamp.reason}; not watched`,
          );
        }
      }
      timer = setInterval(() => void check(), intervalMs);
      timer.unref();
    },
    checkNow: check,
    close: end,
  };
}
