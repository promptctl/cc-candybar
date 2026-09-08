import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { daemonDir } from "./paths";
import { dlog, type DaemonLogger } from "./log";

// [LAW:single-enforcer] One module owns "when does the daemon plan to die" — an
// RSS backstop, the only trigger left. [LAW:one-source-of-truth] ONE budget, whose
// two limits are ORDERED: the graceful backstop must fire before V8's hard heap
// cap, which aborts below every JS handler with no log line and no snapshot.
export const RSS_LIMIT_ENV = "CC_CANDYBAR_RSS_LIMIT_MB";
export const DEFAULT_RSS_LIMIT_MB = 512;
export const HEAP_CAP_OVER_RSS = 2;

// [LAW:parse-dont-validate] Malformed throws, never falls back [LAW:no-silent-failure]:
// only an operator sets this, and both runtimes must apply one grammar verbatim.
export function rssLimitMb(env: NodeJS.ProcessEnv): number {
  const raw = env[RSS_LIMIT_ENV];
  if (raw === undefined) return DEFAULT_RSS_LIMIT_MB;
  const mb = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(mb) || mb <= 0) {
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

const BYTES_PER_MB = 1024 * 1024;

export function rssLimitBytes(env: NodeJS.ProcessEnv): number {
  return rssLimitMb(env) * BYTES_PER_MB;
}

const DEFAULT_CHECK_INTERVAL = 60 * 1000;
const HEAP_SNAPSHOT_KEEP = 3;

export interface LimitsDeps {
  now: () => number;
  // [LAW:locality-or-seam] Injected, never ambient — else tests write the real log.
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
  const rssLimit = deps.rssLimitBytes ?? DEFAULT_RSS_LIMIT_MB * BYTES_PER_MB;
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
      // [LAW:types-are-the-program] Unique by construction (the pid), not the clock.
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
  // Sort by BASENAME so paths under different parent dirs still order newest-first.
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

export function realLimitsDeps(
  startedAtMs: number,
  shutdown: (code: number) => void,
  overrides: Partial<LimitsDeps> = {},
): LimitsDeps {
  // [LAW:one-source-of-truth] One captured dir backs both the write and the listing.
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
