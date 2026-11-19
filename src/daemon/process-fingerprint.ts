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
// a bare pid. `ps -o lstart=` exposes the start-time on every Unix we ship to
// (darwin + linux). The token is persisted in leases, registry entries and act
// records that daemons of every release read, so its spelling is fixed: it is
// treated as OPAQUE — compared by string equality, never parsed — so there is no date-format representation to drift
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
//                 with the reason.
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
async function readStartTime(
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
// table about one pid: is a process of ours there, and when did it start.
// Everything that decides from these (the liveness fold below, the lease, the
// watchdog) takes a probe, so a test names the processes it means instead of
// starting them.
export interface ProcessProbe {
  // [LAW:no-silent-failure] ESRCH: the process is gone. EPERM: the pid belongs
  // to another user, and so is no process of ours: every file that names one of
  // our processes lives under a directory only we can read.
  alive(pid: number): boolean;
  startTime(pid: number): Promise<StartTimeRead>;
}

// The machine's own process table, read through the owner's launcher.
export function systemProbe(launcher: Pick<Launcher, "launch">): ProcessProbe {
  return {
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    startTime: (pid) => readStartTime(pid, launcher.launch),
  };
}

// What comparing two identities can say. `incomparable` is a pair with nothing
// to tell them apart by: the same pid where either start time is missing (a
// record written by a release that let one be). It is never taken as a
// mismatch.
export type Sameness = "same" | "different" | "incomparable";

// [LAW:single-enforcer] Whether two identities name one process. Every
// comparison of a recorded process with another (the arbitration, the ownership
// self-check and the fork-bomb registry) asks it here. The
// token is compared exactly as every release has spelled and compared it, so a
// record either release writes reads the same to both.
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): Sameness {
  if (a.pid !== b.pid) return "different";
  if (a.startTime === null || b.startTime === null) return "incomparable";
  return a.startTime === b.startTime ? "same" : "different";
}

// What the liveness fold found about a recorded owner, and why: the reason is
// what an arbitration's log line says.
export interface Liveness {
  readonly live: boolean;
  readonly why: string;
}

const GONE: Liveness = { live: false, why: "is gone" };

// [LAW:dataflow-not-control-flow] The liveness verdict is a pure fold over
// kill(pid,0), the start-time read and the recorded token. Full input space:
//   pid not ours                  → not live, and no start time is read: a dead
//                                   pid is stale whatever it recorded
//   ours + read=start             → by sameProcess: `different` is a recycled
//                                   pid or a restarted daemon; `incomparable`
//                                   (a record with no start time) is spared
//   ours + read=unavailable       → kill(pid,0) again, with the read's reason
//
// [LAW:no-silent-failure] Only a `different` start time comes from the
// fingerprint; every ambiguous read defers to kill, so the DANGEROUS direction
// (declaring a live daemon dead → stealing its socket, the storm this epic
// fights) never happens merely because the read could not answer. The only
// thing forfeited when it cannot is detecting a recycled pid.
export async function liveness(
  pid: number,
  recorded: string | null,
  probe: ProcessProbe,
): Promise<Liveness> {
  if (!probe.alive(pid)) return GONE;
  const read = await probe.startTime(pid);
  if (read.kind === "unavailable")
    return probe.alive(pid)
      ? { live: true, why: `is alive, start time unreadable: ${read.detail}` }
      : GONE;
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
      return { live: true, why: "is alive; its record holds no start time" };
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

// [LAW:no-silent-failure] THIS process's own start time, which every record it
// writes names it by. A record without one could never be told from a process
// that reuses our pid, so a read that cannot answer is an error for the boot to
// refuse on, never a null written down.
export async function readOwnStartTime(
  pid: number,
  read: (pid: number) => Promise<StartTimeRead>,
): Promise<string> {
  const r = await read(pid);
  if (r.kind === "start") return r.token;
  throw new Error(`cannot read this process's own start time: ${r.detail}`);
}
