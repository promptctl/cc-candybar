import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { daemonDir } from "./paths";
import { dlog } from "./log";

// [LAW:single-enforcer] One module owns "when does the daemon plan to die".
// Three triggers (RSS, age, idle-from-server.ts) all funnel into the same
// shutdown(0) path so cleanup is uniform.

const DEFAULT_RSS_LIMIT = 200 * 1024 * 1024;
const DEFAULT_AGE_LIMIT = 24 * 60 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL = 60 * 1000;
const HEAP_SNAPSHOT_KEEP = 3;

export interface LimitsDeps {
  now: () => number;
  rssBytes: () => number;
  writeHeapSnapshot: (filePath: string) => string;
  listSnapshots: () => string[];
  removeFile: (filePath: string) => void;
  shutdown: (code: number) => void;
  startedAtMs: number;
  rssLimitBytes?: number;
  ageLimitMs?: number;
  snapshotsKeep?: number;
}

export interface LimitsHandle {
  checkRss(): boolean;
  checkAge(): boolean;
  describeNextRestart(): string | null;
  arm(intervalMs?: number): { disarm(): void };
}

export function makeLimits(deps: LimitsDeps): LimitsHandle {
  const rssLimit = deps.rssLimitBytes ?? DEFAULT_RSS_LIMIT;
  const ageLimit = deps.ageLimitMs ?? DEFAULT_AGE_LIMIT;
  const keep = deps.snapshotsKeep ?? HEAP_SNAPSHOT_KEEP;
  let triggered = false;

  function checkRss(): boolean {
    if (triggered) return true;
    const rss = deps.rssBytes();
    if (rss <= rssLimit) return false;
    triggered = true;
    dlog(
      "warn",
      `RSS ${rss} > limit ${rssLimit}; writing heap snapshot then shutting down`,
    );
    try {
      const file = path.join(
        daemonDir(),
        `heap-${new Date(deps.now()).toISOString().replace(/[:.]/g, "-")}.heapsnapshot`,
      );
      const written = deps.writeHeapSnapshot(file);
      dlog("info", `heap snapshot written: ${written}`);
      rotateSnapshots(deps.listSnapshots(), keep, deps.removeFile);
    } catch (e) {
      dlog("warn", `heap snapshot failed: ${(e as Error).message}`);
    }
    deps.shutdown(0);
    return true;
  }

  function checkAge(): boolean {
    if (triggered) return true;
    const age = deps.now() - deps.startedAtMs;
    if (age <= ageLimit) return false;
    triggered = true;
    dlog("info", `age ${age}ms > limit ${ageLimit}ms; shutting down`);
    deps.shutdown(0);
    return true;
  }

  function describeNextRestart(): string | null {
    const rss = deps.rssBytes();
    const age = deps.now() - deps.startedAtMs;
    // Surface only when within 25% of either limit — otherwise the field is
    // noise for healthy daemons.
    if (rss > rssLimit * 0.75) {
      return `rss ${rss} approaching limit ${rssLimit}`;
    }
    if (age > ageLimit * 0.75) {
      return `age ${age}ms approaching limit ${ageLimit}ms`;
    }
    return null;
  }

  function arm(intervalMs: number = DEFAULT_CHECK_INTERVAL): {
    disarm(): void;
  } {
    const timer = setInterval(() => {
      if (checkRss()) return; // already triggered shutdown
      checkAge();
    }, intervalMs);
    timer.unref();
    return {
      disarm: () => clearInterval(timer),
    };
  }

  return { checkRss, checkAge, describeNextRestart, arm };
}

function rotateSnapshots(
  files: string[],
  keep: number,
  remove: (p: string) => void,
): void {
  // Newest-first by basename (ISO timestamp is lexically ordered). Sort by
  // basename so paths with different parent dirs still order correctly when
  // the test mock and production use different prefixes.
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
  return {
    now: () => Date.now(),
    rssBytes: () => process.memoryUsage().rss,
    writeHeapSnapshot: (file) => v8.writeHeapSnapshot(file),
    listSnapshots: () => {
      try {
        return fs
          .readdirSync(daemonDir())
          .filter((f) => f.startsWith("heap-") && f.endsWith(".heapsnapshot"))
          .map((f) => path.join(daemonDir(), f));
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
