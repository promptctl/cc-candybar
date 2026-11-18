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
// a bare pid. On linux the kernel's own record is read from /proc: the
// start-time field of the pid's stat beside the boot id, so no subprocess runs
// and a read cannot time out. Elsewhere (darwin) `ps -o lstart=` exposes it.
// The platform settles the source once for the host. Each token is tagged with
// the source that minted it (`proc:` or `ps:`), and tokens from two sources are
// never compared: they say nothing about each other. Within a source the token
// is treated as OPAQUE — compared by string
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
//                 thing a read can assert soundly: it found the pid's row).
//   unavailable — no start-time came back (absent OR unreadable OR errored),
//                 from `ps` or from /proc alike, with the reason.
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
    const lstart = res.stdout.trim();
    if (lstart.length > 0) return { kind: "start", token: `ps:${lstart}` };
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

// [LAW:one-source-of-truth] Where this host reads a start-time, settled once
// from the platform: linux keeps every process's in /proc, darwin has no /proc
// and answers through `ps`. A linux host whose /proc cannot be read gets
// `unavailable` with the reason, never a quiet switch to `ps`, because daemons
// on one host that read different sources would compare nothing.
const HOST_SOURCE: "proc" | "ps" = process.platform === "linux" ? "proc" : "ps";

// The machine's own process table, read through the owner's launcher.
export function systemProbe(launcher: Pick<Launcher, "launch">): ProcessProbe {
  return {
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    startTime:
      HOST_SOURCE === "proc"
        ? readProcStartTime
        : (pid) => readStartTime(pid, launcher.launch),
  };
}

// The boot id goes into a /proc token because the stat's start-time counts
// clock ticks since boot, which repeat across a reboot that a lease can outlive.
async function readProcStartTime(pid: number): Promise<StartTimeRead> {
  let bootId: string;
  let stat: string;
  try {
    bootId = (
      await fs.promises.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    return { kind: "unavailable", detail: (e as Error).message };
  }
  const ticks = procStatStartTime(stat);
  return ticks === null
    ? { kind: "unavailable", detail: `unparseable /proc/${pid}/stat` }
    : { kind: "start", token: `proc:${bootId}:${ticks}` };
}

// [LAW:parse-dont-validate] The start-time (field 22, clock ticks since boot)
// of a /proc/<pid>/stat line, or null when the line has none. The command name
// (field 2) sits in parentheses and may itself hold spaces or a `)`, so fields
// are counted from the last `)`: the field after it is the third.
export function procStatStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const ticks = stat
    .slice(close + 1)
    .trim()
    .split(" ")[22 - 3];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

// What comparing two identities can say. `incomparable` is a pair with nothing
// to tell them apart by: the same pid where either start-time is missing, or
// the two were read by different sources. It is never taken as a mismatch.
export type Sameness = "same" | "different" | "incomparable";

// The source a token was minted by, read off its tag. A token minted before
// tags is `untagged`, a source of its own.
const sourceOf = (token: string): "proc" | "ps" | "untagged" =>
  token.startsWith("proc:")
    ? "proc"
    : token.startsWith("ps:")
      ? "ps"
      : "untagged";

// [LAW:single-enforcer] Whether two identities name one process. Every
// comparison of a recorded process with another (the arbitration, the ownership
// self-check, the fork-bomb registry, the update act) asks it here.
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): Sameness {
  if (a.pid !== b.pid) return "different";
  if (a.startTime === null || b.startTime === null) return "incomparable";
  if (sourceOf(a.startTime) !== sourceOf(b.startTime)) return "incomparable";
  return a.startTime === b.startTime ? "same" : "different";
}

// What the liveness fold found about a recorded owner, and why: the reason is
// what an arbitration's log line says.
export interface Liveness {
  readonly live: boolean;
  readonly why: string;
}

// [LAW:dataflow-not-control-flow] The liveness verdict is a pure fold over
// kill(pid,0), the start-time read and the recorded token. Full input space:
//   pid not alive                 → not live, and no start-time is read: a dead
//                                   pid is stale whatever it recorded
//   alive + recorded token null   → live (nothing to compare)
//   alive + read=start            → by sameProcess: `different` is a recycled
//                                   pid or a restarted daemon; `incomparable`
//                                   (two sources) is spared
//   alive + read=unavailable      → kill(pid,0) again, with the read's reason
//
// [LAW:no-silent-failure] Only a `different` start-time comes from the
// fingerprint; every ambiguous read defers to kill, so the DANGEROUS direction
// (declaring a live daemon dead → stealing its socket, the storm this epic
// fights) never happens merely because the read could not answer. The only
// thing forfeited when it cannot is detecting a recycled pid.
export async function liveness(
  pid: number,
  recorded: string | null,
  probe: ProcessProbe,
): Promise<Liveness> {
  if (!probe.alive(pid)) return { live: false, why: "is gone" };
  if (recorded === null)
    return { live: true, why: "is alive; no start time was recorded" };
  const read = await probe.startTime(pid);
  if (read.kind === "unavailable")
    return probe.alive(pid)
      ? { live: true, why: `is alive, start time unreadable: ${read.detail}` }
      : { live: false, why: "is gone" };
  switch (
    sameProcess({ pid, startTime: recorded }, { pid, startTime: read.token })
  ) {
    case "same":
      return { live: true, why: "is alive with its recorded start time" };
    case "different":
      return {
        live: false,
        why: "is another process now (its start time differs)",
      };
    case "incomparable":
      return {
        live: true,
        why: "is alive; its start time was recorded by another source",
      };
  }
}

// The verdict alone, for a caller with no line to log.
export async function sameLiveProcess(
  pid: number,
  recorded: string | null,
  probe: ProcessProbe,
): Promise<boolean> {
  return (await liveness(pid, recorded, probe)).live;
}

// Read THIS process's own start-time to stamp into its lease. `unavailable`
// (a read that could not answer) collapses to `null`: the lease records no
// start time, and every reader of it judges by kill(pid,0) alone.
export async function readOwnStartTime(
  pid: number,
  read: (pid: number) => Promise<StartTimeRead>,
): Promise<string | null> {
  const r = await read(pid);
  return r.kind === "start" ? r.token : null;
}
