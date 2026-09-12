import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { daemonDir } from "./paths";
import { dlog, type DaemonLogger } from "./log";
import { memoryReport, platformProbes } from "./memory-report";

// [LAW:single-enforcer] One module owns "when does the daemon plan to die".
// Only the RSS trigger remains — idle and age limits were removed because they
// interrupted active sessions. The RSS limit is a true anomaly backstop; normal
// operation should never approach it now that transcript parsing is pruned.
//
// How much of the budget is even reachable by eviction was measured rather than
// assumed (brandon-daemon-limits-inw): on the live daemon roughly 50 MB of RSS is
// clean file-backed code plus kernel page tables that no cache can release, so a
// 512 MB budget is about 460 MB of controllable memory. The same measurement is
// why a breach records more than a heap snapshot — see checkRss.
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
// The cap sits at HEAP_CAP_OVER_RSS × the backstop, a margin wide enough that
// the graceful path fires first under any growth the 60 s poll can see (a
// burst that doubles RSS inside one poll window can still reach the hard cap).
// Before this the two were unrelated literals (400 MB heap in each spawner,
// 512 MB RSS here), and the 2026-09-03 outage found the gap: a daemon holding
// twenty configs' worth of duplicated helper-template ASTs (since fixed in
// src/dsl/render.ts compileHelpers) blew the heap in seconds, aborted
// silently, and crash-looped on every render tick while the backstop — a 60 s
// poll — never got a turn. Raising the env override raises BOTH, because both
// spawners derive the cap through heapCapMb below. The Rust client mirrors
// RSS_LIMIT_ENV, DEFAULT_RSS_LIMIT_MB, and HEAP_CAP_OVER_RSS as literals
// (rust-client/src/launch.rs); scripts/check-protocol.mjs fails the build on
// drift.
export const RSS_LIMIT_ENV = "CC_CANDYBAR_RSS_LIMIT_MB";
export const DEFAULT_RSS_LIMIT_MB = 512;
export const HEAP_CAP_OVER_RSS = 2;

// [LAW:parse-dont-validate] Absent → default; a positive integer → that; present
// but malformed → throw. Only an operator ever sets this variable, so garbage
// is an operator error, and `|| default` would silently run at a budget they
// did not ask for. [LAW:no-silent-failure]
//
// [LAW:one-source-of-truth] The grammar is ONE rule both runtimes apply
// verbatim — ASCII digits only, > 0, within the safe-integer range —
// so the spawner and the daemon it spawns accept and reject the same values
// (rust-client/src/launch.rs heap_cap_mb). A grammar that differed by so much
// as a leading `+` would let a client spawn a daemon that refuses to boot.
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

// The budget in the unit `process.memoryUsage().rss` reports.
export function rssLimitBytes(env: NodeJS.ProcessEnv): number {
  return rssLimitMb(env) * BYTES_PER_MB;
}

const DEFAULT_CHECK_INTERVAL = 60 * 1000;
const HEAP_SNAPSHOT_KEEP = 3;

// [LAW:one-source-of-truth] The artifacts a breach leaves, spelled ONCE. The
// writer names them from this table, the real lister filters by it, and rotation
// strips it to recover the `<stamp>-<pid>` identity the pair shares. Three
// independent spellings of one pair — which is what adding the memory report
// naively produced — is exactly how a rotation quietly stops matching what the
// writer emits, leaving a directory that grows forever or a heap snapshot whose
// attribution was evicted from under it.
const BREACH_ARTIFACTS = {
  memoryReport: { prefix: "memory-", suffix: ".txt" },
  heapSnapshot: { prefix: "heap-", suffix: ".heapsnapshot" },
} as const;

type BreachArtifact = keyof typeof BREACH_ARTIFACTS;

function artifactFile(
  dir: string,
  kind: BreachArtifact,
  identity: string,
): string {
  const { prefix, suffix } = BREACH_ARTIFACTS[kind];
  return path.join(dir, `${prefix}${identity}${suffix}`);
}

// Every artifact of a breach answers to its own affix pair; anything else in the
// directory is not ours to rotate.
function breachArtifactOf(base: string): BreachArtifact | null {
  for (const kind of Object.keys(BREACH_ARTIFACTS) as BreachArtifact[]) {
    const { prefix, suffix } = BREACH_ARTIFACTS[kind];
    if (base.startsWith(prefix) && base.endsWith(suffix)) return kind;
  }
  return null;
}

// What the backstop measures, in the units process.memoryUsage() reports. RSS is
// what the kernel bills and therefore what the limit is on; heapTotal is the part
// V8 admits to, and the gap between them is the whole reason this module writes
// an attribution artifact rather than only a heap snapshot.
export interface MemorySizes {
  readonly rss: number;
  readonly heapTotal: number;
}

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
  // [LAW:one-source-of-truth] ONE read, both numbers. `process.memoryUsage()`
  // returns them together, so two deps would be two reads that could disagree
  // about the same instant — and every message here that mentions RSS also wants
  // to say how much of it is V8, which is the difference between "a cache to
  // fix" and "something a heap snapshot cannot show you".
  memoryBytes: () => MemorySizes;
  // The platform's own attribution of this process's resident memory, as text.
  // Total by contract (src/daemon/memory-report.ts): it reports which probe
  // could not answer rather than throwing, because the caller is already dying.
  captureMemoryReport: () => string;
  writeMemoryReport: (filePath: string, text: string) => void;
  writeHeapSnapshot: (filePath: string) => string;
  // Every artifact a breach leaves behind, for rotation — both kinds.
  listArtifacts: () => string[];
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
    const { rss, heapTotal } = deps.memoryBytes();
    if (rss <= rssLimit) return false;
    triggered = true;
    deps.log(
      "warn",
      `RSS ${rss} > limit ${rssLimit} (v8 heap ${heapTotal}); recording memory then shutting down`,
    );
    // [LAW:types-are-the-program] Uniqueness is by construction (the writer's
    // pid), not by trusting the clock to be real and sub-ms-distinct. Two
    // overlapping daemons hitting the wall in the same millisecond — or a frozen
    // `now` — still produce distinct files; the timestamp stays the leading
    // component so rotation's newest-first ordering holds. Both of a breach's
    // artifacts share this identity, which is what makes them one post-mortem.
    const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
    const identity = `${stamp}-${deps.pid}`;

    // [LAW:no-ambient-temporal-coupling] The attribution goes FIRST. Writing a
    // heap snapshot allocates and can move hundreds of megabytes, so a reading
    // taken after it would describe the state the snapshot produced rather than
    // the state that tripped the limit.
    //
    // [LAW:no-silent-failure] Each artifact is attempted on its own: one
    // failing must not cost the other, and either failure is named in the log
    // where the post-mortem will look for it.
    attempt(deps.log, "memory report", () => {
      const file = artifactFile(deps.snapshotDir, "memoryReport", identity);
      deps.writeMemoryReport(file, deps.captureMemoryReport());
      deps.log("info", `memory report written: ${file}`);
    });
    attempt(deps.log, "heap snapshot", () => {
      const file = artifactFile(deps.snapshotDir, "heapSnapshot", identity);
      deps.log(
        "info",
        `heap snapshot written: ${deps.writeHeapSnapshot(file)}`,
      );
    });
    attempt(deps.log, "artifact rotation", () => {
      rotateBreaches(deps.listArtifacts(), keep, deps.removeFile);
    });
    deps.shutdown(0);
    return true;
  }

  function describeNextRestart(): string | null {
    const { rss, heapTotal } = deps.memoryBytes();
    if (rss > rssLimit * 0.75) {
      // The heap share is the actionable half of the sentence: growth inside V8
      // is a cache to fix, growth outside it is not, and the reader cannot tell
      // which from an RSS number alone.
      return `rss ${rss} approaching limit ${rssLimit} (v8 heap ${heapTotal})`;
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

// [LAW:no-silent-failure] The death path's one shape for "do this, and if it
// fails say which thing failed and carry on to the next". Swallowing would leave
// a breach with no artifacts and no explanation; throwing would skip the
// shutdown.
function attempt(log: DaemonLogger, what: string, body: () => void): void {
  try {
    body();
  } catch (e) {
    log("warn", `${what} failed: ${(e as Error).message}`);
  }
}

// [LAW:types-are-the-program] Rotation's unit is the BREACH, not the file. A
// breach leaves a heap snapshot AND a memory report sharing one `<stamp>-<pid>`
// identity, so counting files would keep one and a half post-mortems and evict
// half of another — leaving a heap snapshot whose attribution is gone, which is
// the pairing this whole change exists to create.
function breachIdentity(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const kind = breachArtifactOf(base);
  // A file we did not write keeps its whole name as its identity, so it groups
  // alone and is rotated on its own terms rather than pairing with a real breach.
  if (kind === null) return base;
  const { prefix, suffix } = BREACH_ARTIFACTS[kind];
  return base.slice(prefix.length, base.length - suffix.length);
}

function rotateBreaches(
  files: string[],
  keep: number,
  remove: (p: string) => void,
): void {
  // Newest-first by identity (the leading ISO timestamp is lexically ordered;
  // the trailing -<pid> only tiebreaks same-instant writes). Grouping by
  // identity rather than sorting paths is also what keeps a breach's two files
  // adjacent regardless of which prefix sorts first.
  const byIdentity = new Map<string, string[]>();
  for (const f of files) {
    const id = breachIdentity(f);
    const group = byIdentity.get(id);
    if (group === undefined) byIdentity.set(id, [f]);
    else group.push(f);
  }
  const newestFirst = [...byIdentity.keys()].sort((a, b) => b.localeCompare(a));
  for (const id of newestFirst.slice(keep)) {
    for (const f of byIdentity.get(id) ?? []) {
      try {
        remove(f);
      } catch {}
    }
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
    memoryBytes: () => {
      // One call, both numbers — see the dep's comment.
      const mem = process.memoryUsage();
      return { rss: mem.rss, heapTotal: mem.heapTotal };
    },
    captureMemoryReport: () =>
      memoryReport(platformProbes(process.platform, process.pid)),
    // 0600 like the heap snapshot v8 writes beside it: the pair shares an
    // identity, so it shares a permission — a post-mortem pair where one half is
    // world-readable and the other is not invites exactly the "is this
    // sensitive?" question at the worst moment to be asking it.
    writeMemoryReport: (file, text) =>
      fs.writeFileSync(file, text, { mode: 0o600 }),
    writeHeapSnapshot: (file) => v8.writeHeapSnapshot(file),
    listArtifacts: () => {
      try {
        return fs
          .readdirSync(dir)
          .filter((f) => breachArtifactOf(f) !== null)
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
