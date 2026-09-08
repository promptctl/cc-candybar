import { launchSync, type LaunchOpts, type LaunchResult } from "../proc/launch";

// [FRAMING:representation] A bare pid is under-constrained: pids are recycled, so
// (pid, start-time) is the pair that IS a process identity.
// [LAW:one-source-of-truth] The start-time token is OPAQUE — string equality, never
// parsed — which is sound only because LC_ALL=C and TZ=UTC pin `ps -o lstart=`.

// [LAW:one-source-of-truth] Declared once here: every owner-of-a-resource record names its owner with exactly this shape.
export interface ProcessIdentity {
  pid: number;
  startTime: string | null;
}

// [LAW:types-are-the-program] Only TWO outcomes: nothing derivable from a `ps` exit
// code can soundly prove a process DEAD, so `unavailable` defers to kill(pid,0).
export type StartTimeRead =
  | { kind: "start"; token: string }
  | { kind: "unavailable"; detail: string };

export type Launcher = (opts: LaunchOpts) => LaunchResult;

// [LAW:effects-at-boundaries][LAW:single-enforcer] The sole effect goes through launchSync.
// [LAW:no-silent-failure] A printed start-time row is the only sound signal; every other outcome defers the call to kill.
export function readStartTime(
  pid: number,
  launch: Launcher = launchSync,
): StartTimeRead {
  const res = launch({
    bin: "ps",
    args: ["-o", "lstart=", "-p", String(pid)],
    category: "process-fingerprint",
    timeoutMs: 2000,
    // [FRAMING:representation] Pin locale AND timezone, or one live process renders two different start-time strings across a DST/TZ/tzdata change.
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (res.ok) {
    const token = res.stdout.trim();
    if (token.length > 0) return { kind: "start", token };
    // Exit 0 with empty output is anomalous — don't mint an empty fingerprint.
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

// [LAW:dataflow-not-control-flow] A pure fold over the start-time read and the
// lease's token. [LAW:no-silent-failure] Only `start`+mismatch comes from the
// fingerprint; every ambiguous outcome defers to kill, so a live daemon is never
// declared dead and its socket stolen merely because `ps` could not answer.
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

// `unavailable` collapses to null: the lease records "unfingerprinted" and every reader falls back to kill(pid,0).
export function readOwnStartTime(
  pid: number,
  read: (pid: number) => StartTimeRead = readStartTime,
): string | null {
  const r = read(pid);
  return r.kind === "start" ? r.token : null;
}
