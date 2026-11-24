import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { type DaemonLogger } from "../utils/logger";
import {
  chargeProbe,
  memoryReport,
  platformProbes,
  type ChargeProbe,
} from "./memory-report";
import {
  type BreachedProcess,
  type MemoryCharge,
  type PostMortem,
  BYTES_PER_MB,
  mb,
  laterIdentity,
  approachingLimit,
  chargeWords,
  measureOf,
  type BreachArtifact,
  type MemoryReading,
  type ReadCharge,
  type MemorySizes,
  type ProcessMemory,
  BREACH_ARTIFACTS,
} from "./foundations/memory-limit";
import { eventLine, type Field } from "../utils/logfmt";
import { rendererNameOf } from "./foundations/renderer-name";
import type { Launcher } from "../proc/launcher";
import type { RendererProcess } from "./renderer-process";
import type { Timekeeper } from "../time";
import type { Asked } from "../utils/outcome";

// [LAW:single-enforcer] One module owns "when does a process of the daemon
// end of its memory". Only the memory trigger remains — idle and age limits
// were removed because they interrupted active sessions. The memory limit is a
// true anomaly backstop; normal operation should never approach it now that
// transcript parsing is pruned.
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
// Each process is judged on its own charge: the host, and every renderer
// process. A renderer that breaches is ended alone and its supervisor starts
// it again, so a leak in one renderer (a worktree's, say) costs only its own
// sessions' unsaved state while every other renderer keeps drawing; a host
// that breaches ends the daemon. Summing them would let one renderer's leak
// end every session's bar.
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
// The default is sized from what serving a hundred sessions, each drawing
// from its own checkout, was charged: ~430 MB for the host and its renderer
// together, under half of it, so a leak in either trips the backstop while it
// is still a leak. A renderer's render cache share holds those hundred
// (render-cache.ts). Below that the cache cannot hold the
// directories being rendered from, every render misses, and a miss's config
// load is longer than the client waits, so every render fails rather than some.
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

// The budget in bytes, the unit every MemoryCharge is read in.
export function memoryLimitBytes(env: NodeJS.ProcessEnv): number {
  return memoryLimitMb(env) * BYTES_PER_MB;
}

const DEFAULT_CHECK_INTERVAL = 60 * 1000;
const HEAP_SNAPSHOT_KEEP = 3;

// [LAW:single-enforcer] THE charge a reading holds, from what the probe
// answered and the reading before it. macOS RSS runs ~150 MB over
// phys_footprint, so judging raw RSS on one unread footprint killed two
// daemons whose footprint never passed 435 MB of a 512 MB budget
// (brandon-unfiled-3248.ptv0); the gap held at 148–153 MB minute to minute on
// the live daemon, so RSS less the last one stands in for the footprint as
// closely as it moves, and a runaway is judged at once. A process whose footprint
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
        ? previous.sizes.rss - previous.charge.bytes
        : previous.charge.gap;
  return { ...probed, bytes: probed.bytes - gap, gap };
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

export interface LimitsDeps {
  // The machine's clock: when a post-mortem is stamped, and the pace of the
  // readings.
  clock: Pick<Timekeeper, "now" | "after" | "detach">;
  // [LAW:locality-or-seam] The snapshot directory, the log sink, and the
  // writer's identity are injected, not reached for ambiently. Without these,
  // unit tests of check compute filenames against the real state directory and
  // emit real log lines into the user's production daemon.log — the seam must
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
  // What the platform charges each process, all read at one moment
  // (memory-report.ts chargeProbe).
  memoryCharge: ChargeProbe;
  // The platform's own attribution of a process's resident memory, as text.
  // Total by contract (src/daemon/memory-report.ts): it reports which probe
  // could not answer rather than throwing, because the breach is under way.
  captureMemoryReport: (pid: number) => Promise<string>;
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
  // Takes a reading and judges each process on it; resolves true once the
  // daemon is shutting down of the host's memory.
  check(): Promise<boolean>;
  // [LAW:one-source-of-truth] The one producer of a process's
  // `ProcessMemory`, from the latest reading: the stats reply carries the
  // host's and each renderer process's.
  host(): ProcessMemory;
  memoryOf(pid: number): ProcessMemory;
  arm(intervalMs?: number): void;
  disarm(): void;
}

// The renderer processes the daemon runs that a ping has read
// (src/daemon/renderer-process.ts): what a reading charges besides the host.
export interface RendererMemory {
  readonly renderers: () => readonly RendererProcess[];
}

// One process as a reading judges it: which it is, its sizes, how its heap is
// written and how it is ended.
// [LAW:one-type-per-behavior] The host and every renderer are read, judged
// and recorded alike; only what their end does differs: the host's ends the
// daemon, a renderer's that renderer alone.
interface Judged {
  readonly process: BreachedProcess;
  readonly pid: number;
  readonly sizes: MemorySizes;
  readonly writeHeap: (file: string) => Promise<void>;
  readonly end: (why: string) => void;
}

type Measured = Extract<MemoryReading, { kind: "measured" }>;

export function makeLimits(deps: LimitsDeps & RendererMemory): LimitsHandle {
  const limit = deps.limitBytes ?? DEFAULT_RSS_LIMIT_MB * BYTES_PER_MB;
  const keep = deps.snapshotsKeep ?? HEAP_SNAPSHOT_KEEP;
  let triggered = false;
  // [LAW:one-source-of-truth] The latest reading of each process, by pid: the
  // verdicts and the stats read it, never one of their own. A restarted
  // renderer is a new pid, so it is unmeasured until the next reading, and
  // gaps no stand-in of the process it replaced.
  let latest: ReadonlyMap<number, Measured> = new Map();
  // [LAW:no-ambient-temporal-coupling] The reading in flight, shared: a
  // second caller while one is out waits on the same reading rather than
  // taking its own, so a breach is judged — and recorded — once.
  let inFlight: Promise<boolean> | null = null;
  // [LAW:no-ambient-temporal-coupling] A reading landing after the disarm
  // judges nothing: no report, no snapshot, no end of a daemon closed.
  let disarmed = false;
  let clearTimer: (() => void) | undefined;

  function check(): Promise<boolean> {
    inFlight ??= measure().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function measure(): Promise<boolean> {
    if (triggered) return true;
    const own = deps.memoryBytes();
    const host: Judged = {
      process: { kind: "host" },
      pid: deps.pid,
      sizes: own,
      writeHeap: async (file) => {
        // [LAW:no-ambient-temporal-coupling] The snapshot holds the loop for
        // seconds and can double the heap, which can draw the OS's kill with
        // no exit event: what the log holds about this breach is on disk
        // first.
        deps.writeLogNow();
        deps.log(
          "info",
          `heap snapshot written: ${deps.writeHeapSnapshot(file)}`,
        );
      },
      end: () => deps.shutdown(0),
    };
    const renderers = deps.renderers().map(
      (renderer): Judged => ({
        process: { kind: "renderer", name: renderer.name },
        pid: renderer.pid,
        sizes: renderer.usage,
        writeHeap: async (file) => {
          // The renderer measured, never one started since.
          await renderer.heapSnapshot(file);
          deps.log(
            "info",
            `renderer ${renderer.name} heap snapshot written: ${file}`,
          );
        },
        end: (why) => renderer.end(why),
      }),
    );
    const read = (await deps.memoryCharge([host, ...renderers])).map(
      ({ process, charge }) => {
        const held = readCharge(
          charge,
          latest.get(process.pid) ?? { kind: "unmeasured" },
        );
        const reading: Measured = {
          kind: "measured",
          charge: held,
          sizes: process.sizes,
          nearLimit: approachingLimit(held.bytes, limit),
        };
        return { process, reading };
      },
    );
    latest = new Map(
      read.map(({ process, reading }) => [process.pid, reading]),
    );
    // [LAW:nothing-unseen] One line per reading, whatever it says: the history
    // a breach is read against, which no cache count can reconstruct.
    deps.log("info", eventLine("memory", readingFields(read, limit)));
    if (disarmed) return false;
    // The host first, as the probe hands it back: its breach ends every
    // renderer with it.
    for (const { process, reading } of read) {
      if (reading.charge.bytes <= limit) continue;
      if (process.process.kind === "host") {
        triggered = true;
        return breach(process, reading);
      }
      await breach(process, reading);
    }
    return false;
  }

  // A breached process's post-mortem, then its end. Resolves whether it ended.
  async function breach(
    judged: Judged,
    { charge, sizes }: Measured,
  ): Promise<boolean> {
    const who = processWords(judged.process);
    const why = `passed its memory limit: ${chargeWords(charge)} > limit ${mb(limit)} MB`;
    deps.log(
      "warn",
      `${who} ${chargeWords(charge)} > limit ${mb(limit)} MB (rss ${mb(sizes.rss)} MB, v8 heap ${mb(sizes.heapTotal)} MB); recording its memory, then ending it`,
    );
    const identity = identityOf(judged.process, deps.clock.now(), judged.pid);
    // [LAW:no-ambient-temporal-coupling] The attribution goes FIRST. Writing a
    // heap snapshot allocates and can move hundreds of megabytes, so a reading
    // taken after it would describe the state the snapshot produced rather than
    // the state that tripped the limit.
    //
    // [LAW:no-silent-failure] Each artifact is attempted on its own: one
    // failing must not cost the other, and either failure is named in the log
    // where the post-mortem will look for it.
    await attempt(deps.log, `${who} memory report`, async () => {
      const file = artifactFile(deps.snapshotDir, "memoryReport", identity);
      const report = await deps.captureMemoryReport(judged.pid);
      if (disarmed) return;
      deps.writeMemoryReport(file, report);
      deps.log("info", `memory report written: ${file}`);
    });
    // [LAW:no-ambient-temporal-coupling] The close may land during any of the
    // breach's awaits, and `disarmed`'s rule holds past each of them.
    const closedDuring = (): boolean => {
      if (disarmed)
        deps.log(
          "info",
          `daemon closed during the ${who}'s breach: no snapshot, no end`,
        );
      return disarmed;
    };
    if (closedDuring()) return false;
    await attempt(deps.log, `${who} heap snapshot`, () =>
      judged.writeHeap(
        artifactFile(deps.snapshotDir, "heapSnapshot", identity),
      ),
    );
    // A renderer's write can take seconds.
    if (closedDuring()) return false;
    await attempt(deps.log, "artifact rotation", async () => {
      // Each eviction its own attempt: a file that will not go is logged,
      // and every other evicts anyway.
      for (const { artifacts } of postMortemsOf(deps.listArtifacts()).slice(
        keep,
      )) {
        for (const file of Object.values(artifacts)) {
          await attempt(deps.log, `evicting ${file}`, () =>
            deps.removeFile(file),
          );
        }
      }
    });
    judged.end(why);
    return true;
  }

  function memoryOf(pid: number): ProcessMemory {
    return { pid, memory: latest.get(pid) ?? { kind: "unmeasured" }, limit };
  }

  // [LAW:no-ambient-temporal-coupling] A reading at once, then each next one
  // scheduled only once the last has answered: a probe slower than the
  // interval delays the next instead of overlapping it.
  function arm(intervalMs: number = DEFAULT_CHECK_INTERVAL): void {
    // [LAW:no-silent-failure] A check that throws reaches the clock, which
    // shows it on every bar, and the next is armed all the same.
    const tick = async (): Promise<void> => {
      let breached = false;
      try {
        breached = await check();
      } finally {
        if (!breached && !disarmed)
          clearTimer = deps.clock.after("memory check", intervalMs, tick, {
            unref: true,
          });
      }
    };
    deps.clock.detach("memory check", tick);
  }

  function disarm(): void {
    disarmed = true;
    clearTimer?.();
  }

  return { check, host: () => memoryOf(deps.pid), memoryOf, arm, disarm };
}

// [LAW:one-source-of-truth] How a sentence names a process.
function processWords(process: BreachedProcess): string {
  return process.kind === "host" ? "host" : `renderer ${process.name}`;
}

// The per-reading log line's fields: the limit, then each process's.
function readingFields(
  read: ReadonlyArray<{ readonly process: Judged; readonly reading: Measured }>,
  limit: number,
): Field[] {
  return [
    ["limit", `${mb(limit)}MB`],
    ...read.flatMap(({ process, reading: { charge, sizes } }): Field[] => {
      const at =
        process.process.kind === "host"
          ? "host"
          : `renderer.${process.process.name}`;
      return [
        [`${at}.pid`, String(process.pid)],
        [`${at}.measure`, measureOf(charge)],
        [`${at}.charge`, `${mb(charge.bytes)}MB`],
        [`${at}.rss`, `${mb(sizes.rss)}MB`],
        [`${at}.heap`, `${mb(sizes.heapTotal)}MB`],
        ...(charge.kind === "stand-in"
          ? ([
              [`${at}.gap`, `${mb(charge.gap)}MB`],
              [`${at}.unread`, charge.unread],
            ] as const)
          : []),
      ];
    }),
  ];
}

// [LAW:one-source-of-truth] A breach's identity, written here and read back
// by `postMortemsOf`: the stamp leads, so identities order by when; a
// renderer's name follows, so the files say which process breached; the pid
// makes it unique. [LAW:types-are-the-program] Uniqueness is by construction,
// not by trusting the clock to be real and sub-ms-distinct: two processes
// hitting the wall in the same millisecond, or a frozen `now`, still write
// distinct files.
function identityOf(process: BreachedProcess, at: number, pid: number): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
  return process.kind === "host"
    ? `${stamp}-${pid}`
    : `${stamp}-renderer-${process.name}-${pid}`;
}

const IDENTITY =
  /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-(?:renderer-([a-z0-9-]+)-)?\d+$/;

// [LAW:parse-dont-validate] The process an identity names, or none for a
// name no breach wrote.
function breachedOf(identity: string): BreachedProcess | null {
  const match = IDENTITY.exec(identity);
  if (match === null) return null;
  const name = match[1];
  return name === undefined
    ? { kind: "host" }
    : { kind: "renderer", name: rendererNameOf(name) };
}

// [LAW:no-silent-failure] The death path's one shape for "do this, and if it
// fails say which thing failed and carry on to the next". Swallowing would leave
// a breach with no artifacts and no explanation; throwing would skip the
// shutdown.
async function attempt(
  log: DaemonLogger,
  what: string,
  body: () => void | Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (e) {
    log("warn", `${what} failed: ${(e as Error).message}`);
  }
}

// [LAW:no-silent-failure] Every artifact a breach left in `dir`: a directory
// not yet made holds no breaches; one that cannot be read throws, never read
// as "none".
function breachArtifacts(dir: string): string[] {
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
}

// [LAW:one-source-of-truth] The post-mortems the daemons' breaches left in
// the state directory, read as rotation reads them. Only tests call it today.
export function listPostMortems(dir: string): Asked<readonly PostMortem[]> {
  try {
    return { kind: "ok", value: postMortemsOf(breachArtifacts(dir)) };
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message };
  }
}

// [LAW:types-are-the-program] A post-mortem's unit is the BREACH, not the
// file. A breach leaves a heap snapshot AND a memory report sharing one
// identity, so rotation counting files would keep one and a half post-mortems
// and evict half of another — leaving a heap snapshot whose attribution is
// gone. Newest first: the leading ISO timestamp orders the identities
// lexically, what follows only tiebreaks same-instant writes. A file no breach
// wrote is not ours, so it is no post-mortem.
// [LAW:one-source-of-truth] The one grouping: rotation evicts its tail, and a
// listing reads it whole.
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
    .flatMap(([identity, found]) => {
      const process = breachedOf(identity);
      return process === null
        ? []
        : [
            {
              identity,
              process,
              artifacts: Object.fromEntries(
                kinds.flatMap((k) =>
                  found[k] === undefined ? [] : [[k, found[k]]],
                ),
              ),
            },
          ];
    });
}

// Default real-fs deps for the daemon. Test code constructs its own.
export function realLimitsDeps(
  startedAtMs: number,
  shutdown: (code: number) => void,
  owner: {
    readonly launcher: Launcher;
    readonly log: DaemonLogger;
    readonly clock: Pick<Timekeeper, "now" | "after" | "detach">;
    // The daemon's state directory, which its post-mortems are written to.
    readonly snapshotDir: string;
    // What the log holds, written before the loop blocks (log.ts).
    readonly writeLogNow: () => void;
  },
  overrides: Partial<LimitsDeps> = {},
): LimitsDeps {
  // [LAW:one-source-of-truth] One dir backs both the new-snapshot path and the
  // listing used for rotation, so they can never read different dirs.
  const dir = owner.snapshotDir;
  return {
    clock: owner.clock,
    pid: process.pid,
    snapshotDir: dir,
    log: owner.log,
    memoryBytes: () => {
      // One call, both numbers — see the dep's comment.
      const mem = process.memoryUsage();
      return { rss: mem.rss, heapTotal: mem.heapTotal };
    },
    memoryCharge: chargeProbe(owner.launcher, process.platform),
    captureMemoryReport: (pid) =>
      memoryReport(platformProbes(owner.launcher, process.platform, pid)),
    // 0600 like the heap snapshot v8 writes beside it: the pair shares an
    // identity, so it shares a permission — a post-mortem pair where one half is
    // world-readable and the other is not invites exactly the "is this
    // sensitive?" question at the worst moment to be asking it.
    writeMemoryReport: (file, text) =>
      fs.writeFileSync(file, text, { mode: 0o600 }),
    writeHeapSnapshot: (file) => v8.writeHeapSnapshot(file),
    writeLogNow: owner.writeLogNow,
    listArtifacts: () => breachArtifacts(dir),
    removeFile: (file) => fs.unlinkSync(file),
    shutdown,
    startedAtMs,
    ...overrides,
  };
}
