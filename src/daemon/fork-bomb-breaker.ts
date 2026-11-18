import fs from "node:fs";
import path from "node:path";

import { ensureOwnedPrivateDir } from "./paths";
import { publishByRename } from "../utils/atomic-write";
import {
  sameLiveProcess,
  systemProbe,
  type ProcessIdentity,
} from "./process-fingerprint";
import type { World } from "../host";

// ─── Daemon-side fork-bomb circuit breaker ───────────────────────────────────
//
// [FRAMING:representation] The 192-daemon storm (epic brandon-daemon-lifecycle-
// gad) happened because every existing single-instance guard (atomic bind(),
// the socket lease, the ownership self-check, the spawn cooldown) keys off ONE
// socket path — daemons on DIFFERENT sockets (test isolation's per-file
// CC_CANDYBAR_SOCKET) never arbitrate each other and pile up unboundedly. .1
// (test/helpers/daemon-pool.ts) bounds that from the SPAWNER side, but the
// spawner's own cleanup (afterAll, globalTeardown) fails under the exact
// fork-exhaustion condition it exists to prevent. This module is the
// load-INDEPENDENT backstop: a daemon refuses to boot past a sibling ceiling
// using only its own startup-time read of a shared registry — no external
// cleanup path required for the invariant to hold.
//
// [LAW:one-source-of-truth] The registry lives at daemonRegistryDir() (paths.ts)
// — a fixed, UID-anchored /tmp path that, like socketPath(), deliberately
// ignores XDG_STATE_HOME, so isolation overrides can't hide a daemon from the
// count. Every daemon that does NOT explicitly override
// CC_CANDYBAR_DAEMON_REGISTRY_DIR lands in the same directory.
//
// [FRAMING:representation] The production daemon is a different POPULATION
// than an isolated (test/dev) instance, not a smaller version of the same one:
// it is already bounded to exactly one by bind()'s kernel-enforced exclusion on
// the canonical socket path, so no ceiling can ever be its failure mode — only
// isolation (an explicit CC_CANDYBAR_SOCKET override) creates the "many
// coexisting instances" population this breaker exists to bound. Classifying by
// "is CC_CANDYBAR_SOCKET set" keeps the two populations from ever counting
// against each other: the production daemon is exempt (and so always boots,
// however many isolated instances are registered), and isolated instances
// compete only with each other over the shared ceiling.
//
// [FRAMING:representation] admitDaemon's count-then-write (read the registry,
// decide, write our own entry) is NOT a compare-and-swap — the same accepted
// tradeoff as test/helpers/daemon-pool.ts's tryClaim. Two daemons starting in
// the same instant can both observe the same below-ceiling count and both
// admit, so the ceiling is a soft bound (liveCount can briefly overshoot by
// the number of true simultaneous spawns), not a strict mutex. A real fix
// needs a cross-process lock (flock, an O_EXCL pre-registration file); skipped
// as disproportionate here — this is a load-independent BACKSTOP against a
// 192-daemon storm, not a precision gate, and the ticket's own acceptance
// criterion is "a small, asserted ceiling", never exact atomicity. The
// failure mode of the race is a brief, bounded overshoot that the next boot's
// stale-sweep does not even need to correct (the overshooting daemons are
// live, not stale) — categorically smaller than the storm this breaker
// exists to prevent.

export interface BootDecision {
  allow: boolean;
  reason: string;
}

const DEFAULT_CEILING = 16;

// [LAW:no-silent-failure] `Number(...)`, not `parseInt(...)` — parseInt
// truncates trailing garbage ("16o" reads as 16, silently accepting a typo
// that likely meant 160) instead of surfacing it. `Number` requires the
// WHOLE string to be numeric, so a typo becomes NaN and falls through to the
// default like any other garbage value.
export function daemonCeiling(env: Readonly<NodeJS.ProcessEnv>): number {
  const raw = Number(env["CC_CANDYBAR_DAEMON_CEILING"] ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CEILING;
}

// [LAW:dataflow-not-control-flow] The whole decision is this one pure fold —
// full input space:
//   isolated=false                    → allow, unconditionally (production is
//                                        already singular via bind(); a
//                                        ceiling here could only ever refuse
//                                        the user's one real daemon, which the
//                                        epic requires never happens)
//   isolated=true,  count <  ceiling  → allow (below the backstop)
//   isolated=true,  count >= ceiling  → deny (the fork-bomb condition)
// [LAW:no-silent-failure] The count is never short of what the registry
// holds: a registry that cannot be listed throws, and the boot refuses on the
// throw, naming it; an entry whose start time cannot be read is judged by its
// pid alone (readRegistryEntry), which can only count it high. A backstop that
// admits what it could not count is no backstop, and a short count comes
// exactly when the machine is short (a fork storm's spent descriptors).
export function decideBoot(
  isolated: boolean,
  liveSiblingCount: number,
  ceiling: number,
): BootDecision {
  if (!isolated) {
    return {
      allow: true,
      reason:
        "canonical production socket — exempt (bind() already caps it to one)",
    };
  }
  if (liveSiblingCount >= ceiling) {
    return {
      allow: false,
      reason: `${liveSiblingCount} live isolated daemons registered >= ceiling ${ceiling}`,
    };
  }
  return {
    allow: true,
    reason: `${liveSiblingCount} live isolated daemons registered < ceiling ${ceiling}`,
  };
}

// A registry entry read, alongside its source path so a stale one can be
// swept.
export interface RegistryEntry {
  path: string;
  identity: ProcessIdentity;
}

// [LAW:no-silent-failure] Throws when the directory cannot be listed: the
// admission makes it just before it lists it, so a listing that fails never
// means an empty registry.
export function listRegistryFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ENTRY_SUFFIX))
    .map((f) => path.join(dir, f));
}

// [LAW:one-source-of-truth] An entry's pid is its name, the only name
// admission writes; its content adds the start time that tells the pid's
// process from a later one given the same pid.
const ENTRY_PREFIX = "pid-";
const ENTRY_SUFFIX = ".json";
const entryPath = (dir: string, pid: number): string =>
  path.join(dir, `${ENTRY_PREFIX}${pid}${ENTRY_SUFFIX}`);
// The pid an entry's name spells, in the one form `entryPath` writes, or null.
function pidNamed(name: string): number | null {
  if (!name.startsWith(ENTRY_PREFIX) || !name.endsWith(ENTRY_SUFFIX))
    return null;
  const digits = name.slice(ENTRY_PREFIX.length, -ENTRY_SUFFIX.length);
  return /^[1-9]\d*$/.test(digits) ? Number(digits) : null;
}

// [LAW:no-silent-failure] Null is no entry: a name admission never writes, or
// a file removed since the listing (its daemon released it). A start time
// that cannot be read, from content unreadable or not an identity, leaves the
// entry judged by its pid alone (kill(pid, 0)). That can count a recycled pid
// as live and never a live one as dead, so the count can come out high, which
// refuses, and never short. The content keeps its pid because a daemon of an
// earlier release reads the pid from there, and counts an entry without one
// as no entry.
export function readRegistryEntry(filePath: string): ProcessIdentity | null {
  const pid = pidNamed(path.basename(filePath));
  if (pid === null) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { pid, startTime: null };
  }
  return { pid, startTime: startTimeOf(raw) };
}

function startTimeOf(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { startTime?: unknown } | null;
    // An empty token names no process (readStartTime never mints one).
    return typeof parsed?.startTime === "string" && parsed.startTime !== ""
      ? parsed.startTime
      : null;
  } catch {
    return null;
  }
}

// [LAW:dataflow-not-control-flow] A fold over already-read entries + an
// injected liveness predicate — full branch coverage needs no fs, no real
// processes: an empty list, an all-dead list, an all-live list, and a mixed
// list are the entire input space. `sweepStale`, kept in the same pass rather
// than a second read, is the effect side; the count itself never depends on
// whether the sweep succeeds.
export async function countLiveEntries(
  entries: readonly RegistryEntry[],
  isSameLiveProcess: (
    pid: number,
    startTime: string | null,
  ) => Promise<boolean>,
  sweepStale: (filePath: string) => void,
): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    if (await isSameLiveProcess(entry.identity.pid, entry.identity.startTime)) {
      count++;
    } else {
      sweepStale(entry.path);
    }
  }
  return count;
}

export interface BreakerDeps {
  isolated: boolean;
  registryDir: string;
  ceiling: number;
  pid: number;
  startTime: string | null;
  isSameLiveProcess: (
    pid: number,
    startTime: string | null,
  ) => Promise<boolean>;
  listFiles: (dir: string) => string[];
  readEntry: (filePath: string) => ProcessIdentity | null;
  removeFile: (filePath: string) => void;
  writeEntry: (filePath: string, identity: ProcessIdentity) => void;
  ensureDirSafe: (dir: string) => void;
}

export interface BreakerResult {
  decision: BootDecision;
  // The path this daemon registered at, or null when exempt/refused. Callers
  // that boot successfully thread this into their shutdown cleanup so the slot
  // is released promptly instead of waiting for the next boot's stale-sweep.
  registryPath: string | null;
}

// [LAW:effects-at-boundaries] The one place that turns the pure fold into a
// boot/refuse decision by reading + writing the real registry. Exempt
// (production) daemons never touch the registry at all — not even to read
// it — so a corrupt or unreadable registry can never affect the one instance
// the epic requires to always boot.
export async function admitDaemon(deps: BreakerDeps): Promise<BreakerResult> {
  if (!deps.isolated) {
    return { decision: decideBoot(false, 0, deps.ceiling), registryPath: null };
  }
  // [LAW:single-enforcer] `ensureDirSafe` — not a bare `ensureOwnedPrivateDir`
  // call — because the safety boundary differs by registry: the default,
  // UID-anchored registry sits under the same shared /tmp root the socket
  // does and needs the two-level check `realBreakerDeps` builds for it (see
  // its comment); an overridden registry (tests) is the caller's own
  // directory and needs only the one-level leaf check. `admitDaemon` stays
  // agnostic to which — it just asks the injected dependency to prove the
  // directory is safe to use.
  deps.ensureDirSafe(deps.registryDir);
  const entries: RegistryEntry[] = [];
  for (const filePath of deps.listFiles(deps.registryDir)) {
    const identity = deps.readEntry(filePath);
    // [LAW:no-silent-failure] Exclude any entry named with OUR OWN pid,
    // unconditionally — no other currently-live process can ever share it
    // (the kernel guarantees pid uniqueness among live processes), so such an
    // entry is always either a stale pid-recycled ghost from a past
    // incarnation, or moot (we haven't written our own entry yet). This
    // matters specifically when `ps` is unavailable: `isSameLiveProcess`'s
    // fallback (the bare liveness answer) would read OUR OWN pid as alive and
    // misclassify the ghost as a live sibling, consuming a ceiling slot and
    // risking a spurious refusal of the one daemon that pid actually names.
    // Excluding it here means it never reaches that ambiguous check at all.
    if (identity !== null && identity.pid !== deps.pid) {
      entries.push({ path: filePath, identity });
    }
  }
  const liveCount = await countLiveEntries(
    entries,
    deps.isSameLiveProcess,
    deps.removeFile,
  );
  const decision = decideBoot(true, liveCount, deps.ceiling);
  if (!decision.allow) {
    return { decision, registryPath: null };
  }
  const registryPath = entryPath(deps.registryDir, deps.pid);
  deps.writeEntry(registryPath, { pid: deps.pid, startTime: deps.startTime });
  return { decision, registryPath };
}

// [LAW:single-enforcer] The one removal of a registry entry: our own at
// shutdown (named by our own pid, which no other live process holds, so it is
// ours while we run), and a dead one the sweep finds. Gone already is removed.
// [LAW:no-silent-failure] Any other failure throws: the shutdown step logs it,
// and the sweep warns and goes on, since a dead entry left behind is uncounted.
export function removeEntry(
  registryPath: string,
  removeFile: (filePath: string) => void,
): void {
  try {
    removeFile(registryPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

// `myStartTime` is threaded in rather than recomputed here so callers (only
// server.ts today) fingerprint themselves exactly once at startup and reuse
// that same read for both the registry entry and the socket lease — two
// independent `ps` calls could theoretically observe different processes if
// this pid were somehow recycled between them.
export function realBreakerDeps(
  { host, launcher }: World,
  myStartTime: string | null,
  registryDir: string,
  warn: (message: string) => void,
  overrides: Partial<BreakerDeps> = {},
): BreakerDeps {
  return {
    isolated: Boolean(host.env["CC_CANDYBAR_SOCKET"]),
    registryDir,
    ceiling: daemonCeiling(host.env),
    pid: process.pid,
    startTime: myStartTime,
    isSameLiveProcess: (pid, startTime) =>
      sameLiveProcess(pid, startTime, systemProbe(launcher)),
    listFiles: listRegistryFiles,
    readEntry: readRegistryEntry,
    removeFile: (filePath) => {
      try {
        removeEntry(filePath, fs.unlinkSync);
      } catch (e) {
        warn(
          `fork-bomb breaker: a dead entry could not be removed: ${(e as Error).message}`,
        );
      }
    },
    // [LAW:single-enforcer] Published by rename (src/utils/atomic-write.ts): a
    // reader never sees a torn entry, and a failed write removes its staged
    // file or says in its error that it could not.
    writeEntry: (filePath, identity) =>
      publishByRename(filePath, JSON.stringify(identity), 0o600),
    // [LAW:single-enforcer] Two levels, mirroring ensureSocketParentSafe's own
    // shape, but ONLY for the default (unoverridden) registry path: its
    // parent is the shared UID-anchored /tmp root an attacker could pre-plant
    // as a symlink before any daemon has ever run, and `lstatSync` only
    // inspects a path's FINAL component — verifying the leaf alone lets a
    // symlinked parent be silently followed by `mkdirSync({recursive:true})`,
    // after which the freshly-created leaf looks perfectly clean (owned by
    // us, 0700) despite living inside attacker-controlled storage. An
    // OVERRIDDEN registry dir (CC_CANDYBAR_DAEMON_REGISTRY_DIR, tests only)
    // has no such shared root by construction — its parent is whatever
    // directory the caller happened to put it under (a system tmpdir on some
    // platforms), which is not a boundary this breaker owns or should assert
    // on; there the one-level leaf check alone is the correct, portable
    // parity with how ensureSocketParentSafe treats an overridden
    // CC_CANDYBAR_SOCKET (exactly one level, whatever that parent is).
    ensureDirSafe: host.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"]
      ? ensureOwnedPrivateDir
      : (dir: string): void => {
          ensureOwnedPrivateDir(path.dirname(dir));
          ensureOwnedPrivateDir(dir);
        },
    ...overrides,
  };
}
