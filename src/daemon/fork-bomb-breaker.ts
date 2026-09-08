import fs from "node:fs";
import path from "node:path";

import { daemonRegistryDir, ensureOwnedPrivateDir } from "./paths";
import {
  readStartTime,
  sameLiveProcess,
  type ProcessIdentity,
} from "./process-fingerprint";
import { pidAlive } from "./parent-watchdog";

// Every other single-instance guard keys off ONE socket path, so daemons on
// DIFFERENT sockets never arbitrate each other. This backstop is
// load-INDEPENDENT: the invariant needs no external cleanup path to hold.
//
// [LAW:one-source-of-truth] The registry ignores XDG_STATE_HOME, so isolation
// overrides cannot hide a daemon from the count.
//
// [FRAMING:representation] A production daemon is a different POPULATION: bind()
// already caps it at one, so a ceiling could only ever refuse it.
//
// [FRAMING:representation] count-then-write is NOT a compare-and-swap, so the
// ceiling is a soft bound that simultaneous starts can briefly overshoot.

export interface BootDecision {
  allow: boolean;
  reason: string;
}

const DEFAULT_CEILING = 16;

// [LAW:no-silent-failure] `Number`, not `parseInt`: the WHOLE string must be
// numeric, so "16o" is NaN rather than a silently truncated 16.
export function daemonCeiling(): number {
  const raw = Number(process.env["CC_CANDYBAR_DAEMON_CEILING"] ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CEILING;
}

// [LAW:no-silent-failure] Fails safe BY CONSTRUCTION: an uncountable population
// reads as count=0, so the failure direction is never "refuse to boot".
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

// `null` collapses every bad-read outcome; the only use is "count it or don't".
export interface RegistryEntry {
  path: string;
  identity: ProcessIdentity;
}

// [LAW:no-silent-failure] Never throws: an unreadable directory means "no known
// siblings", the fail-open direction decideBoot expects.
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

// A bad file is excluded from the count, never made a decision branch.
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

// [LAW:dataflow-not-control-flow] A pure fold; the count never depends on
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
  // Null when exempt or refused; a booting caller releases it at shutdown.
  registryPath: string | null;
}

// [LAW:effects-at-boundaries] The one place that touches the real registry, and
// an exempt daemon never reaches it, so a corrupt registry cannot refuse the one
// instance that must always boot.
export function admitDaemon(deps: BreakerDeps): BreakerResult {
  if (!deps.isolated) {
    return { decision: decideBoot(false, 0, deps.ceiling), registryPath: null };
  }
  // [LAW:single-enforcer] Injected: the safety boundary differs by registry.
  deps.ensureDirSafe(deps.registryDir);
  const entries: RegistryEntry[] = [];
  for (const filePath of deps.listFiles(deps.registryDir)) {
    const identity = deps.readEntry(filePath);
    // [LAW:no-silent-failure] An entry naming OUR OWN pid is a recycled ghost;
    // without `ps` the liveness fallback would read it as a live sibling.
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

// Only if it still names us, so a superseded record is never deleted.
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
      // Best-effort; the next boot's sweep reclaims a dead entry.
    }
  }
}

// Threaded in so a caller fingerprints itself once: two reads could observe
// different processes across a pid recycle.
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
    // [LAW:one-source-of-truth] Write-tmp-then-rename, unlinking the tmp on
    // failure: only `*.json` is ever swept, so a stray `.tmp` would leak.
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
            // The original error still matters more than a leaked tmp file.
          }
        }
        throw e;
      }
    },
    // [LAW:single-enforcer] Two levels for the DEFAULT registry only: its parent
    // is a shared /tmp root that could be pre-planted as a symlink, and lstat
    // sees only the final component, so a leaf-only check would let mkdirSync
    // follow it and still yield a clean-looking 0700 leaf.
    ensureDirSafe: process.env["CC_CANDYBAR_DAEMON_REGISTRY_DIR"]
      ? ensureOwnedPrivateDir
      : (dir: string): void => {
          ensureOwnedPrivateDir(path.dirname(dir));
          ensureOwnedPrivateDir(dir);
        },
    ...overrides,
  };
}
