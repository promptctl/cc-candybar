import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { daemonDir } from "./paths";
import { writeWaitingNow } from "./log";
import { type DaemonLogger } from "../utils/logger";
import {
  chargeProbe,
  memoryReport,
  platformProbes,
  type ChargeProbe,
  type MemoryCharge,
} from "./memory-report";
import type { Launcher } from "../proc/launch";

// [LAW:single-enforcer] One module owns "when does the daemon plan to die".
// Only the memory trigger remains — idle and age limits were removed because they
// interrupted active sessions. The memory limit is a true anomaly backstop; normal
// operation should never approach it now that transcript parsing is pruned.
//
// How much of the budget is even reachable by eviction was measured rather than
// assumed (brandon-daemon-limits-inw): on the live daemon roughly 50 MB of memory is
// clean file-backed code plus kernel page tables that no cache can release, so
// that much of any budget is out of eviction's reach. The same measurement is
// why a breach records more than a heap snapshot — see check.
//
// The limit is on what the PLATFORM charges the process (MemoryCharge,
// memory-report.ts): phys_footprint on macOS, RSS on Linux. macOS RSS counts
// the pages malloc has freed and marked reusable, so judged on it the backstop
// killed daemons holding 342 and 386 MB of a 512 MB budget
// (brandon-unfiled-3248.2j3m).
//
// [LAW:one-source-of-truth] The daemon's memory budget is ONE number, read from
// ONE place. Two limits derive from it and their ORDER is the whole point:
//
//   memory backstop (this module) — graceful: heap snapshot, logged shutdown,
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
// drift. Those three keep "RSS" in their names although the limit is now on the
// platform's charge: users set the variable, and the Rust client and
// check-protocol name the constants, so renaming them for wording alone would
// break that contract for no change in meaning.
//
// The default is sized from what a daemon serving a hundred sessions, each
// drawing from its own checkout, is charged: ~430 MB, about 40% of it, so a
// leak trips the backstop while it is still a leak. The render cache's share
// of it holds those hundred (render.ts). Below that the cache cannot hold the
// directories being rendered from, every render misses, and a miss's config
// load is longer than the client waits, so every render fails rather than some
// (the load gate, scripts/load-gate.ts, serves that hundred).
export const RSS_LIMIT_ENV = "CC_CANDYBAR_RSS_LIMIT_MB";
export const DEFAULT_RSS_LIMIT_MB = 1024;
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
export function memoryLimitMb(env: NodeJS.ProcessEnv): number {
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
  return memoryLimitMb(env) * HEAP_CAP_OVER_RSS;
}

const BYTES_PER_MB = 1024 * 1024;

// [LAW:one-source-of-truth] Bytes in the unit the budget is set in, as every
// sentence about the daemon's memory says them.
export const mb = (bytes: number): number => Math.round(bytes / BYTES_PER_MB);

// The budget in bytes, the unit every MemoryCharge is read in.
export function memoryLimitBytes(env: NodeJS.ProcessEnv): number {
  return memoryLimitMb(env) * BYTES_PER_MB;
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

export type BreachArtifact = keyof typeof BREACH_ARTIFACTS;

// [LAW:types-are-the-program] One breach's post-mortem: its `<stamp>-<pid>`
// identity and each artifact it left, by kind. Keyed rather than listed
// because the two are written in separate attempts and either may be missing,
// so a reader asks for the memory report by name instead of searching paths.
// [LAW:one-source-of-truth] THE order of post-mortem identities, by code
// unit as the ISO stamp is written (a collation may weigh its `-` and `:`
// otherwise): the listing sorts by it and the doctor's "unread" filters by it,
// so the newest it files read answers for every one it listed.
export function laterIdentity(a: string, b: string): boolean {
  return a > b;
}

export interface PostMortem {
  readonly identity: string;
  readonly artifacts: Readonly<Partial<Record<BreachArtifact, string>>>;
}

// [LAW:types-are-the-program] The backstop's latest reading, or none yet:
// `unmeasured` until the first probe answers — the instant before a daemon's
// first check, and for good in the browser page, which never arms its limits.
// Never a construction-time number passed off as a reading.
export type MemoryReading =
  | { readonly kind: "unmeasured" }
  | {
      readonly kind: "measured";
      readonly charge: ReadCharge;
      readonly rss: number;
      readonly heapTotal: number;
    };

// [LAW:types-are-the-program] The charge as a reading holds it: the
// platform's own, or RSS standing in less `gap` — how far RSS ran over the
// platform's charge at the last reading it charged, carried through every
// stand-in since, 0 before any (and on Linux, whose charge IS RSS). `bytes` is
// what the limit judges either way.
export type ReadCharge =
  | Extract<MemoryCharge, { kind: "charged" }>
  | {
      readonly kind: "stand-in";
      readonly bytes: number;
      readonly gap: number;
      readonly unread: string;
    };

// The daemon as the doctor judges it (brandon-doctor-v62x.5mq): which process
// it is, how much of its budget it holds, and the post-mortems its directory
// keeps — or why they could not be listed.
export interface ServingDaemon {
  readonly pid: number;
  readonly memory: MemoryReading;
  readonly limit: number;
  readonly postMortems:
    | { readonly kind: "ok"; readonly value: readonly PostMortem[] }
    | { readonly kind: "failed"; readonly reason: string };
}

// [LAW:single-enforcer] THE charge a reading holds, from what the probe
// answered and the reading before it. macOS RSS runs ~150 MB over
// phys_footprint, so judging raw RSS on one unread footprint killed two
// daemons whose footprint never passed 435 MB of a 512 MB budget
// (brandon-unfiled-3248.ptv0); the gap held at 148–153 MB minute to minute on
// the live daemon, so RSS less the last one stands in for the footprint as
// closely as it moves, and a runaway is judged at once. A host whose footprint
// never read has no gap, and is judged on RSS.
export function readCharge(
  probed: MemoryCharge,
  previous: MemoryReading,
): ReadCharge {
  if (probed.kind === "charged") return probed;
  const gap =
    previous.kind === "unmeasured"
      ? 0
      : previous.charge.kind === "charged"
        ? previous.rss - previous.charge.bytes
        : previous.charge.gap;
  return { ...probed, bytes: probed.bytes - gap, gap };
}

// [LAW:single-enforcer] THE judgment of "near the limit": the restart
// forecast in daemon-stats and the doctor's daemon row both ask it, and the
// render cache's share is sized under it.
export const NEAR_LIMIT = 0.75;
export function approachingLimit(bytes: number, limit: number): boolean {
  return bytes > limit * NEAR_LIMIT;
}

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

// What process.memoryUsage() reports, beside every charge: RSS (the charge
// itself on Linux, the stand-in on macOS) and heapTotal, the part V8 admits to
// — the gap between the charge and the heap is the whole reason this module
// writes an attribution artifact rather than only a heap snapshot.
export interface MemorySizes {
  readonly rss: number;
  readonly heapTotal: number;
}

export interface LimitsDeps {
  now: () => number;
  // [LAW:locality-or-seam] The snapshot directory, the log sink, and the
  // writer's identity are injected, not reached for ambiently. Without these,
  // unit tests of check compute filenames against the real daemonDir() and
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
  // What the platform charges this process (memory-report.ts chargeProbe).
  memoryCharge: ChargeProbe;
  // The platform's own attribution of this process's resident memory, as text.
  // Total by contract (src/daemon/memory-report.ts): it reports which probe
  // could not answer rather than throwing, because the caller is already dying.
  captureMemoryReport: () => string;
  writeMemoryReport: (filePath: string, text: string) => void;
  writeHeapSnapshot: (filePath: string) => string;
  // What the log holds, written before the loop blocks (log.ts).
  writeLogNow: () => void;
  // Every artifact a breach leaves behind, for rotation — both kinds.
  listArtifacts: () => string[];
  removeFile: (filePath: string) => void;
  shutdown: (code: number) => void;
  startedAtMs: number;
  limitBytes?: number;
  snapshotsKeep?: number;
}

export interface LimitsHandle {
  // Takes a reading and breaches on it; resolves true once the daemon is
  // shutting down of memory.
  check(): Promise<boolean>;
  describeNextRestart(): string | null;
  // [LAW:one-source-of-truth] The one producer of `ServingDaemon`, from one
  // memory reading: daemon-stats carries it, a doctor click calls it.
  serving(): ServingDaemon;
  arm(intervalMs?: number): void;
  disarm(): void;
}

export function makeLimits(deps: LimitsDeps): LimitsHandle {
  const limit = deps.limitBytes ?? DEFAULT_RSS_LIMIT_MB * BYTES_PER_MB;
  const keep = deps.snapshotsKeep ?? HEAP_SNAPSHOT_KEEP;
  let triggered = false;
  // [LAW:one-source-of-truth] The one reading: the breach verdict, the restart
  // forecast and the doctor's daemon row all read it, never one of their own.
  let latest: MemoryReading = { kind: "unmeasured" };
  // [LAW:no-ambient-temporal-coupling] The reading in flight, shared: a
  // second caller while one is out waits on the same reading rather than
  // taking its own, so a breach is judged — and recorded — once.
  let inFlight: Promise<boolean> | null = null;
  // [LAW:no-ambient-temporal-coupling] A reading landing after the disarm
  // judges nothing: no report, no snapshot, no exit from a daemon closed.
  let disarmed = false;
  let timer: NodeJS.Timeout | undefined;

  function check(): Promise<boolean> {
    inFlight ??= measure().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function measure(): Promise<boolean> {
    if (triggered) return true;
    const { rss, heapTotal } = deps.memoryBytes();
    const charge = readCharge(await deps.memoryCharge(rss), latest);
    const reading = { kind: "measured", charge, rss, heapTotal } as const;
    latest = reading;
    // [LAW:nothing-unseen] One line per reading, whatever it says: the history
    // a breach is read against, which no cache count can reconstruct.
    deps.log("info", `memory ${readingFields(reading, limit)}`);
    if (disarmed || charge.bytes <= limit) return false;
    triggered = true;
    deps.log(
      "warn",
      `${chargeWords(charge)} > limit ${mb(limit)} MB (rss ${mb(rss)} MB, v8 heap ${mb(heapTotal)} MB); recording memory then shutting down`,
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
      // [LAW:no-ambient-temporal-coupling] The snapshot holds the loop for
      // seconds and can double the heap, which can draw the OS's kill with no
      // exit event: what the log holds about this breach is on disk first.
      deps.writeLogNow();
      const file = artifactFile(deps.snapshotDir, "heapSnapshot", identity);
      deps.log(
        "info",
        `heap snapshot written: ${deps.writeHeapSnapshot(file)}`,
      );
    });
    attempt(deps.log, "artifact rotation", () => {
      // Each eviction its own attempt: a file that will not go is logged,
      // and every other evicts anyway.
      for (const { artifacts } of postMortemsOf(deps.listArtifacts()).slice(
        keep,
      )) {
        for (const file of Object.values(artifacts)) {
          attempt(deps.log, `evicting ${file}`, () => deps.removeFile(file));
        }
      }
    });
    deps.shutdown(0);
    return true;
  }

  function describeNextRestart(): string | null {
    // The heap share is the actionable half of the sentence: growth inside V8
    // is a cache to fix, growth outside it is not, and the reader cannot tell
    // which from the charge alone.
    return latest.kind === "measured" &&
      approachingLimit(latest.charge.bytes, limit)
      ? `${chargeWords(latest.charge)} approaching limit ${mb(limit)} MB (v8 heap ${mb(latest.heapTotal)} MB)`
      : null;
  }

  function serving(): ServingDaemon {
    let postMortems: ServingDaemon["postMortems"];
    try {
      postMortems = { kind: "ok", value: postMortemsOf(deps.listArtifacts()) };
    } catch (e) {
      postMortems = { kind: "failed", reason: (e as Error).message };
    }
    return { pid: deps.pid, memory: latest, limit, postMortems };
  }

  // [LAW:no-ambient-temporal-coupling] A reading at once, then each next one
  // scheduled only once the last has answered: a probe slower than the
  // interval delays the next instead of overlapping it.
  function arm(intervalMs: number = DEFAULT_CHECK_INTERVAL): void {
    const tick = async (): Promise<void> => {
      try {
        if (await check()) return;
      } catch (e) {
        deps.log("warn", `memory check failed: ${(e as Error).message}`);
      }
      if (disarmed) return;
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref();
    };
    void tick();
  }

  function disarm(): void {
    disarmed = true;
    clearTimeout(timer);
  }

  return { check, describeNextRestart, serving, arm, disarm };
}

// [LAW:one-source-of-truth] The one spelling of a charge in a sentence: the
// breach line, the restart forecast and the doctor's row all say it this way.
export function chargeWords(charge: ReadCharge): string {
  return charge.kind === "charged"
    ? `${charge.measure} ${mb(charge.bytes)} MB`
    : `rss ${mb(charge.bytes + charge.gap)} MB${charge.gap === 0 ? "" : ` less its last ${mb(charge.gap)} MB gap`} (standing in: ${charge.unread})`;
}

// [LAW:one-source-of-truth] The one token naming what a charge measured: the
// per-check log line and the doctor's event both say it this way.
export function measureOf(charge: MemoryCharge): string {
  return charge.kind === "charged" ? charge.measure : "rss-stand-in";
}

// The per-check log line's fields, logfmt.
function readingFields(
  { charge, rss, heapTotal }: Extract<MemoryReading, { kind: "measured" }>,
  limit: number,
): string {
  const unread =
    charge.kind === "stand-in"
      ? ` unread=${JSON.stringify(charge.unread)} gap=${mb(charge.gap)}MB`
      : "";
  return `measure=${measureOf(charge)} charge=${mb(charge.bytes)}MB rss=${mb(rss)}MB heap=${mb(heapTotal)}MB limit=${mb(limit)}MB${unread}`;
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

// [LAW:types-are-the-program] A post-mortem's unit is the BREACH, not the
// file. A breach leaves a heap snapshot AND a memory report sharing one
// `<stamp>-<pid>` identity, so rotation counting files would keep one and a
// half post-mortems and evict half of another — leaving a heap snapshot whose
// attribution is gone. Newest first: the leading ISO timestamp orders the
// identities lexically, the trailing -<pid> only tiebreaks same-instant
// writes. A file no breach wrote is not ours, so it is no post-mortem.
// [LAW:one-source-of-truth] The one grouping: rotation evicts its tail, the
// doctor reads it whole.
export function postMortemsOf(files: readonly string[]): PostMortem[] {
  const byIdentity = new Map<string, Partial<Record<BreachArtifact, string>>>();
  for (const file of files) {
    const base = path.basename(file);
    const kind = breachArtifactOf(base);
    if (kind === null) continue;
    const { prefix, suffix } = BREACH_ARTIFACTS[kind];
    const identity = base.slice(prefix.length, base.length - suffix.length);
    byIdentity.set(identity, { ...byIdentity.get(identity), [kind]: file });
  }
  // Each breach's artifacts in the table's order, whatever order the
  // directory listed them in: the memory report, the one a person reads
  // first, leads.
  const kinds = Object.keys(BREACH_ARTIFACTS) as BreachArtifact[];
  return [...byIdentity]
    .sort(([a], [b]) => (laterIdentity(a, b) ? -1 : 1))
    .map(([identity, found]) => ({
      identity,
      artifacts: Object.fromEntries(
        kinds.flatMap((k) => (found[k] === undefined ? [] : [[k, found[k]]])),
      ),
    }));
}

// Default real-fs deps for the daemon. Test code constructs its own.
export function realLimitsDeps(
  startedAtMs: number,
  shutdown: (code: number) => void,
  owner: { readonly launcher: Launcher; readonly log: DaemonLogger },
  overrides: Partial<LimitsDeps> = {},
): LimitsDeps {
  // [LAW:one-source-of-truth] One captured dir backs both the new-snapshot path
  // and the listing used for rotation, so they can never read different dirs.
  const dir = daemonDir();
  return {
    now: () => Date.now(),
    pid: process.pid,
    snapshotDir: dir,
    log: owner.log,
    memoryBytes: () => {
      // One call, both numbers — see the dep's comment.
      const mem = process.memoryUsage();
      return { rss: mem.rss, heapTotal: mem.heapTotal };
    },
    memoryCharge: chargeProbe(owner.launcher, process.platform, process.pid),
    captureMemoryReport: () =>
      memoryReport(
        platformProbes(owner.launcher, process.platform, process.pid),
      ),
    // 0600 like the heap snapshot v8 writes beside it: the pair shares an
    // identity, so it shares a permission — a post-mortem pair where one half is
    // world-readable and the other is not invites exactly the "is this
    // sensitive?" question at the worst moment to be asking it.
    writeMemoryReport: (file, text) =>
      fs.writeFileSync(file, text, { mode: 0o600 }),
    writeHeapSnapshot: (file) => v8.writeHeapSnapshot(file),
    writeLogNow: writeWaitingNow,
    // [LAW:no-silent-failure] A directory not yet made holds no breaches;
    // one that cannot be read is said so — never read as "none".
    listArtifacts: () => {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      return names
        .filter((f) => breachArtifactOf(f) !== null)
        .map((f) => path.join(dir, f));
    },
    removeFile: (file) => fs.unlinkSync(file),
    shutdown,
    startedAtMs,
    ...overrides,
  };
}
