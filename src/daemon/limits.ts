import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { daemonDir } from "./paths";
import { dlog, type DaemonLogger } from "./log";

// [LAW:single-enforcer] One module owns "when does the daemon plan to die".
// Only the RSS trigger remains — idle and age limits were removed because they
// interrupted active sessions. The RSS limit is a true anomaly backstop; normal
// operation should never approach it now that transcript parsing is pruned.
const DEFAULT_RSS_LIMIT =
  (parseInt(process.env["CC_CANDYBAR_RSS_LIMIT_MB"] ?? "", 10) || 512) *
  1024 *
  1024;
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
  const rssLimit = deps.rssLimitBytes ?? DEFAULT_RSS_LIMIT;
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
