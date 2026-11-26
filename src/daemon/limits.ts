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
  type JudgedCharge,
  type MemoryCharge,
  type OwnUsage,
  type PostMortem,
  BYTES_PER_MB,
  breachWords,
  judgedBytes,
  mb,
  nearAtOf,
  usageWords,
  laterIdentity,
  measureOf,
  type BreachArtifact,
  type Checked,
  type ReadCharge,
  type MemorySizes,
  type ProcessMemory,
  BREACH_ARTIFACTS,
} from "./foundations/memory-limit";
import { eventLine, type Field } from "../utils/logfmt";
import { parsedRendererName } from "./foundations/renderer-name";
import type { Launcher } from "../proc/launcher";
import type { RendererProcess } from "./renderer-process";
import type { Timekeeper } from "../time";
import type { Asked } from "../utils/outcome";

// [LAW:single-enforcer] One module judges each of the daemon's processes
// against its memory limit and records a breach before the process ends;
// what the end does is the process's own (the host's ends the daemon, a
// renderer's that renderer). Only the memory trigger remains — idle and age
// limits were removed because they interrupted active sessions. The memory
// limit is a true anomaly backstop; normal operation should never approach it
// now that transcript parsing is pruned.
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
// The default is the round limit whose render cache share holds the sessions
// that share is sized for (render-cache.ts). When more directories render in
// turn than a share holds, every render misses, and a miss's config load is
// longer than the client waits, so every render fails rather than some. A
// higher default only lets a leak grow further before the backstop sees it.
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
// answered and the process's gap. macOS RSS runs ~150 MB over
// phys_footprint, so judging raw RSS on one unread footprint killed two
// daemons whose footprint never passed 435 MB of a 512 MB budget
// (brandon-unfiled-3248.ptv0); the gap held at 148–153 MB minute to minute on
// the live daemon, so RSS less the last one stands in for the footprint as
// closely as it moves, and a runaway is judged at once. A process whose footprint
// never read beside an RSS of its own has no gap, and is judged on RSS.
export function readCharge(probed: MemoryCharge, gap: number): ReadCharge {
  return probed.kind === "charged" ? probed : { ...probed, gap };
}

// How far a process's RSS ran over its charge at the latest reading that
// measured both; a reading that did not carries the one before.
function gapOf(reading: Checked, before: number): number {
  const { charge, usage } = reading;
  return charge.kind === "charged" && usage.kind === "read"
    ? usage.sizes.rss - charge.bytes
    : before;
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
  clock: Pick<Timekeeper, "now" | "monotonic" | "after" | "detach">;
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
  // What the platform charges each process (memory-report.ts chargeProbe
  // says when each is read).
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
  // [LAW:one-source-of-truth] The budget as the daemon read it
  // (memoryLimitBytes), which every construction hands in.
  limitBytes: number;
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
  renderer(
    process: Pick<RendererProcess, "name" | "generation" | "pid">,
  ): ProcessMemory;
  arm(intervalMs?: number): void;
  disarm(): void;
}

// The renderer processes the daemon runs that a ping has read
// (src/daemon/renderer-process.ts): what a reading charges besides the host.
export interface RendererMemory {
  readonly renderers: () => readonly RendererProcess[];
}

// One process as a reading judges it: which it is, which spawn of it, what
// it last said of its own memory, how its heap is written and how it is ended.
// [LAW:one-type-per-behavior] The host and every renderer are read, judged
// and recorded alike. They differ only in the two acts a breach asks of
// them: the host writes its heap in its own loop once the log is on disk,
// and a renderer streams its own over its lines; the host's end ends the
// daemon, and a renderer's that renderer alone.
interface Judged {
  readonly process: BreachedProcess;
  // [LAW:types-are-the-program] Which process a reading is of, across
  // readings: a renderer's spawn, never its pid, which the OS may hand on.
  readonly key: string;
  readonly pid: number;
  readonly usage: OwnUsage;
  readonly writeHeap: (file: string) => Promise<void>;
  // Ends the process, answering what the end stops: the daemon, and the
  // backstop with it, or the process alone.
  readonly end: (why: string) => Ended;
}

type Ended = "daemon" | "process";

// A process's latest reading, and the gap it carries to the next.
interface Latest {
  readonly reading: Checked;
  readonly gap: number;
  // When the check read it.
  readonly at: number;
}

export function makeLimits(deps: LimitsDeps & RendererMemory): LimitsHandle {
  const limit = deps.limitBytes;
  const keep = deps.snapshotsKeep ?? HEAP_SNAPSHOT_KEEP;
  let triggered = false;
  // [LAW:one-source-of-truth] The latest reading of each process, by its
  // key: the verdicts and the stats read it, never one of their own. A
  // restarted renderer is a new spawn, so it is unmeasured until the next
  // reading, and gaps no stand-in of the process it replaced.
  let latest: ReadonlyMap<string, Latest> = new Map();
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
    const host: Judged = {
      process: { kind: "host" },
      key: HOST_KEY,
      pid: deps.pid,
      usage: { kind: "read", sizes: deps.memoryBytes() },
      // [LAW:nothing-unseen] A host breach writes the host's heap alone: what
      // the renderers made the host hold is in it, and each renderer is
      // judged on its own charge, so no renderer's heap shows the host's
      // growth.
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
      end: () => {
        deps.shutdown(0);
        return "daemon";
      },
    };
    const renderers = deps.renderers().map(
      (renderer): Judged => ({
        process: { kind: "renderer", name: renderer.name },
        key: rendererKey(renderer),
        pid: renderer.pid,
        usage: renderer.usage,
        writeHeap: async (file) => {
          // The renderer measured, never one started since.
          await renderer.heapSnapshot(file);
          deps.log(
            "info",
            `renderer ${renderer.name} heap snapshot written: ${file}`,
          );
        },
        end: (why) => {
          renderer.end(why);
          return "process";
        },
      }),
    );
    // [LAW:dataflow-not-control-flow] The host first, by construction: its
    // breach ends every renderer with it, so none is recorded for nothing.
    const judged = [host, ...renderers];
    const chargeOf = await deps.memoryCharge(judged);
    const read = judged.map((process) => {
      const before = latest.get(process.key)?.gap ?? 0;
      const reading: Checked = {
        charge: readCharge(chargeOf(process), before),
        usage: process.usage,
      };
      return { process, reading, gap: gapOf(reading, before) };
    });
    const at = deps.clock.monotonic();
    latest = new Map(
      read.map(({ process, reading, gap }) => [
        process.key,
        { reading, gap, at },
      ]),
    );
    // [LAW:nothing-unseen] One line per reading, whatever it says: the history
    // a breach is read against, which no cache count can reconstruct.
    deps.log("info", eventLine("memory", readingFields(read, limit)));
    // An unread charge has nothing to judge, and its line says why. Each
    // breach awaits seconds of writes, so the disarm is read before each.
    for (const { process, reading } of read) {
      if (disarmed) return false;
      const { charge } = reading;
      if (charge.kind === "unread" || judgedBytes(charge) <= limit) continue;
      const ended = await breach(process, charge, reading.usage);
      if (ended === "daemon") {
        triggered = true;
        return true;
      }
    }
    return false;
  }

  // A breached process's post-mortem, then its end: what the end stopped, or
  // nothing when the close came first.
  async function breach(
    judged: Judged,
    charge: JudgedCharge,
    usage: OwnUsage,
  ): Promise<Ended | null> {
    const who = processWords(judged.process);
    const why = breachWords(charge, limit);
    deps.log(
      "warn",
      `${who} ${why} (${usageWords(usage)}); recording its memory, then ending it`,
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
    if (closedDuring()) return null;
    await attempt(deps.log, `${who} heap snapshot`, () =>
      judged.writeHeap(
        artifactFile(deps.snapshotDir, "heapSnapshot", identity),
      ),
    );
    // A renderer's write can take seconds.
    if (closedDuring()) return null;
    await attempt(deps.log, "artifact rotation", async () => {
      // Each eviction its own attempt: a file that will not go is logged,
      // and every other evicts anyway.
      for (const { artifacts } of evicted(
        postMortemsOf(deps.listArtifacts()),
        keep,
      )) {
        for (const file of Object.values(artifacts)) {
          await attempt(deps.log, `evicting ${file}`, () =>
            deps.removeFile(file),
          );
        }
      }
    });
    return judged.end(why);
  }

  function memoryOf(key: string, pid: number): ProcessMemory {
    const checked = latest.get(key);
    return {
      pid,
      memory:
        checked === undefined
          ? { kind: "unmeasured" }
          : {
              kind: "measured",
              ...checked.reading,
              ageMs: deps.clock.monotonic() - checked.at,
            },
      limit,
      nearAt: nearAtOf(limit),
    };
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

  return {
    check,
    host: () => memoryOf(HOST_KEY, deps.pid),
    renderer: (process) => memoryOf(rendererKey(process), process.pid),
    arm,
    disarm,
  };
}

const HOST_KEY = "host";
const rendererKey = ({
  name,
  generation,
}: Pick<RendererProcess, "name" | "generation">): string =>
  `renderer ${name}[${generation}]`;

// [LAW:one-source-of-truth] A process's name: the words a sentence says it
// in, which a log field joins with "." and a breach's identity with "-".
function nameOf(process: BreachedProcess): readonly string[] {
  return process.kind === "host" ? ["host"] : ["renderer", process.name];
}

function processWords(process: BreachedProcess): string {
  return nameOf(process).join(" ");
}

// The per-reading log line's fields: the limit, then each process's.
function readingFields(
  read: ReadonlyArray<{ readonly process: Judged; readonly reading: Checked }>,
  limit: number,
): Field[] {
  return [
    ["limit", `${mb(limit)}MB`],
    ...read.flatMap(({ process, reading: { charge, usage } }): Field[] => {
      const at = nameOf(process.process).join(".");
      return [
        [`${at}.pid`, String(process.pid)],
        [`${at}.measure`, measureOf(charge)],
        ...(charge.kind === "unread"
          ? []
          : ([[`${at}.charge`, `${mb(judgedBytes(charge))}MB`]] as const)),
        ...(usage.kind === "read"
          ? ([
              [`${at}.rss`, `${mb(usage.sizes.rss)}MB`],
              [`${at}.heap`, `${mb(usage.sizes.heapTotal)}MB`],
            ] as const)
          : []),
        ...(charge.kind === "charged"
          ? []
          : ([
              [`${at}.gap`, `${mb(charge.gap)}MB`],
              [`${at}.unread`, charge.unread],
            ] as const)),
      ];
    }),
  ];
}

// [LAW:one-source-of-truth] A breach's identity, written here and read back
// by `breachedOf` beside it: the stamp leads, so identities order by when;
// the process's name follows, so the files say which process breached; the
// pid makes it unique. [LAW:types-are-the-program] Uniqueness is by
// construction, not by trusting the clock to be real and sub-ms-distinct: two
// processes hitting the wall in the same millisecond, or a frozen `now`,
// still write distinct files.
function identityOf(process: BreachedProcess, at: number, pid: number): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
  return [stamp, ...nameOf(process), String(pid)].join("-");
}

const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-/;

// [LAW:parse-dont-validate] The process an identity names, or none for a
// name no breach wrote. An earlier build named the host's breach by no words.
function breachedOf(identity: string): BreachedProcess | null {
  const stamp = STAMP.exec(identity);
  if (stamp === null) return null;
  const words = identity.slice(stamp[0].length).split("-");
  const pid = words.pop();
  if (pid === undefined || !/^\d+$/.test(pid)) return null;
  if (words.length === 0 || words.join("-") === "host") return { kind: "host" };
  const [kind, ...name] = words;
  const renderer =
    kind === "renderer" ? parsedRendererName(name.join("-")) : null;
  return renderer === null ? null : { kind: "renderer", name: renderer };
}

// [LAW:one-source-of-truth] What rotation evicts: the host's breaches past
// its newest `keep`, and every other breach past the newest `keep` of them
// together. So a renderer's breaches never evict the host's, and the
// directory holds at most twice `keep` breaches however many names breach.
function evicted(
  postMortems: readonly PostMortem[],
  keep: number,
): PostMortem[] {
  const seen = { host: 0, other: 0 };
  return postMortems.filter(({ process }) => {
    const pool = process.kind === "host" ? "host" : "other";
    return seen[pool]++ >= keep;
  });
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
// the state directory, read as rotation reads them.
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
// wrote is not ours, so it is no post-mortem; one whose affixes are a
// breach's is, though its identity names no process this build reads.
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
  return (
    [...byIdentity]
      // An identity with no stamp has no when, so it is the oldest.
      .sort(([a], [b]) =>
        STAMP.test(a) !== STAMP.test(b)
          ? STAMP.test(a)
            ? -1
            : 1
          : laterIdentity(a, b)
            ? -1
            : 1,
      )
      .map(([identity, found]) => ({
        identity,
        process: breachedOf(identity) ?? { kind: "unnamed" },
        artifacts: Object.fromEntries(
          kinds.flatMap((k) => (found[k] === undefined ? [] : [[k, found[k]]])),
        ),
      }))
  );
}

// Default real-fs deps for the daemon. Test code constructs its own.
export function realLimitsDeps(
  startedAtMs: number,
  shutdown: (code: number) => void,
  owner: {
    readonly launcher: Launcher;
    readonly log: DaemonLogger;
    readonly clock: Pick<Timekeeper, "now" | "monotonic" | "after" | "detach">;
    // The daemon's state directory, which its post-mortems are written to.
    readonly snapshotDir: string;
    // What the log holds, written before the loop blocks (log.ts).
    readonly writeLogNow: () => void;
  },
  overrides: Partial<LimitsDeps> = {},
): Omit<LimitsDeps, "limitBytes"> {
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
