// [LAW:single-enforcer] Every subprocess in the Node runtime goes through one
// boundary. Every module launches through a `Launcher` from here, and this file
// decides each launch; the OS's side of it (starting a child, signalling its
// group) is a `Spawner` (src/proc/spawner.ts), the one file that names
// `node:child_process`. The ESLint config (and the kz8.2 DoD grep) enforces this.
//
// [LAW:no-shared-mutable-globals] A launch carries its owner: everything a
// launch reads or leaves behind is held by the `Launcher` it went through, so a
// closed owner's work is refused by that owner however many others are running.
//
// [LAW:one-type-per-behavior] `exec`/`execFile`/`spawn` and their sync twins
// are seven names for one act. `LaunchOpts` is the single shape; sync vs async
// is a separate function pair, not a config flag.
//
// [LAW:dataflow-not-control-flow] Categories flow through one boundary as
// data; the body is the same code path for every category. The metering layer
// reads the category off the request, not off the call site.
//
// [LAW:types-are-the-program] (kz8.6) Process lifetime is encoded in the
// operation, not in a flag. `launch`/`launchSync` are *waited*: the child is
// reaped before the caller resumes, so it cannot outlive its frame (the one
// exception is a group the launcher was refused to signal: `signal-refused`).
// `launchDetachedSync` is the *orphan*: it detaches and unrefs, deliberately
// outliving its caller — the daemon-handoff escape hatch, used only by the
// daemon-acquisition path. `launchJobSync` is the *job*: it outlives its
// launcher too, but its output and its verdict are files it owns, so any
// process can read how it ended. There is no `detached: boolean` flag on
// `LaunchOpts` ([LAW:no-mode-explosion]); the three lifetimes are three
// functions with three return contracts, so an unwaited helper that survives a
// render frame is unrepresentable here rather than forbidden by convention.
//
// A `launch` child leads its own process group, so terminating it (the timeout,
// or the caller's `signal`) reaches everything it spawned: `sh -c "sleep 5;
// echo x"` keeps `sh` as the parent and `sleep` as a grandchild, and signalling
// `sh` alone would orphan the `sleep`. The price is that a terminal's SIGINT
// no longer reaches a foreground CLI's children through the tty, and nothing
// aimed at the launcher's own group reaches them either: a child ends by its
// timeout, its caller's `signal`, its own exit, or the lifeline (below) when
// the process that launched it ends.

import { existsSync, readFileSync } from "node:fs";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { elapsedMs, type Monotonic, type Timekeeper } from "../time";
import { publishByLink } from "../utils/atomic-write";
import { withoutRepositoryScopedEnv } from "../repository-cli";
import type { SpawnedChild, Spawner } from "./spawner";

import type { DrainEnd, LaunchStatsHandle } from "./stats-handle";
import type {
  LaunchCategory,
  LaunchOpts,
  AsyncLaunchOpts,
  LaunchResult,
  Refusal,
  LifelineWarning,
  WarningChange,
  JobEnd,
  JobFiles,
  JobLaunch,
  JobEnding,
  Launcher,
  Channel,
  ChannelOpts,
} from "./launcher";

// [LAW:no-silent-failure] A spawn whose `cwd` is gone fails with the SAME
// errno as a missing binary — Node words it `spawn /bin/sh ENOENT`, blaming
// the shell. The one place a spawn failure becomes text names the directory
// instead when that is what is missing (a removed worktree the session is
// still rendering from). Measured only on the failure path.
function spawnErrorText(err: unknown, cwd: string | undefined): string {
  // isNativeError, not instanceof: the realm-proof test (Node's own errors
  // fail `instanceof Error` under a vm context such as Jest's).
  if (!types.isNativeError(err)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" && cwd !== undefined && !existsSync(cwd)
    ? `working directory does not exist: ${cwd}`
    : err.message;
}

// [LAW:single-enforcer] Per-category minimum interval between spawn attempts
// (start timestamps). The limiter records on attempt, not on success — a
// failed spawn still arms the timer so a broken binary can't be retried in a
// tight loop. Sparse map: categories without entries have no rate limit.
// [LAW:no-mode-explosion] Bounds are constants here, not config knobs — the
// caps protect the host from misbehaving renderers/templates and don't need
// user tuning. Bump these if a legitimate workload starts hitting them.
const RATE_LIMITS: Partial<Record<LaunchCategory, number>> = {
  // Click verbs: a misbehaving template emitting many clickable links + a
  // user rapid-clicking = unbounded helpers. One spawn per second is enough
  // for any human click cadence.
  "click.pbcopy": 1000,
  "click.open": 1000,
  // A double-click is refused rather than typing and submitting its command
  // twice. Daemon-wide, so two sessions typing in one second collide. Only
  // the typing is limited: a click the pane refused typed
  // nothing, so clicking again once the dialog is closed goes through.
  "claude-input.type": 1000,
};

// [LAW:dataflow-not-control-flow] The rate-limit decision is a pure function
// of (category, now, last-start, policy). Same code path every call; the
// result type carries which branch fired.
function checkRateLimit(
  lastStartAt: ReadonlyMap<LaunchCategory, Monotonic>,
  category: LaunchCategory,
  now: number,
):
  | { allowed: true }
  | { allowed: false; minIntervalMs: number; sinceLastMs: number } {
  const minIntervalMs = RATE_LIMITS[category];
  if (minIntervalMs === undefined) return { allowed: true };
  const last = lastStartAt.get(category);
  if (last === undefined) return { allowed: true };
  const sinceLastMs = now - last;
  if (sinceLastMs >= minIntervalMs) return { allowed: true };
  return { allowed: false, minIntervalMs, sinceLastMs };
}

// [LAW:one-source-of-truth] The environment every child gets, the lifeline's
// included: the launch's own (a session's), or else its owner's, read live at
// each launch, with REPOSITORY_SCOPED_ENV withheld; then the launch's overlay
// over that. Passing `undefined` lets node read the host process's environment
// directly, which is a second clock: under a realm boundary (Jest's sandbox
// copies `process.env` per test file) the two diverge, and a PATH the test set
// for a `shell` source never reached the shell it spawned
// (brandon-custom-segments-g5z.3's doc stubs ran as 127). An overlay entry of
// null removes that variable: node's spawn skips undefined values.
function childEnv(
  scope: LaunchScope,
  opts: Pick<LaunchOpts, "environment" | "envOverlay">,
): NodeJS.ProcessEnv {
  // [LAW:single-enforcer] The one strip; REPOSITORY_SCOPED_ENV says why.
  const env: NodeJS.ProcessEnv = {
    ...(opts.environment ?? withoutRepositoryScopedEnv(scope.inherited)),
  };
  for (const [name, value] of Object.entries(opts.envOverlay ?? {}))
    env[name] = value ?? undefined;
  return env;
}

// [LAW:one-source-of-truth] Whoever aborted a signal said why when they did.
const refusedAsAborted = ({ reason }: AbortSignal): Refusal => ({
  ok: false,
  reason: "aborted",
  stdout: "",
  stderr: "",
  exitCode: null,
  signal: null,
  error: reason instanceof Error ? reason.message : String(reason),
});

function rateLimitedResult(
  category: LaunchCategory,
  minIntervalMs: number,
  sinceLastMs: number,
): Refusal {
  return {
    ok: false,
    reason: "rate-limited",
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    error: `rate-limited: ${category} min interval ${minIntervalMs}ms, last start ${Math.round(sinceLastMs)}ms ago`,
  };
}

// Who a launcher's launches belong to.
export interface LaunchScope {
  // The owner's own environment, live: the one its root reads its own facts
  // from, and what its children start from.
  readonly inherited: NodeJS.ProcessEnv;
  // Meters every launch into the owner's stats. Null pays no metering cost.
  readonly stats: LaunchStatsHandle | null;
  // Hears each change in the launcher's warnings: why the lifeline is down
  // (`fault`, below), and each pipe event. The daemon logs it and redraws its
  // feeds, so a warning comes on pushed frames too; one going needs no call,
  // since every render reads the hold against its own instant.
  readonly observeWarnings: (change: WarningChange) => void;
  // [LAW:single-enforcer] The one checkpoint for "nothing launches after the
  // owner closed": every spawn crosses this module, so a launch in flight is
  // terminated and a later one refused, whichever part of the owner's work it
  // was. An aborted scope stays closed: nothing replaces it.
  readonly signal: AbortSignal;
  // The machine's clock: what its launches time themselves, their timeouts and
  // kill grace run on, and where they wait for a loop turn. A child lives in
  // real time, so a held daemon is handed the real one here.
  readonly clock: Timekeeper;
}

// [LAW:one-source-of-truth] Everything one owner's launches read and leave
// behind. A launcher is this and the functions over it, so no two owners can
// see each other's limits, children or lifeline.
interface LaunchState {
  readonly scope: LaunchScope;
  // The OS this launcher's children live on.
  readonly spawner: Spawner;
  // Last-attempt timestamp per category: the data the rate-limit decision
  // reads. Recorded for every attempted spawn (success or spawn-error);
  // rate-limit rejections do NOT update this, because no spawn was attempted.
  readonly lastStartAt: Map<LaunchCategory, Monotonic>;
  // What ends each launch in flight, on the scope's abort.
  // [LAW:no-silent-failure] One listener, on a signal as long-lived as its
  // owner: `AbortSignal.any` over it grows the heap launch by launch on Node 20
  // and 24, and a listener per launch warns of a leak past ten in flight on 20
  // and 22.
  readonly inFlight: Set<() => void>;
  // [LAW:one-source-of-truth] The groups this launcher has in flight. The
  // lifeline mirrors the set, and a new lifeline is given the whole set, so a
  // lost one costs only the moments until the next launch replaces it.
  readonly liveGroups: Set<number>;
  // The lifeline's process and the write end of its pipe, which only this
  // process holds.
  lifeline: Lifeline | null;
  // [LAW:one-source-of-truth] Why the groups in flight are not guarded now:
  // what ended the last lifeline, or kept one from starting. Null while a
  // lifeline runs, or before one is needed. Its observer hears each change, and
  // the daemon shows it as a standing warning.
  fault: string | null;
  // What has not ended: each launch in flight and each lifeline.
  readonly ending: Set<Promise<unknown>>;
  // [LAW:no-silent-failure] Launches the OS would not let this launcher end,
  // while their children live: a result was delivered, and they still run.
  readonly unreaped: Map<SpawnedChild, LaunchCategory>;
  // [LAW:single-enforcer] Pipes that outlived their launch, while they stay
  // open: the one place that holds, bounds and meters them.
  readonly drains: Set<Readable | Writable>;
}

// [LAW:no-ambient-temporal-coupling] `ending` is the one record of whether what
// a launcher started has ended.
function track<T>(state: LaunchState, work: Promise<T>): Promise<T> {
  const entry = work.finally(() => state.ending.delete(entry));
  state.ending.add(entry);
  return entry;
}

// The one gate each launch form crosses: closed, aborted by its caller, or
// inside its category's interval, it answers the refusal and no child starts.
// Admitted, the attempt is on record. [LAW:nothing-unseen] A refusal is metered,
// so a launch that did nothing reads apart from one nobody tried.
function admit(
  state: LaunchState,
  category: LaunchCategory,
  signal?: AbortSignal,
): Refusal | null {
  const refusal = refusalOf(state, category, signal);
  if (refusal !== null) {
    state.scope.stats?.onRefused(category);
    return refusal;
  }
  state.lastStartAt.set(category, state.scope.clock.monotonic());
  return null;
}

function refusalOf(
  state: LaunchState,
  category: LaunchCategory,
  signal: AbortSignal | undefined,
): Refusal | null {
  if (state.scope.signal.aborted) return refusedAsAborted(state.scope.signal);
  if (signal?.aborted) return refusedAsAborted(signal);
  const gate = checkRateLimit(
    state.lastStartAt,
    category,
    state.scope.clock.monotonic(),
  );
  return gate.allowed
    ? null
    : rateLimitedResult(category, gate.minIntervalMs, gate.sinceLastMs);
}

// [LAW:types-are-the-program] Grace between SIGTERM and SIGKILL on the timeout
// path. The lifetime invariant ("waited — child reaped before the caller
// resumes") requires that a child which ignores SIGTERM is still gone before we
// resolve. SIGTERM lets well-behaved children flush/clean up; SIGKILL is the
// backstop so the promise cannot resolve while the child is still alive.
const TIMEOUT_KILL_GRACE_MS = 250;

// The OS has no event for a process group's end, so a launch whose child has
// ended samples for it.
const GROUP_END_POLL_MIN_MS = 25;
const GROUP_END_POLL_MAX_MS = 1000;

// --- the lifeline ---
//
// [LAW:types-are-the-program] "A waited child cannot outlive its frame" holds
// when the frame is the whole process. Everything else that ends a child runs
// inside the launcher, and a SIGKILL'd launcher runs nothing, so the end lives
// in a second process that learns of the death from the kernel: when a process
// ends, however it ends, the kernel closes its fds, and the lifeline reads EOF
// on the pipe the launcher held. It then signals every group still registered
// with the timeout's own escalation, SIGTERM and after the grace SIGKILL.
//
// `kill -TERM -<pgid>` is the one spelling every /bin/sh takes: dash rejects
// `kill -TERM -- -<pgid>`, and `kill -s TERM -<pgid>` fails in every one.
// [LAW:no-silent-failure] exception: kill's stderr goes nowhere, because a
// group that ended on its own (ESRCH) is the state this exists to reach, and
// the launcher it would report to is gone.
export const LIFELINE_PROGRAM =
  `$1 == "+" { live[$2] = 1; next } ` +
  `$1 == "-" { delete live[$2]; next } ` +
  `END { for (g in live) groups = groups " -" g; ` +
  `if (groups != "") system("kill -TERM" groups " 2>/dev/null; ` +
  `sleep ${TIMEOUT_KILL_GRACE_MS / 1000}; kill -KILL" groups " 2>/dev/null") }`;

// The lifeline's process and the write end of its pipe, which only this
// process holds.
interface Lifeline {
  readonly process: SpawnedChild;
  readonly pipe: Socket;
}

function setFault(state: LaunchState, next: string | null): void {
  if (next === state.fault) return;
  state.fault = next;
  state.scope.observeWarnings({ kind: "lifeline", fault: next });
}

function lose(state: LaunchState, line: SpawnedChild, reason: string): void {
  if (state.lifeline?.process !== line) return;
  state.lifeline = null;
  // `settled` waits on this end too.
  line.ref();
  setFault(state, reason);
}

// [LAW:no-silent-failure] What a pipe that outlived its launch met: a drain
// cut at the bound (its holder's writes fail from then on, often fatally), or
// a drain that failed to read. A held input's failed write is not one: its
// reader stopped reading, which `feed` already says is no fault.
type PipeEventKind = "cut" | "read-error";

const lifelineMessage = (fault: string): string =>
  `programs launched now would outlive their launcher if it died: its launch lifeline ${fault}, and the next launch starts another`;

// A function, not a table: the bound is declared further down this module.
const pipeEventWords = (kind: PipeEventKind): string =>
  kind === "cut"
    ? `output cut at the ${MAX_CAPTURED_BYTES}-byte bound, so the program holding it now fails its writes`
    : "output failed to read";

const PIPE_EVENT_LEAD = "a launched program's pipe outlived its launch: ";

// A pipe event is reported as it happens, and the launcher keeps none of it:
// its owner holds it while a bar can show it.
function pipeEvent(
  state: LaunchState,
  kind: PipeEventKind,
  category: LaunchCategory,
): void {
  state.scope.observeWarnings({
    kind: "launch-pipes",
    text: `${PIPE_EVENT_LEAD}${category} ${pipeEventWords(kind)}`,
  });
}

// What the launcher stands behind now: the lifeline's fault while it stands.
function standing(state: LaunchState): LifelineWarning | null {
  return state.fault === null
    ? null
    : { kind: "lifeline", message: lifelineMessage(state.fault) };
}

// Leads its own group, so nothing aimed at the launcher's group reaches it, and
// is unref'd with its pipe, so it holds a process open only once it is ending.
// `awk` is found
// on the launcher's PATH, as every launched program is: where a machine keeps
// it is the machine's fact (NixOS has no /usr/bin/awk).
function spawnLifeline(state: LaunchState): Lifeline | null {
  const { stats, clock } = state.scope;
  stats?.onStart("lifeline");
  const t0 = clock.monotonic();
  let line: SpawnedChild;
  try {
    line = state.spawner.spawn("awk", [LIFELINE_PROGRAM], {
      env: childEnv(state.scope, {}),
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
  } catch (err) {
    stats?.onEnd("lifeline", elapsedMs(clock, t0));
    setFault(state, `did not start: ${spawnErrorText(err, undefined)}`);
    return null;
  }
  stats?.onEnd("lifeline", elapsedMs(clock, t0));
  // stdio[0] is "pipe", so Node hands back a socket, unless descriptors ran out:
  // that spawn fails with no throw and no stdin, and only its "error" says why.
  const pipe = line.stdin as Socket | null;
  if (pipe === null || pipe === undefined) {
    line.once("error", (err) =>
      setFault(state, `did not start: ${err.message}`),
    );
    return null;
  }
  line.once("spawn", () => {
    if (state.lifeline?.process === line) setFault(state, null);
  });
  line.once("error", (err) => lose(state, line, `failed: ${err.message}`));
  line.once("exit", (code, sig) => lose(state, line, `exited ${sig ?? code}`));
  pipe.on("error", (err) => lose(state, line, `pipe failed: ${err.message}`));
  clock.detach("lifeline close", () =>
    track(state, new Promise((closed) => line.once("close", closed))),
  );
  line.unref();
  pipe.unref();
  for (const group of state.liveGroups) pipe.write(`+ ${group}\n`);
  return { process: line, pipe };
}

// A new lifeline is handed the whole set, this group included; the line after
// it is then a repeat the lifeline's set absorbs.
function guard(state: LaunchState, group: number): void {
  state.liveGroups.add(group);
  state.lifeline ??= spawnLifeline(state);
  state.lifeline?.pipe.write(`+ ${group}\n`);
}

function unguard(state: LaunchState, group: number): void {
  state.liveGroups.delete(group);
  state.lifeline?.pipe.write(`- ${group}\n`);
}

// A closed owner's lifeline goes with it: the EOF a dying launcher gives it, on
// purpose, so no fault is recorded. Nothing launches after the abort that runs
// this, so nothing starts another. It holds the loop from here: `settled` waits
// on its end, and an unref'd end never comes in a process with nothing else open.
function endLifeline(state: LaunchState): void {
  const line = state.lifeline;
  state.lifeline = null;
  line?.process.ref();
  line?.pipe.end();
}

// A termination the launcher itself initiated — carried as data because the
// OS reports only the signal, never why it was sent.
type Terminated = "timeout" | "aborted" | "output-limit" | "pipe-error";

// The most a waited launch keeps of each of its streams. A string cannot grow
// without end (V8 throws past ~512 MiB), and a child that writes without end
// (`cat /dev/zero`) would take the process with it; the bound is the launch's,
// not the caller's, so every waited launch is total.
export const MAX_CAPTURED_BYTES = 16 * 1024 * 1024;
const OUTPUT_LIMIT_ERROR = `output exceeded ${MAX_CAPTURED_BYTES} bytes`;
export const timedOutError = (timeoutMs: number): string =>
  `timed out after ${timeoutMs / 1000} s`;

// [LAW:single-enforcer] One reader per stream for the stream's whole life, and
// one count of its bytes against MAX_CAPTURED_BYTES. While the launch runs it
// decodes, keeping at most the bound and saying `full` past it, so the pipe
// still drains while the launch ends the child. An owned decoder, not
// setEncoding: a launch can end before EOF, and only this one can be flushed
// then, so a character cut short still shows as U+FFFD. `take`, at settle,
// flushes and releases the text; what the stream carries after it is read and
// dropped.
interface Captured {
  take(): string;
  // Hands a stream still open after settle to the launcher's drains.
  drain(): void;
}

// What ends a launch from its own streams: one passing the bound, or one
// failing to read.
interface CaptureEnds {
  full(): void;
  failed(err: Error): void;
}

function capture(
  state: LaunchState,
  category: LaunchCategory,
  stream: Readable | null,
  ends: CaptureEnds,
): Captured {
  const { stats } = state.scope;
  const decoder = new StringDecoder("utf8");
  let text = "";
  let bytes = 0;
  // What a drain reads after settle, against a bound of its own: a launch that
  // used its whole bound leaves a surviving descendant the same room as any.
  let dropped = 0;
  // Released at settle, so a drain holds nothing of the launch's result.
  let onEnd: CaptureEnds | null = ends;
  let end: DrainEnd = "closed";
  // [LAW:no-silent-failure] A pipe's read error, before settle or after, is
  // counted where it happens, never thrown into the launcher's loop. Before
  // settle it ends the launch, so its truncated capture is never an `ok` one;
  // after, it is a pipe event the bar shows.
  stream?.on("error", (err) => {
    stats?.onPipeError(category);
    if (onEnd === null) pipeEvent(state, "read-error", category);
    else onEnd.failed(err);
  });
  stream?.on("data", (chunk: Buffer) => {
    if (onEnd === null) {
      dropped += chunk.length;
      stats?.onDrainRead(category, chunk.length);
      if (dropped <= MAX_CAPTURED_BYTES) return;
      // [LAW:no-silent-failure] Past the bound after settle, the holder would
      // cost the launcher CPU for its whole life, and the launcher cannot end
      // it (it left the group, or refused the group's signal): its pipe is
      // cut, so its writes fail from here on, and the drain's close says so.
      end = "cut";
      stream.destroy();
      pipeEvent(state, "cut", category);
      return;
    }
    const room = Math.max(0, MAX_CAPTURED_BYTES - bytes);
    text += decoder.write(chunk.subarray(0, room));
    bytes += chunk.length;
    if (bytes > MAX_CAPTURED_BYTES) onEnd.full();
  });
  return {
    take: () => {
      if (onEnd === null) return "";
      onEnd = null;
      const whole = text + decoder.end();
      text = "";
      return whole;
    },
    // Whatever outlives the launch — a refused child, a descendant that left
    // the group — keeps its pipes: a destroyed one would kill it with SIGPIPE
    // at its next write. So the pipe stays open, unref'd, and is held and
    // metered in one place while it does.
    drain: () => {
      if (stream === null || stream.destroyed || stream.readableEnded) return;
      hold(state, category, stream, () => end);
    },
  };
}

// [LAW:single-enforcer] A pipe still open after settle, in either direction,
// is held, unref'd and metered here, and goes with a closed launcher. Its
// listeners hold the pipe and `end`, so `end` must be built outside the launch
// too, or the held pipe pins the launch's scope for its reader's life.
function hold(
  state: LaunchState,
  category: LaunchCategory,
  pipe: Readable | Writable,
  end: () => DrainEnd,
): void {
  const { stats } = state.scope;
  // Nothing reads a closed launcher's drains, so their fds go with it.
  if (state.scope.signal.aborted) {
    pipe.destroy();
    return;
  }
  pipe.once("close", () => {
    state.drains.delete(pipe);
    stats?.onDrainClose(category, end());
  });
  (pipe as Socket).unref();
  state.drains.add(pipe);
  stats?.onDrainOpen(category);
}

// An input is written, never cut, so it always ends "closed".
const inputEnd = (): DrainEnd => "closed";

// At module scope, so a held input's listener holds nothing of the launch.
function feed(input: Writable, text: string | Buffer | undefined): void {
  // [LAW:no-silent-failure] exception: a reader may stop reading and still
  // succeed (`head -1`), so its exit is the verdict, and the failed write says
  // nothing that exit does not.
  input.on("error", () => {});
  input.end(text);
}

// [LAW:one-type-per-behavior] What a waited launch does with its child's
// pipes, the one thing its two forms differ in: a launch captures its output
// and writes its stdin once; a channel relays its output as it comes and
// hands its stdin to the caller.
interface Pipes {
  readonly read: (
    state: LaunchState,
    category: LaunchCategory,
    stream: Readable | null,
    ends: CaptureEnds,
    which: "stdout" | "stderr",
  ) => Captured;
  readonly opened: (input: Writable | null, pid: number | null) => void;
}

const captured = (stdinInput: string | Buffer | undefined): Pipes => ({
  read: (state, category, stream, ends) =>
    capture(state, category, stream, ends),
  opened: (input) => {
    if (input !== null) feed(input, stdinInput);
  },
});

// [LAW:single-enforcer] A channel's stream, decoded as it comes and heard
// whole: nothing is kept, so nothing is bounded. A read error ends the launch
// as a captured stream's does.
function relay(
  state: LaunchState,
  category: LaunchCategory,
  stream: Readable | null,
  ends: CaptureEnds,
  heard: (text: string) => void,
): Captured {
  const decoder = new StringDecoder("utf8");
  stream?.on("error", (err) => {
    state.scope.stats?.onPipeError(category);
    ends.failed(err);
  });
  stream?.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text !== "") heard(text);
  });
  return {
    take: () => {
      const tail = decoder.end();
      if (tail !== "") heard(tail);
      return "";
    },
    drain: () => {
      if (stream === null || stream.destroyed || stream.readableEnded) return;
      hold(state, category, stream, () => "closed");
    },
  };
}

// A channel: a waited launch whose output is heard and whose stdin is the
// caller's to write and close.
function launchChannel(state: LaunchState, opts: ChannelOpts): Channel {
  let input: Writable | null = null;
  let pid: number | null = null;
  const ended = track(
    state,
    launchPiped(state, opts, {
      read: (s, category, stream, ends, which) =>
        relay(s, category, stream, ends, opts.heard[which]),
      opened: (opened, spawned) => {
        input = opened;
        pid = spawned;
        // [LAW:no-silent-failure] exception: a write to a child that has gone
        // fails here, and the child's end is the verdict `ended` reports.
        opened?.on("error", () => {});
      },
    }),
  );
  return {
    get pid() {
      return pid;
    },
    write: (text) => {
      if (input !== null && !input.writableEnded && !input.destroyed)
        input.write(text);
    },
    end: () => {
      input?.end();
    },
    ended,
  };
}

function launchWaited(
  state: LaunchState,
  opts: AsyncLaunchOpts,
): Promise<LaunchResult> {
  return launchPiped(state, opts, captured(opts.stdinInput));
}

async function launchPiped(
  state: LaunchState,
  opts: Omit<AsyncLaunchOpts, "stdinInput">,
  pipes: Pipes,
): Promise<LaunchResult> {
  const { stats, clock } = state.scope;
  const refused = admit(state, opts.category, opts.signal);
  if (refused !== null) return refused;
  const t0 = clock.monotonic();
  stats?.onStart(opts.category);

  return new Promise<LaunchResult>((resolve) => {
    const { spawner } = state;
    let child: SpawnedChild;
    try {
      child = spawner.spawn(opts.bin, opts.args ?? [], {
        cwd: opts.cwd,
        env: childEnv(state.scope, opts),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      stats?.onEnd(opts.category, elapsedMs(clock, t0));
      resolve({
        ok: false,
        reason: "spawn-error",
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        error: spawnErrorText(err, opts.cwd),
      });
      return;
    }
    // A child whose spawn failed asynchronously (ENOENT) has no pid, and no
    // group to guard: its `error` event settles it.
    const group = child.pid;
    if (group !== undefined) guard(state, group);
    const exited = new Promise((end) => child.once("exit", end));
    // Node destroys a child's stdin when the child itself exits, dropping input
    // a descendant still reads (`(cat > f) <&0 &`). The launch owns the pipe
    // instead, so it closes when its last reader does.
    const input = child.stdin;
    child.stdin = null;

    // The first stream to fail says why; a later one changes nothing.
    let pipeError: string | null = null;
    const ends: CaptureEnds = {
      full: () => terminate("output-limit"),
      failed: (err) => {
        pipeError ??= err.message;
        terminate("pipe-error");
      },
    };
    const stdout = pipes.read(
      state,
      opts.category,
      child.stdout,
      ends,
      "stdout",
    );
    const stderr = pipes.read(
      state,
      opts.category,
      child.stderr,
      ends,
      "stderr",
    );
    const output = () => ({ stdout: stdout.take(), stderr: stderr.take() });
    let settled = false;
    // What clears each timer the launch has armed.
    let timer: (() => void) | null = null;
    let killTimer: (() => void) | null = null;
    let groupEndTimer: (() => void) | null = null;
    // [LAW:dataflow-not-control-flow] Whether the close was caused by *our*
    // termination — and which — is data we have to carry. The OS doesn't tell
    // us why a child was signalled — without it, SIGKILL from the OOM killer,
    // SIGINT propagated through the tty, SIGPIPE on a closed pipe, etc. would
    // all be misreported as "timeout" or "aborted".
    let terminated: Terminated | null = null;

    const onAbort = () => terminate("aborted");
    const unlisten = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      state.inFlight.delete(onAbort);
    };

    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      timer?.();
      killTimer?.();
      groupEndTimer?.();
      unlisten();
      if (group !== undefined) unguard(state, group);
      stats?.onEnd(opts.category, elapsedMs(clock, t0));
      // The launch's scope goes once its child has exited: what still reads
      // the child's pipes then is a drain, which holds nothing of the launch.
      child.off("close", conclude);
      child.off("error", onError);
      stdout.drain();
      stderr.drain();
      // Input still being written at settle is held with the drains.
      if (input !== null && !input.destroyed && !input.writableFinished)
        hold(state, opts.category, input, inputEnd);
      deliver();
    };
    const settle = (r: LaunchResult) => finish(() => resolve(r));
    // [LAW:one-type-per-behavior] A group that cannot be signalled (EPERM:
    // the child changed its real uid) is this run's result like any other
    // failure — a `LaunchResult` arm, never a rejection or a throw out of a
    // timer callback, so the single-enforcer primitive stays total.
    // [LAW:one-source-of-truth] The launch's task names, each its category's,
    // so one launch's throws are one error per task on every bar.
    const tasks = {
      reap: `${opts.category} reap`,
      conclude: `${opts.category} launch conclude`,
      groupEnd: `${opts.category} group end poll`,
      killGrace: `${opts.category} kill grace`,
    };
    // A step that follows the child's exit, which `exited` only ever resolves.
    const afterExit = (task: string, then: () => void): void =>
      clock.detach(task, async () => {
        await exited;
        then();
      });
    const signal = (pid: number, sig: NodeJS.Signals) => {
      try {
        spawner.signalGroup(pid, sig);
      } catch (err) {
        state.unreaped.set(child, opts.category);
        afterExit(tasks.reap, () => state.unreaped.delete(child));
        settle({
          ok: false,
          reason: "signal-refused",
          ...output(),
          exitCode: null,
          signal: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // [LAW:no-ambient-temporal-coupling] Run a turn after an end is seen, once
    // what was written before it is read. It concludes on the child's exit.
    const concludeWithGroup = () => conclude(child.exitCode, child.signalCode);
    const concludeNextTurn = () =>
      clock.defer(tasks.conclude, concludeWithGroup);
    // While a member of the group lives the launch waits for it, guarded, so
    // SIGKILL still reaches it. The OS has no event for a group's end, so it is
    // polled, with exponential backoff.
    if (group !== undefined) {
      const awaitGroupEnd = (delayMs: number) => {
        if (settled) return;
        if (spawner.groupGone(group)) {
          concludeNextTurn();
          return;
        }
        groupEndTimer = clock.after(tasks.groupEnd, delayMs, () =>
          awaitGroupEnd(Math.min(delayMs * 2, GROUP_END_POLL_MAX_MS)),
        );
      };
      afterExit(tasks.groupEnd, () =>
        clock.defer(tasks.groupEnd, () => awaitGroupEnd(GROUP_END_POLL_MIN_MS)),
      );
    }

    // [LAW:types-are-the-program] Do NOT settle here. We signal and let
    // `conclude` resolve once the child is actually gone, so the promise
    // never resolves while the child is still alive. SIGTERM first; SIGKILL
    // after a grace period if the child ignores it. One termination per
    // child: the first cause stands, so a later trigger cannot rewrite it or
    // re-arm the escalation.
    //
    // [LAW:dataflow-not-control-flow] `child.pid` is undefined when the spawn
    // failed asynchronously (ENOENT) — there is no process to signal and the
    // `error` event settles that case. kill() on a pid-less child signals the
    // wrong target (verified: it can terminate the caller), so escalation is
    // gated on the pid actually existing.
    const terminate = (cause: Terminated) => {
      if (terminated !== null) return;
      // A group that ended between polls has nothing left to signal, and its id
      // may no longer be the launch's. It did not time out; an abort and an
      // overflow, which happened, still stand.
      const ended = child.exitCode !== null || child.signalCode !== null;
      if (ended && group !== undefined && spawner.groupGone(group)) {
        terminated = cause === "timeout" ? null : cause;
        concludeNextTurn();
        return;
      }
      terminated = cause;
      timer?.();
      unlisten();
      const pid = child.pid;
      if (pid !== undefined) {
        // Escalation armed first, so a refused SIGTERM's cleanup clears it.
        // Concluding here is not behind the group's end: a group holding an
        // unreaped zombie never reads as gone, and this is that launch's bound.
        killTimer = clock.after(tasks.killGrace, TIMEOUT_KILL_GRACE_MS, () => {
          signal(pid, "SIGKILL");
          afterExit(tasks.conclude, concludeNextTurn);
        });
        signal(pid, "SIGTERM");
      }
    };

    const onError = (err: Error) => {
      settle({
        ok: false,
        reason: "spawn-error",
        ...output(),
        exitCode: null,
        signal: null,
        error: spawnErrorText(err, opts.cwd),
      });
    };
    child.on("error", onError);

    const conclude = (code: number | null, signal: NodeJS.Signals | null) => {
      // [LAW:types-are-the-program] We resolve here, on the *actual* exit —
      // including the termination paths. Once `terminated` is set the cause
      // is known, whichever signal (SIGTERM or the escalated SIGKILL) finally
      // ended the child.
      if (terminated !== null) {
        settle({
          ok: false,
          reason: terminated,
          ...output(),
          exitCode: code,
          signal,
          // [LAW:one-source-of-truth] The launcher enforced the bound, so it
          // names it; callers never spell it from a constant of their own.
          ...(terminated === "timeout"
            ? { error: timedOutError(opts.timeoutMs ?? 0) }
            : terminated === "output-limit"
              ? { error: OUTPUT_LIMIT_ERROR }
              : terminated === "pipe-error"
                ? { error: `a pipe failed to read: ${pipeError}` }
                : {}),
        });
        return;
      }
      if (code === 0) {
        settle({ ok: true, ...output(), exitCode: code });
        return;
      }
      const reason: "signal" | "non-zero" = signal ? "signal" : "non-zero";
      settle({
        ok: false,
        reason,
        ...output(),
        exitCode: code,
        signal,
      });
    };

    child.on("close", conclude);

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = clock.after(
        `${opts.category} launch timeout`,
        opts.timeoutMs,
        () => terminate("timeout"),
      );
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    state.inFlight.add(onAbort);

    pipes.opened(input, group ?? null);
  });
}

// Sync variant. For callers that genuinely cannot be async — the spawn
// outcome must be settled before the function returns.
function launchBlocking(state: LaunchState, opts: LaunchOpts): LaunchResult {
  const { stats, clock } = state.scope;
  const refused = admit(state, opts.category);
  if (refused !== null) return refused;
  const t0 = clock.monotonic();
  stats?.onStart(opts.category);

  try {
    const result = state.spawner.spawnSync(opts.bin, opts.args ?? [], {
      cwd: opts.cwd,
      env: childEnv(state.scope, opts),
      input: opts.stdinInput,
      timeout:
        opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });

    stats?.onEnd(opts.category, elapsedMs(clock, t0));

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";

    // Node sets `error` for ETIMEDOUT and ENOENT; distinguish by code.
    // [LAW:no-silent-failure] exception: EPIPE and ECONNRESET (macOS, a peer
    // mid-close) are input the child left unread; its exit stays the verdict,
    // as in `launch`.
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (result.error && code !== "EPIPE" && code !== "ECONNRESET") {
      const reason: "timeout" | "spawn-error" =
        code === "ETIMEDOUT" ? "timeout" : "spawn-error";
      return {
        ok: false,
        reason,
        stdout,
        stderr,
        exitCode: null,
        signal: result.signal ?? null,
        error:
          reason === "timeout"
            ? timedOutError(opts.timeoutMs ?? 0)
            : spawnErrorText(result.error, opts.cwd),
      };
    }

    if (result.status === 0) {
      return { ok: true, stdout, stderr, exitCode: result.status };
    }

    // A real timeout returned above on ETIMEDOUT, so a signal here came from
    // somewhere else (OOM killer, ctrl-C through the tty group, etc.).
    const reason: "signal" | "non-zero" = result.signal ? "signal" : "non-zero";
    return {
      ok: false,
      reason,
      stdout,
      stderr,
      exitCode: result.status,
      signal: result.signal ?? null,
    };
  } catch (err) {
    stats?.onEnd(opts.category, elapsedMs(clock, t0));
    return {
      ok: false,
      reason: "spawn-error",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: spawnErrorText(err, opts.cwd),
    };
  }
}

// [LAW:single-enforcer] The one orphan operation: a detached, unref'd,
// fire-and-forget launch that deliberately outlives its caller. This is the
// only Node-side launch with that lifetime; everything else waits. It returns
// the typed spawn outcome synchronously (so a failed spawn surfaces as
// `ok: false` rather than a discarded Promise reporting success), and meters
// through the stats handle so orphan spawns still show up in daemon-stats.
function launchOrphan(state: LaunchState, opts: LaunchOpts): LaunchResult {
  const { stats, clock } = state.scope;
  const refused = admit(state, opts.category);
  if (refused !== null) return refused;
  const t0 = clock.monotonic();
  stats?.onStart(opts.category);
  const result = launchDetachedSyncInner(state, opts);
  stats?.onEnd(opts.category, elapsedMs(clock, t0));
  return result;
}

function launchDetachedSyncInner(
  state: LaunchState,
  opts: LaunchOpts,
): LaunchResult {
  let child;
  try {
    child = state.spawner.spawn(opts.bin, opts.args ?? [], {
      cwd: opts.cwd,
      env: childEnv(state.scope, opts),
      detached: true,
      stdio: "ignore",
    });
  } catch (err) {
    // spawn throws synchronously on some failure modes (invalid options,
    // EACCES on some platforms).
    return {
      ok: false,
      reason: "spawn-error",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: spawnErrorText(err, opts.cwd),
    };
  }
  // [LAW:no-silent-failure] spawn() with ENOENT (e.g. missing binary) does
  // *not* throw — it returns a child with pid=undefined that emits
  // 'error' asynchronously. Two things matter here:
  //   1. The 'error' must have a listener or Node crashes the process.
  //   2. The synchronous return must reflect that the spawn failed.
  // We attach a no-op listener and use the synchronously-observable absence
  // of a pid as the spawn-failure signal.
  child.once("error", () => {});
  if (child.pid === undefined) {
    return {
      ok: false,
      reason: "spawn-error",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: `spawn(${opts.bin}): no pid (binary not found or unexecutable)`,
    };
  }
  child.unref();
  return { ok: true, stdout: "", stderr: "", exitCode: null };
}

const formatJobEnd = (end: JobEnd): string =>
  end.kind === "exit" ? `exit ${end.code}` : "timeout";

// The positional args are `<stdout> <stderr> <status> <program> <args…>`, so
// nothing about the program is composed into the script.
const JOB_SCRIPT =
  `out=$1 err=$2 status=$3; shift 3; ` +
  `read go || exit 0; ` +
  `"$@" >"$out" 2>"$err" </dev/null; ` +
  `echo "exit $?" >"$status.$$" && ln "$status.$$" "$status"; ` +
  `rm -f "$status.$$"`;

// [LAW:single-enforcer] The one launch with the job's lifetime. Detached, so
// it leads its own group, which nothing aimed at the launcher reaches; never
// guarded by the lifeline; unref'd, so it never holds the launcher open.
function launchJob(
  state: LaunchState,
  opts: LaunchOpts,
  files: JobFiles,
): JobLaunch {
  const { stats, clock } = state.scope;
  const refused = admit(state, opts.category);
  if (refused !== null)
    return { ok: false, reason: refused.reason, error: refused.error };
  const t0 = clock.monotonic();
  stats?.onStart(opts.category);
  let child: SpawnedChild;
  try {
    child = state.spawner.spawn(
      "/bin/sh",
      [
        "-c",
        JOB_SCRIPT,
        "sh",
        files.stdout,
        files.stderr,
        files.status,
        opts.bin,
        ...(opts.args ?? []),
      ],
      {
        cwd: opts.cwd,
        env: childEnv(state.scope, opts),
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
  } catch (err) {
    stats?.onEnd(opts.category, elapsedMs(clock, t0));
    return {
      ok: false,
      reason: "spawn-error",
      error: spawnErrorText(err, opts.cwd),
    };
  }
  stats?.onEnd(opts.category, elapsedMs(clock, t0));
  // An async spawn failure has no pid; its `error` needs a listener or Node
  // crashes the launcher, and the missing pid already says it failed.
  child.once("error", () => {});
  const pid = child.pid;
  const gate = child.stdin as Socket;
  // [LAW:no-silent-failure] exception: a write to a sh that already died
  // fails EPIPE, and that death is said where every reader looks, in the job's
  // missing verdict, which reads as lost.
  gate.on("error", () => {});
  if (pid === undefined) {
    gate.destroy();
    return {
      ok: false,
      reason: "spawn-error",
      error: `spawn(/bin/sh): no pid (shell not found or unexecutable)`,
    };
  }
  child.unref();
  gate.unref();
  return {
    ok: true,
    pid,
    release: () => gate.end("go\n"),
    withdraw: () => gate.end(),
  };
}

// The job's verdict, or null while it has none. [LAW:no-silent-failure] A
// status this module did not write is an error, never an end.
export function readJobEnd(status: string): JobEnd | null {
  let text: string;
  try {
    text = readFileSync(status, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const exit = /^exit (\d+)$/.exec(text);
  if (exit) return { kind: "exit", code: Number(exit[1]) };
  if (text === "timeout") return { kind: "timeout" };
  throw new Error(`${status}: not a job verdict: ${JSON.stringify(text)}`);
}

// Ends a job's group with the timeout's own escalation, and gives it a verdict
// of the launcher's unless its own landed first: the first verdict stands, and
// a group that outlives its verdict (a child the program left) is ended all the
// same. [LAW:single-enforcer] The caller proves the group the job's; the files
// prove nothing about it. A status whose directory is gone takes no verdict, and
// its group is ended all the same: whoever removed the files did not end the
// group with them. The verdict lands before the signal, so the job's own exit
// on SIGTERM never takes the place of the launcher's; a verdict that cannot be
// written is thrown [LAW:no-silent-failure] once the group has been signalled.
function endJob(
  spawner: Spawner,
  clock: Pick<Timekeeper, "after">,
  pid: number,
  status: string,
  end: JobEnd,
): JobEnding {
  const signal = (): boolean => {
    const signalled = spawner.signalJob(pid, "SIGTERM");
    if (signalled) {
      clock.after(
        `job kill grace ${pid}`,
        TIMEOUT_KILL_GRACE_MS,
        () => spawner.signalJob(pid, "SIGKILL"),
        {
          unref: true,
        },
      );
    }
    return signalled;
  };
  let landed: Pick<JobEnding, "verdict" | "leftover">;
  try {
    landed = landVerdict(status, end);
  } catch (err) {
    signal();
    throw err;
  }
  return { ...landed, signalled: signal() };
}

// Whose verdict the status holds once the launcher's is offered: the first one
// written stands, since it is published by link. [LAW:one-source-of-truth] The
// verdict is staged beside the status, so ENOENT from either step is the
// directory gone, which takes no verdict.
function landVerdict(
  status: string,
  end: JobEnd,
): Pick<JobEnding, "verdict" | "leftover"> {
  try {
    const { outcome, leftover } = publishByLink(
      status,
      `${formatJobEnd(end)}\n`,
    );
    return { verdict: outcome, leftover };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { verdict: "gone", leftover: null };
    throw err;
  }
}

// [LAW:types-are-the-program] The launch that holds its caller's loop until the
// child's pipes close, so a detached descendant holding them holds the loop.
// Only a process holding no loop that anyone waits on takes it: install, the
// the daemon's tmux restore once serving has stopped. A
// daemon's launcher has no such property at all. The process's launcher is
// this one-shot launcher under a narrower type, so its owners are held to
// `Launcher` by the type and the lint rule, not by the object's shape.
export interface OneShotLauncher extends Launcher {
  launchSync(opts: LaunchOpts): LaunchResult;
}

export interface Settled {
  // Launches the OS refused to end, whose children still run.
  readonly unreaped: readonly LaunchCategory[];
}

// What `createLauncher` returns, and not what a launcher is handed around as, so
// nothing holding a `Launcher` can reach this.
export interface TestableLauncher extends Launcher {
  // Settles once every waited launch and lifeline has ended: for the owner
  // that holds the abort, since a lifeline ends only with it.
  settled(): Promise<Settled>;
  // Exposed for tests only: ends the lifeline's pipe — the EOF the launcher's
  // death gives it — and names its pid. A cut lifeline is lost at once, so the
  // test's next launch starts another rather than writing to a closed pipe.
  __lifelineForTest(): { pid: number | undefined; cut(): void };
}

// What an owner hands its launcher: the environment its children inherit, and
// any of the rest of its scope. Nothing here is read from the process, so a
// launcher a process main builds (bar-pane, the CLI, the daemon's shell before it
// has a daemon) and the daemon's own differ only in what they are given.
export type LaunchOwner = Pick<LaunchScope, "inherited"> &
  Partial<Omit<LaunchScope, "inherited" | "clock">>;

// [LAW:no-ambient-temporal-coupling] An aborted scope ends what is in flight
// and refuses what comes after, for good, whichever other launchers run.
// [LAW:one-type-per-behavior] The daemon's launcher has no blocking form at
// all, so no cast or `in` check reaches one.
export function createLauncher(
  owner: LaunchOwner,
  clock: Timekeeper,
  spawner: Spawner,
): TestableLauncher {
  return launcherWithState(owner, clock, spawner).launcher;
}

// The same launcher, with its blocking form added: for the process's one-shot
// launcher and the tests of that form.
export function createOneShotLauncher(
  owner: LaunchOwner,
  clock: Timekeeper,
  spawner: Spawner,
): TestableLauncher & OneShotLauncher {
  const { launcher, state } = launcherWithState(owner, clock, spawner);
  return { ...launcher, launchSync: (opts) => launchBlocking(state, opts) };
}

function launcherWithState(
  owner: LaunchOwner,
  clock: Timekeeper,
  spawner: Spawner,
): {
  launcher: TestableLauncher;
  state: LaunchState;
} {
  const launcher: TestableLauncher = {
    clock,
    launch: (opts) => track(state, launchWaited(state, opts)),
    launchChannel: (opts) => launchChannel(state, opts),
    launchDetachedSync: (opts) => launchOrphan(state, opts),
    launchJobSync: (opts, files) => launchJob(state, opts, files),
    jobGroupAlive: (pid) => spawner.signalJob(pid, 0),
    endJob: (pid, status, end) => endJob(spawner, clock, pid, status, end),
    standing: () => standing(state),
    settled: async () => {
      await Promise.all(state.ending);
      return { unreaped: [...state.unreaped.values()] };
    },
    __lifelineForTest: () => {
      const line = state.lifeline;
      return {
        pid: line?.process.pid,
        cut: () => {
          line?.pipe.end();
          if (line) lose(state, line.process, "cut by a test");
        },
      };
    },
  };
  const state: LaunchState = {
    spawner,
    scope: {
      stats: null,
      // A launcher with nobody to tell says the warning on stderr.
      observeWarnings: (change) => {
        const message =
          change.kind === "launch-pipes"
            ? change.text
            : change.fault === null
              ? null
              : lifelineMessage(change.fault);
        if (message !== null) process.emitWarning(message);
      },
      signal: new AbortController().signal,
      ...owner,
      clock,
    },
    lastStartAt: new Map(),
    inFlight: new Set(),
    liveGroups: new Set(),
    lifeline: null,
    fault: null,
    ending: new Set(),
    unreaped: new Map(),
    drains: new Set(),
  };
  state.scope.signal.addEventListener(
    "abort",
    () => {
      state.inFlight.forEach((end) => end());
      // Nothing reads a closed launcher's drains, so their fds go with it.
      state.drains.forEach((pipe) => pipe.destroy());
      endLifeline(state);
    },
    { once: true },
  );
  return { launcher, state };
}
