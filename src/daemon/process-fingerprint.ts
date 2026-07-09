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

// A read of a pid's kernel start-time. Three outcomes, kept distinct because
// each drives a different liveness verdict:
//   start       — the pid is live and this is its start-time token.
//   gone        — the pid names no live process (safe to treat as dead).
//   unavailable — this host cannot answer (`ps` missing/errored). We must NOT
//                 read this as `gone` — that would reclaim a live daemon's
//                 socket on a stripped host — so callers fall back to a weaker
//                 liveness signal (kill(pid,0)) instead.
export type StartTimeRead =
  | { kind: "start"; token: string }
  | { kind: "gone" }
  | { kind: "unavailable"; detail: string };

// The subprocess boundary, injected so the parse/branch logic is exercised by
// input enumeration with a fake launcher while the real path runs the real `ps`.
export type Launcher = (opts: LaunchOpts) => LaunchResult;

// [LAW:effects-at-boundaries][LAW:single-enforcer] The sole effect (spawning
// `ps`) goes through the one subprocess enforcer, `launchSync`. `ps` prints a
// start-time row ONLY for a live pid, so a non-empty trimmed stdout is the live
// signal; a clean non-zero exit with empty stdout is `ps`'s confirmed "no such
// process"; a spawn-error (no `ps`) or an ambiguous failure degrades to
// `unavailable` so the caller falls back to kill(pid,0) rather than risk
// declaring a live owner dead [LAW:no-silent-failure].
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
    // Exit 0 with empty output would be anomalous (a live pid always lists);
    // treat it as `gone` rather than minting an empty-string fingerprint.
    return token.length > 0 ? { kind: "start", token } : { kind: "gone" };
  }
  // `ps` absent (spawn-error) → this host cannot fingerprint at all.
  if (res.reason === "spawn-error") {
    return { kind: "unavailable", detail: res.error ?? "ps spawn failed" };
  }
  // A clean non-zero exit with EMPTY stdout is the definitive dead-pid case; a
  // non-zero exit that still produced output, or a timeout/signal, is ambiguous.
  if (res.reason === "non-zero") {
    return res.stdout.trim().length === 0
      ? { kind: "gone" }
      : { kind: "unavailable", detail: `ps exit ${res.exitCode}` };
  }
  return { kind: "unavailable", detail: `ps ${res.reason}` };
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
//   read=gone                          → false (no live process)
//   read=unavailable                   → kill(pid,0) fallback (can't fingerprint
//                                        → preserve .1's theft protection; only
//                                        the recycle-detection is lost)
//   lease token = null (unfingerprinted at write, e.g. a host without `ps`) →
//                                        kill(pid,0) fallback for the same reason
//
// [LAW:no-silent-failure] The fallback is chosen so the DANGEROUS direction
// (declaring a live daemon dead → stealing its socket, the storm this epic
// fights) never happens merely because a host cannot fingerprint; the only thing
// forfeited without `ps` is detecting a recycled pid.
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
    case "gone":
      return false;
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
