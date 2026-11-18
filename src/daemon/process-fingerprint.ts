import fs from "node:fs";

import type { Launcher } from "../proc/launcher";

// ─── Process start-time fingerprint ──────────────────────────────────────────
//
// [FRAMING:representation] A bare pid is an under-constrained identity: the
// kernel recycles pids, so "a process with pid 989 exists" does NOT prove "989
// is the same process that wrote this lease". A crashed daemon whose pid the OS
// later hands to an unrelated long-lived process reads `alive` on every
// subsequent start, so no daemon ever comes up (brandon-daemon-lifecycle-2b3.4
// RESIDUAL 1 — the inverse of the socket-theft storm). The kernel ALSO stamps
// each process with a start-time it never rewinds within that pid's life;
// (pid, start-time) is the pair that actually IS a process identity, so a
// recycled pid is provably a DIFFERENT process (different start-time).
//
// [LAW:one-source-of-truth] The authority is the kernel's process identity, not
// a bare pid. Where the host has /proc (linux) the kernel's own record is read
// there: the start-time field of the pid's stat beside the boot id, so no
// subprocess runs and a read cannot time out. Elsewhere (darwin) `ps -o
// lstart=` exposes it. A host always reads one source, so every token it
// compares was minted the same way. The reported token is treated as OPAQUE — compared by string
// equality, never parsed — so there is no date-format representation to drift
// [FRAMING:representation]: a producer/consumer parse mismatch is unrepresentable
// when neither side parses. That opaque-equality invariant holds ONLY if the
// GENERATOR is deterministic. `ps -o lstart=` is strftime-formatted (locale) via
// `localtime()` (timezone), so the SAME process renders different tokens across a
// locale change OR a timezone change (TZ env, DST, tzdata update). We pin BOTH on
// the `ps` subprocess — `LC_ALL=C` (dominates any ambient LC_TIME/LC_ALL) and
// `TZ=UTC` — so the token is a locale- and timezone-invariant UTC rendering of
// the start instant, and equality is sound.

// [LAW:one-source-of-truth] The (pid, start-time) pair IS a process identity
// (see the file header) — every owner-of-a-resource record in this codebase
// (a socket lease, a test-pool slot) names its owner with exactly this shape.
// Declared once here, the module that owns the process-identity concept, so
// a future field addition to "what identifies a process" can't drift between
// independent copies.
export interface ProcessIdentity {
  pid: number;
  startTime: string | null;
}

// A read of a pid's kernel start-time. Only TWO outcomes, because nothing
// derivable from a `ps` exit code can SOUNDLY prove a process is dead — a
// non-zero exit means "no start-time to report", which conflates a genuinely
// absent pid with an access failure (hardened `/proc`/`hidepid`, a
// permission-denied read of a live process). A `gone` state produced from that
// would be an over-claim ([LAW:types-are-the-program]) that could false-dead a
// live owner and reclaim its socket. So:
//   start       — the pid is live and this is its start-time token (the ONLY
//                 thing `ps` can assert soundly: it printed a row).
//   unavailable — no start-time came back (absent OR unreadable OR errored),
//                 from `ps` or from /proc alike.
//                 Callers defer to kill(pid,0), the sound liveness test, which
//                 correctly reclaims a truly-dead pid and spares a live one.
// The fingerprint's unique contribution is the `start`+mismatch case (a recycled
// pid whose live start-time differs from the lease); everything else falls back
// to kill, no worse than before the fingerprint existed.
export type StartTimeRead =
  | { kind: "start"; token: string }
  | { kind: "unavailable"; detail: string };

// `launch` is the subprocess boundary, injected so the parse/branch logic is
// exercised by input enumeration with a fake launcher while the real path runs
// the real `ps`.
// [LAW:effects-at-boundaries][LAW:single-enforcer] The sole effect (spawning
// `ps`) goes through the one subprocess enforcer, `launch`, off the loop: a
// detached holder of its stdout cannot hold the daemon. The ONLY sound
// signal `ps` gives is a printed start-time row (a live pid we could read);
// [LAW:no-silent-failure] every other outcome — absent pid, access failure,
// spawn-error, timeout — is `unavailable`, deferring the alive/dead call to
// kill(pid,0) rather than risk declaring a live owner dead from a `ps` exit
// code that cannot distinguish "gone" from "cannot read".
export async function readStartTime(
  pid: number,
  launch: Launcher["launch"],
): Promise<StartTimeRead> {
  const res = await launch({
    bin: "ps",
    args: ["-o", "lstart=", "-p", String(pid)],
    category: "process-fingerprint",
    timeoutMs: 2000,
    // [FRAMING:representation] Pin BOTH locale and timezone so the token is
    // deterministic across daemons — the writer and reader must render the same
    // process identically for opaque string equality to be sound. LC_ALL=C fixes
    // the strftime format; TZ=UTC fixes localtime(), so DST / TZ / tzdata changes
    // can't make one live process render two different start-time strings.
    envOverlay: { LC_ALL: "C", TZ: "UTC" },
  });
  if (res.ok) {
    const token = res.stdout.trim();
    if (token.length > 0) return { kind: "start", token };
    // Exit 0 with empty output is anomalous (a live pid always lists) — don't
    // mint an empty-string fingerprint; defer to kill.
    return { kind: "unavailable", detail: "ps produced no start-time" };
  }
  const detail =
    res.reason === "spawn-error"
      ? (res.error ?? "ps spawn failed")
      : `ps ${res.reason} (exit ${res.exitCode})`;
  return { kind: "unavailable", detail };
}

// [LAW:effects-at-boundaries] What the daemon asks of the machine's process
// table about one pid: is a process there, and when did it start. Everything
// that decides from these (the liveness fold below, the lease, the watchdog)
// takes a probe, so a test names the processes it means instead of starting
// them. This is not src/proc/process-table.ts, which reads the whole `ps -A`
// listing for descent; this answers about a pid's identity.
export interface ProcessProbe {
  // [LAW:no-silent-failure] ESRCH: the process is gone. EPERM: a live process
  // we don't own (the pid was reused by another user), taken as alive so a
  // reused pid can never make us act on a process whose real owner still runs.
  alive(pid: number): boolean;
  startTime(pid: number): Promise<StartTimeRead>;
}

// The machine's own process table, read through the owner's launcher. The
// start-time source is chosen at the first read, not at construction, because
// a probe is built at import by modules that never read one.
export function systemProbe(launcher: Pick<Launcher, "launch">): ProcessProbe {
  let source: ((pid: number) => Promise<StartTimeRead>) | undefined;
  const chosen = (): ((pid: number) => Promise<StartTimeRead>) => {
    const bootId = readBootId();
    return bootId === null
      ? (pid) => readStartTime(pid, launcher.launch)
      : (pid) => readProcStartTime(pid, bootId);
  };
  return {
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    startTime: async (pid) => (source ??= chosen())(pid),
  };
}

// The boot this host is running, or null where there is no /proc to read it
// from. Part of a /proc token because the stat's start-time counts clock ticks
// since boot, which repeat across a reboot that a lease can outlive.
// [LAW:no-silent-failure] Only a missing /proc chooses `ps`; any other failure
// to read it is loud, because a host whose daemons chose different sources
// would compare tokens that can never agree.
function readBootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

async function readProcStartTime(
  pid: number,
  bootId: string,
): Promise<StartTimeRead> {
  let stat: string;
  try {
    stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    return { kind: "unavailable", detail: (e as Error).message };
  }
  const ticks = procStatStartTime(stat);
  return ticks === null
    ? { kind: "unavailable", detail: `unparseable /proc/${pid}/stat` }
    : { kind: "start", token: `${bootId}:${ticks}` };
}

// [LAW:parse-dont-validate] The start-time (field 22, clock ticks since boot)
// of a /proc/<pid>/stat line, or null when the line has none. The command name
// (field 2) sits in parentheses and may itself hold spaces or a `)`, so fields
// are counted from the last `)`: the field after it is the third.
export function procStatStartTime(stat: string): string | null {
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(" ");
  const ticks = fields[22 - 3];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

// [LAW:single-enforcer] Whether two identities name one process: the same pid
// and the same start-time token. Every comparison of a recorded owner with a
// process (the arbitration, the ownership self-check) asks it here.
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startTime === b.startTime;
}

// [LAW:dataflow-not-control-flow] The liveness verdict is a pure fold over
// kill(pid,0), the start-time read and the lease's recorded token. Full input
// space:
//   pid not alive                      → false, and no start-time is read: a
//                                        dead pid is stale whatever it recorded
//   alive + lease token null           → true  (nothing to compare; the writer
//                                        could not fingerprint)
//   alive + read=start                 → sameProcess (a different token is a
//                                        recycled pid, or a restarted daemon)
//   alive + read=unavailable           → kill(pid,0) again (a live pid the read
//                                        could not answer is spared)
//
// [LAW:no-silent-failure] Only the `start`+mismatch case comes from the
// fingerprint; every ambiguous read defers to kill, so the DANGEROUS direction
// (declaring a live daemon dead → stealing its socket, the storm this epic
// fights) never happens merely because the read could not answer. The only
// thing forfeited when it cannot is detecting a recycled pid.
export async function sameLiveProcess(
  pid: number,
  leaseToken: string | null,
  probe: ProcessProbe,
): Promise<boolean> {
  if (!probe.alive(pid)) return false;
  if (leaseToken === null) return true;
  const read = await probe.startTime(pid);
  switch (read.kind) {
    case "start":
      return sameProcess(
        { pid, startTime: leaseToken },
        { pid, startTime: read.token },
      );
    case "unavailable":
      return probe.alive(pid);
  }
}

// Read THIS process's own start-time to stamp into its lease. `unavailable`
// (a read that could not answer) collapses to `null` — the lease records "unfingerprinted", and every
// reader of it falls back to kill(pid,0) via sameLiveProcess. A dead result is
// impossible for our own live pid; if it somehow occurs we also record null.
export async function readOwnStartTime(
  pid: number,
  read: (pid: number) => Promise<StartTimeRead>,
): Promise<string | null> {
  const r = await read(pid);
  return r.kind === "start" ? r.token : null;
}
