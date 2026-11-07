import {
  whyFailed,
  type LaunchOpts,
  type LaunchResult,
  type Launcher,
} from "../proc/launch";

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
// when neither side parses. That opaque-equality invariant holds ONLY if the
// GENERATOR is deterministic. `ps -o lstart=` is strftime-formatted (locale) via
// `localtime()` (timezone), so the SAME process renders different tokens across a
// locale change OR a timezone change (TZ env, DST, tzdata update). We pin BOTH on
// the `ps` subprocess — `LC_ALL=C` (dominates any ambient LC_TIME/LC_ALL) and
// `TZ=UTC` — so the token is a locale- and timezone-invariant UTC rendering of
// the start instant, and equality is sound. Claude Code writes the same token
// as its session record's `procStart`. The Rust client is the one other
// generator: it reads its parent's start from the kernel with no spawn and
// renders the token itself, and its test of that rendering against `ps` on one
// process (rust-client/src/process_start.rs) is what keeps the two equal.

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

// [LAW:parse-dont-validate] A start-time token as `ps -o lstart=` prints it
// under the pinning above (`Fri Nov  6 02:12:23 2026`), checked for that shape
// where it arrives from outside: a client's hint, the record Claude Code keeps
// of its process. Compared by equality, like every token here.
export type StartToken = string & { readonly __brand: "StartToken" };

const START_TOKEN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 123]\d \d\d:\d\d:\d\d \d{4}$/;

export const parseStartToken = (v: unknown): StartToken | undefined =>
  typeof v === "string" && START_TOKEN.test(v) ? (v as StartToken) : undefined;

// A process's identity with its start checked for the token's shape, or
// `null` and why its start could not be read.
export type ParsedProcessIdentity =
  | { readonly pid: number; readonly startTime: StartToken }
  | { readonly pid: number; readonly startTime: null; readonly why: string };

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

// The longest one read of a start time may take.
export const START_TIME_READ_BUDGET_MS = 2000;

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
  return startTimeOf(await launch(startTimeLaunch(pid)));
}

// [LAW:single-enforcer] The one spec of a start-time read and the one fold of
// its result: a client's blocking read of its parent (src/host.ts) runs these
// too, so the pinning above holds for every `ps` token this codebase reads.
export const startTimeLaunch = (
  pid: number,
  budgetMs: number = START_TIME_READ_BUDGET_MS,
): LaunchOpts => ({
  bin: "ps",
  args: ["-o", "lstart=", "-p", String(pid)],
  category: "process-fingerprint",
  timeoutMs: budgetMs,
  // [FRAMING:representation] Pin BOTH locale and timezone so the token is
  // deterministic across daemons — the writer and reader must render the same
  // process identically for opaque string equality to be sound. LC_ALL=C fixes
  // the strftime format; TZ=UTC fixes localtime(), so DST / TZ / tzdata changes
  // can't make one live process render two different start-time strings.
  envOverlay: { LC_ALL: "C", TZ: "UTC" },
});

// [LAW:single-enforcer] The one fold of a start read into the identity a
// record or a hint names, so every reader says the same why for a start it
// could not use.
export function processIdentityOf(
  pid: number,
  read: StartTimeRead,
): ParsedProcessIdentity {
  if (read.kind === "unavailable")
    return { pid, startTime: null, why: read.detail };
  const startTime = parseStartToken(read.token);
  return startTime === undefined
    ? {
        pid,
        startTime: null,
        why: `ps printed ${JSON.stringify(read.token)}, not a start in the form \`ps -o lstart=\` prints`,
      }
    : { pid, startTime };
}

export function startTimeOf(res: LaunchResult): StartTimeRead {
  if (res.ok) {
    const token = res.stdout.trim();
    if (token.length > 0) return { kind: "start", token };
    // Exit 0 with empty output is anomalous (a live pid always lists) — don't
    // mint an empty-string fingerprint; defer to kill.
    return { kind: "unavailable", detail: "ps produced no start-time" };
  }
  // [LAW:single-enforcer] Said as the launcher says every failure: this is
  // the why a client's unread start shows on the bar.
  return { kind: "unavailable", detail: `ps ${whyFailed(res)}` };
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
    startTime: (pid) => readStartTime(pid, launcher.launch),
  };
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
export async function sameLiveProcess(
  pid: number,
  leaseToken: string | null,
  probe: ProcessProbe,
): Promise<boolean> {
  if (leaseToken === null) return probe.alive(pid);
  const read = await probe.startTime(pid);
  switch (read.kind) {
    case "start":
      return read.token === leaseToken;
    case "unavailable":
      return probe.alive(pid);
  }
}

// Read THIS process's own start-time to stamp into its lease. `unavailable`
// (no `ps`) collapses to `null` — the lease records "unfingerprinted", and every
// reader of it falls back to kill(pid,0) via sameLiveProcess. A dead result is
// impossible for our own live pid; if it somehow occurs we also record null.
export async function readOwnStartTime(
  pid: number,
  read: (pid: number) => Promise<StartTimeRead>,
): Promise<string | null> {
  const r = await read(pid);
  return r.kind === "start" ? r.token : null;
}
