// --- binary self-restart ---
//
// If the daemon's compiled output changes on disk (rebuild, upgrade, edit) or
// stops existing (a pruned `pnpm dlx` cache, a moved or deleted checkout),
// exit at the next sample so the next client respawns from code a file holds.
// Cheap (one stat per target a minute); the timer is unref()'d so it never
// holds the process alive. `checkNow` is the same sampler the interval runs,
// for the moment the daemon itself changed the bundle (the update notice's
// rebuild) and need not wait a minute to notice.

import type { DaemonLogger } from "./log";

// [LAW:types-are-the-program] What one stat says about a target. `gone` is
// the file (or a directory above it) no longer existing — the bundle the
// daemon runs is no longer on disk. `unread` is every other failure (EACCES,
// EIO): it says nothing about the bundle, so it can neither match nor move it.
export type BundleStamp =
  | { readonly kind: "present"; readonly mtimeMs: number }
  | { readonly kind: "gone" }
  | { readonly kind: "unread"; readonly error: string };

/** `fs.statSync`'s shape: the edge the watch reads the disk through. */
export type BundleStat = (path: string) => { readonly mtimeMs: number };

const GONE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

export function stampOf(path: string, stat: BundleStat): BundleStamp {
  try {
    return { kind: "present", mtimeMs: stat(path).mtimeMs };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== undefined && GONE_CODES.has(code)
      ? { kind: "gone" }
      : { kind: "unread", error: (e as Error).message };
  }
}

function sameStamp(a: BundleStamp, b: BundleStamp): boolean {
  if (a.kind === "present" && b.kind === "present")
    return a.mtimeMs === b.mtimeMs;
  return a.kind === b.kind;
}

export interface BinaryWatchOptions {
  readonly targets: readonly string[];
  readonly intervalMs: number;
  readonly stat: BundleStat;
  /** The daemon's one exit funnel; called once, when a target moved. */
  readonly exit: () => void;
  readonly log: DaemonLogger;
}

export interface BinaryWatch {
  arm(): void;
  checkNow(): void;
}

export function makeBinaryWatch(opts: BinaryWatchOptions): BinaryWatch {
  const { targets, intervalMs, stat, exit, log } = opts;
  // The stamps the daemon booted with, taken the same way every sample is.
  const boot = targets.map((path) => ({ path, stamp: stampOf(path, stat) }));
  let timer: NodeJS.Timeout | null = null;
  const sample = (): void => {
    for (const { path, stamp } of boot) {
      const now = stampOf(path, stat);
      if (now.kind === "unread") {
        log("warn", `binary stat failed (${path}): ${now.error}`);
        continue;
      }
      if (!sameStamp(stamp, now)) {
        log(
          "info",
          `binary ${now.kind === "gone" ? "gone" : "changed"} (${path}); shutting down`,
        );
        if (timer) clearInterval(timer);
        exit();
        return;
      }
    }
  };
  return {
    arm() {
      timer = setInterval(sample, intervalMs);
      timer.unref();
    },
    checkNow: sample,
  };
}
