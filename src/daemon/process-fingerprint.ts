import { launchSync, type LaunchOpts, type LaunchResult } from "../proc/launch";

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
// (darwin + linux). The reported token is treated as OPAQUE — compared by string
// equality, never parsed — so there is no date-format representation to drift
// [FRAMING:representation]: a producer/consumer parse mismatch is unrepresentable
// when neither side parses.

// A read of a pid's kernel start-time. Only TWO outcomes, because nothing
// derivable from a `ps` exit code can SOUNDLY prove a process is dead — a
// non-zero exit means "no start-time to report", which conflates a genuinely
// absent pid with an access failure (hardened `/proc`/`hidepid`, a
// permission-denied read of a live process). A `gone` state produced from that
// would be an over-claim ([LAW:types-are-the-program]) that could false-dead a
// live owner and reclaim its socket. So:
//   start       — the pid is live and this is its start-time token (the ONLY
//                 thing `ps` can assert soundly: it printed a row).
//   unavailable — `ps` reported no start-time (absent OR unreadable OR errored).
//                 Callers defer to kill(pid,0), the sound liveness test, which
//                 correctly reclaims a truly-dead pid and spares a live one.
// The fingerprint's unique contribution is the `start`+mismatch case (a recycled
// pid whose live start-time differs from the lease); everything else falls back
// to kill, no worse than before the fingerprint existed.
export type StartTimeRead =
  | { kind: "start"; token: string }
  | { kind: "unavailable"; detail: string };

// The subprocess boundary, injected so the parse/branch logic is exercised by
// input enumeration with a fake launcher while the real path runs the real `ps`.
export type Launcher = (opts: LaunchOpts) => LaunchResult;

// [LAW:effects-at-boundaries][LAW:single-enforcer] The sole effect (spawning
// `ps`) goes through the one subprocess enforcer, `launchSync`. The ONLY sound
// signal `ps` gives is a printed start-time row (a live pid we could read);
// [LAW:no-silent-failure] every other outcome — absent pid, access failure,
// spawn-error, timeout — is `unavailable`, deferring the alive/dead call to
// kill(pid,0) rather than risk declaring a live owner dead from a `ps` exit
// code that cannot distinguish "gone" from "cannot read".
export function readStartTime(
  pid: number,
  launch: Launcher = launchSync,
): StartTimeRead {
  const res = launch({
    bin: "ps",
    args: ["-o", "lstart=", "-p", String(pid)],
    category: "process-fingerprint",
    timeoutMs: 2000,
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

export interface LivenessDeps {
  readStartTime: (pid: number) => StartTimeRead;
  pidAlive: (pid: number) => boolean;
}

// [LAW:dataflow-not-control-flow] The liveness verdict is a pure fold over the
// start-time read + the lease's recorded token. Full input space:
//   read=start + token matches lease   → true  (same process still alive)
//   read=start + token differs         → false (a DIFFERENT process holds the
//                                        pid — a recycle, or a restarted daemon)
//   read=unavailable                   → kill(pid,0) fallback (the sound
//                                        alive/dead test: a truly-dead pid →
//                                        false → reclaim; a live pid ps couldn't
//                                        read → true → spared)
//   lease token = null (unfingerprinted at write, e.g. a host without `ps`) →
//                                        kill(pid,0) fallback for the same reason
//
// [LAW:no-silent-failure] Only the `start`+mismatch case comes from the
// fingerprint; every ambiguous `ps` outcome defers to kill, so the DANGEROUS
// direction (declaring a live daemon dead → stealing its socket, the storm this
// epic fights) never happens merely because `ps` could not answer. The only
// thing forfeited when `ps` cannot answer is detecting a recycled pid.
export function sameLiveProcess(
  pid: number,
  leaseToken: string | null,
  deps: LivenessDeps,
): boolean {
  if (leaseToken === null) return deps.pidAlive(pid);
  const read = deps.readStartTime(pid);
  switch (read.kind) {
    case "start":
      return read.token === leaseToken;
    case "unavailable":
      return deps.pidAlive(pid);
  }
}

// Read THIS process's own start-time to stamp into its lease. `unavailable`
// (no `ps`) collapses to `null` — the lease records "unfingerprinted", and every
// reader of it falls back to kill(pid,0) via sameLiveProcess. A dead result is
// impossible for our own live pid; if it somehow occurs we also record null.
export function readOwnStartTime(
  pid: number,
  read: (pid: number) => StartTimeRead = readStartTime,
): string | null {
  const r = read(pid);
  return r.kind === "start" ? r.token : null;
}
