import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { daemonDir } from "./paths";
import { dlog, type DaemonLogger } from "./log";

// [LAW:single-enforcer] One module owns "when does the daemon plan to die".
// Only the RSS trigger remains — idle and age limits were removed because they
// interrupted active sessions. The RSS limit is a true anomaly backstop; normal
// operation should never approach it now that transcript parsing is pruned.
//
// [LAW:one-source-of-truth] The daemon's memory budget is ONE number, read from
// ONE place. Two limits derive from it and their ORDER is the whole point:
//
//   RSS backstop (this module)   — graceful: heap snapshot, logged shutdown,
//                                  clean restart on the next tick.
//   V8 old-space cap (spawners)  — hard: V8 aborts with SIGABRT below every JS
//                                  handler, so no log line, no snapshot, and
//                                  the next daemon finds only a stale socket.
//
// The cap sits at HEAP_CAP_OVER_RSS × the backstop so the graceful path is the
// one that fires. Before this the two were unrelated literals (400 MB heap in
// each spawner, 512 MB RSS here): a cold daemon seeding a large transcript tree
// for a dozen sessions blew the heap in seconds, aborted silently, and crash-
// looped on every render tick while the backstop — a 60 s poll — never got a
// turn. Raising the env override raises BOTH, because both spawners derive the
// cap through heapCapMb below. The Rust client mirrors RSS_LIMIT_ENV,
// DEFAULT_RSS_LIMIT_MB, and HEAP_CAP_OVER_RSS as literals
// (rust-client/src/launch.rs); scripts/check-protocol.mjs fails the build on
// drift.
export const RSS_LIMIT_ENV = "CC_CANDYBAR_RSS_LIMIT_MB";
export const DEFAULT_RSS_LIMIT_MB = 2048;
export const HEAP_CAP_OVER_RSS = 2;

// [LAW:parse-dont-validate] Absent → default; a positive integer → that; present
// but malformed → throw. Only an operator ever sets this variable, so garbage
// is an operator error, and `|| default` would silently run at a budget they
// did not ask for. [LAW:no-silent-failure]
export function rssLimitMb(env: NodeJS.ProcessEnv): number {
  const raw = env[RSS_LIMIT_ENV];
  if (raw === undefined) return DEFAULT_RSS_LIMIT_MB;
  const mb = Number.parseInt(raw, 10);
  if (!Number.isInteger(mb) || mb <= 0 || String(mb) !== raw.trim()) {
    throw new Error(
      `${RSS_LIMIT_ENV} must be a positive integer (MB), got ${JSON.stringify(raw)}`,
    );
  }
  return mb;
}

// The `--max-old-space-size` value a spawner hands node for the daemon.
export function heapCapMb(env: NodeJS.ProcessEnv): number {
  return rssLimitMb(env) * HEAP_CAP_OVER_RSS;
}

const DEFAULT_CHECK_INTERVAL = 60 * 1000;
const HEAP_SNAPSHOT_KEEP = 3;

export interface LimitsDeps {
  now: () => number;
  // [LAW:locality-or-seam] The snapshot directory, the log sink, and the
  // writer's identity are injected, not reached for ambiently. Without these,
  // unit tests of checkRss compute filenames against the real daemonDir() and
  // emit real dlog lines into the user's production daemon.log — the seam must
  // cover every dependency or it isn't a seam.
  pid: number;
  snapshotDir: string;
  log: DaemonLogger;
  rssBytes: () => number;
  writeHeapSnapshot: (filePath: string) => string;
  listSnapshots: () => string[];
  removeFile: (filePath: string) => void;
  shutdown: (code: number) => void;
  startedAtMs: number;
  rssLimitBytes?: number;
  snapshotsKeep?: number;
}

export interface LimitsHandle {
  checkRss(): boolean;
  describeNextRestart(): string | null;
  arm(intervalMs?: number): { disarm(): void };
}

export function makeLimits(deps: LimitsDeps): LimitsHandle {
  const rssLimit = deps.rssLimitBytes ?? DEFAULT_RSS_LIMIT_MB * 1024 * 1024;
  const keep = deps.snapshotsKeep ?? HEAP_SNAPSHOT_KEEP;
  let triggered = false;

  function checkRss(): boolean {
    if (triggered) return true;
    const rss = deps.rssBytes();
    if (rss <= rssLimit) return false;
    triggered = true;
    deps.log(
      "warn",
      `RSS ${rss} > limit ${rssLimit}; writing heap snapshot then shutting down`,
    );
    try {
      // [LAW:types-are-the-program] Uniqueness is by construction (the writer's
      // pid), not by trusting the clock to be real and sub-ms-distinct. Two
      // overlapping daemons hitting the wall in the same millisecond — or a
      // frozen `now` — still produce distinct files; the timestamp stays the
      // leading component so rotateSnapshots' newest-first ordering holds.
      const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
      const file = path.join(
        deps.snapshotDir,
        `heap-${stamp}-${deps.pid}.heapsnapshot`,
      );
      const written = deps.writeHeapSnapshot(file);
      deps.log("info", `heap snapshot written: ${written}`);
      rotateSnapshots(deps.listSnapshots(), keep, deps.removeFile);
    } catch (e) {
      deps.log("warn", `heap snapshot failed: ${(e as Error).message}`);
    }
    deps.shutdown(0);
    return true;
  }

  function describeNextRestart(): string | null {
    const rss = deps.rssBytes();
    if (rss > rssLimit * 0.75) {
      return `rss ${rss} approaching limit ${rssLimit}`;
    }
    return null;
  }

  function arm(intervalMs: number = DEFAULT_CHECK_INTERVAL): {
    disarm(): void;
  } {
    const timer = setInterval(() => {
      checkRss();
    }, intervalMs);
    timer.unref();
    return {
      disarm: () => clearInterval(timer),
    };
  }

  return { checkRss, describeNextRestart, arm };
}

function rotateSnapshots(
  files: string[],
  keep: number,
  remove: (p: string) => void,
): void {
  // Newest-first by basename (the leading ISO timestamp is lexically ordered;
  // the trailing -<pid> only tiebreaks same-instant writes). Sort by basename
  // so paths with different parent dirs still order correctly when the test
  // mock and production use different prefixes.
  const sorted = [...files].sort((a, b) => {
    const aBase = a.slice(a.lastIndexOf("/") + 1);
    const bBase = b.slice(b.lastIndexOf("/") + 1);
    return bBase.localeCompare(aBase);
  });
  for (const f of sorted.slice(keep)) {
    try {
      remove(f);
    } catch {}
  }
}

// Default real-fs deps for the daemon. Test code constructs its own.
export function realLimitsDeps(
  startedAtMs: number,
  shutdown: (code: number) => void,
  overrides: Partial<LimitsDeps> = {},
): LimitsDeps {
  // [LAW:one-source-of-truth] One captured dir backs both the new-snapshot path
  // and the listing used for rotation, so they can never read different dirs.
  const dir = daemonDir();
  return {
    now: () => Date.now(),
    pid: process.pid,
    snapshotDir: dir,
    log: dlog,
    // [LAW:effects-at-boundaries] The one env read for the backstop; the
    // spawners read the same function for the heap cap.
    rssLimitBytes: rssLimitMb(process.env) * 1024 * 1024,
    rssBytes: () => process.memoryUsage().rss,
    writeHeapSnapshot: (file) => v8.writeHeapSnapshot(file),
    listSnapshots: () => {
      try {
        return fs
          .readdirSync(dir)
          .filter((f) => f.startsWith("heap-") && f.endsWith(".heapsnapshot"))
          .map((f) => path.join(dir, f));
      } catch {
        return [];
      }
    },
    removeFile: (file) => fs.unlinkSync(file),
    shutdown,
    startedAtMs,
    ...overrides,
  };
}
