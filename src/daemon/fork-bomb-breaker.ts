import fs from "node:fs";
import path from "node:path";

import { daemonRegistryDir, ensureOwnedPrivateDir } from "./paths";
import {
  readStartTime,
  sameLiveProcess,
  type ProcessIdentity,
} from "./process-fingerprint";
import { pidAlive } from "./parent-watchdog";

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
export function daemonCeiling(): number {
  const raw = Number(process.env["CC_CANDYBAR_DAEMON_CEILING"] ?? "");
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
// [LAW:no-silent-failure] "Fails safe" is achieved by construction here, not by
// a guard clause: an unreadable/uncountable population reads as count=0 (see
// countLiveEntries), which always falls in the `allow` branch — the failure
// direction is never "refuse to boot", it is "undercount and allow".
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
// swept. `null` is every unreadable/corrupt/absent-pid outcome — collapsed
// early here (unlike readLease's richer enumeration) because the only
// downstream use is "count it or don't"; there is no distinct action for
// "unreadable" vs "absent" the way socket-lease arbitration has one.
export interface RegistryEntry {
  path: string;
  identity: ProcessIdentity;
}

// [LAW:no-silent-failure] Never throws: a directory that doesn't exist yet (no
// isolated daemon has ever registered) or is transiently unreadable both mean
// "no known siblings", which is the fail-open direction decideBoot expects.
export function listRegistryFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Mirrors readSlot (test/helpers/daemon-pool.ts) / readLease's pid validation
// (socket-lease.ts): a corrupt or unreadable file is excluded from the count
// rather than treated as a special decision branch — see the module header for
// why undercounting, never overcounting, is the safe direction here.
export function readRegistryEntry(filePath: string): ProcessIdentity | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProcessIdentity> | null;
    const pid = parsed?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const startTime =
      typeof parsed?.startTime === "string" ? parsed.startTime : null;
    return { pid, startTime };
  } catch {
    return null;
  }
}

// [LAW:dataflow-not-control-flow] Pure fold over already-read entries + an
// injected liveness predicate — full branch coverage needs no fs, no real
// processes: an empty list, an all-dead list, an all-live list, and a mixed
// list are the entire input space. `sweepStale`, kept in the same pass rather
// than a second read, is the effect side; the count itself never depends on
// whether the sweep succeeds.
export function countLiveEntries(
  entries: readonly RegistryEntry[],
  isSameLiveProcess: (pid: number, startTime: string | null) => boolean,
  sweepStale: (filePath: string) => void,
): number {
  let count = 0;
  for (const entry of entries) {
    if (isSameLiveProcess(entry.identity.pid, entry.identity.startTime)) {
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
  isSameLiveProcess: (pid: number, startTime: string | null) => boolean;
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
export function admitDaemon(deps: BreakerDeps): BreakerResult {
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
    // fallback (bare `pidAlive`) would read OUR OWN pid as alive and
    // misclassify the ghost as a live sibling, consuming a ceiling slot and
    // risking a spurious refusal of the one daemon that pid actually names.
    // Excluding it here means it never reaches that ambiguous check at all.
    if (identity !== null && identity.pid !== deps.pid) {
      entries.push({ path: filePath, identity });
    }
  }
  const liveCount = countLiveEntries(
    entries,
    deps.isSameLiveProcess,
    deps.removeFile,
  );
  const decision = decideBoot(true, liveCount, deps.ceiling);
  if (!decision.allow) {
    return { decision, registryPath: null };
  }
  const registryPath = path.join(deps.registryDir, `pid-${deps.pid}.json`);
  deps.writeEntry(registryPath, { pid: deps.pid, startTime: deps.startTime });
  return { decision, registryPath };
}

// Best-effort self-cleanup on shutdown — mirrors removeLeaseIfOwned
// (socket-lease.ts): only remove the entry if it still names us, so a
// displaced/superseded record from a different process is never deleted.
export function releaseRegistration(
  registryPath: string,
  myPid: number,
  readEntry: (filePath: string) => ProcessIdentity | null,
  removeFile: (filePath: string) => void,
): void {
  const entry = readEntry(registryPath);
  if (entry !== null && entry.pid === myPid) {
    try {
      removeFile(registryPath);
    } catch {
      // Best-effort; a leftover entry naming a dead pid is harmless — the
      // next boot's sweep reclaims it.
    }
  }
}

// `myStartTime` is threaded in rather than recomputed here so callers (only
// server.ts today) fingerprint themselves exactly once at startup and reuse
// that same read for both the registry entry and the socket lease — two
// independent `ps` calls could theoretically observe different processes if
// this pid were somehow recycled between them.
export function realBreakerDeps(
  myStartTime: string | null,
  overrides: Partial<BreakerDeps> = {},
): BreakerDeps {
  return {
    isolated: Boolean(process.env["CC_CANDYBAR_SOCKET"]),
    registryDir: daemonRegistryDir(),
    ceiling: daemonCeiling(),
    pid: process.pid,
    startTime: myStartTime,
    isSameLiveProcess: (pid, startTime) =>
      sameLiveProcess(pid, startTime, { readStartTime, pidAlive }),
    listFiles: listRegistryFiles,
    readEntry: readRegistryEntry,
    removeFile: (filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // best-effort
      }
    },
    // [LAW:one-source-of-truth] Same write-tmp-then-rename shape as
    // socket-lease.ts's writeLease, so it gets the same cleanup: if
    // writeFileSync succeeds but renameSync fails, best-effort unlink the tmp
    // file (tolerating ENOENT — writeFileSync itself may have been what
    // failed) before rethrowing, so a write failure never leaves an orphaned
    // `.tmp` file behind (listRegistryFiles only collects `*.json`, so a
    // stray `.tmp` would never be swept).
    writeEntry: (filePath, identity) => {
      const tmp = `${filePath}.${identity.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(identity), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
      } catch (e) {
        try {
          fs.unlinkSync(tmp);
        } catch (cleanupErr) {
          if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
            // Best-effort cleanup failed for a reason other than "never
            // created" — the original error is still the one that matters,
            // so it is not swallowed; a leaked tmp file here is a secondary
            // symptom the next admission's stale-sweep does not reclaim
            // (only *.json is collected), but it is not this daemon's job to
            // retry a failing filesystem.
          }
        }
        throw e;
      }
    },
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
    ensureDirSafe: process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"]
      ? ensureOwnedPrivateDir
      : (dir: string): void => {
          ensureOwnedPrivateDir(path.dirname(dir));
          ensureOwnedPrivateDir(dir);
        },
    ...overrides,
  };
}
