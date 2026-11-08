// The update notice: something newer exists than the code rendering the bar,
// and here is what to do about it (brandon-build-notice-5d6). Two facts feed
// it — a source checkout whose `src/` digest no longer matches the bundle
// (src/daemon/build-currency.ts) and a published install behind the
// registry's latest release (src/install/currency.ts) — and they are ONE
// statement to the reader: what is newer, what is running, and three clicks:
// act (rebuild / upgrade), dismiss (this session, this identity), disable
// (the config file, durably).
//
// [LAW:one-type-per-behavior] Both facts render through one `Update` and one
// sentence shape; what differs is a table of words and a command. The old
// design gave the checkout its own vocabulary ("stale build: dist/index.mjs
// <date> < src/x.ts <date>", a hint naming `just deploy`) that the user read
// as a puzzle — the ticket's verbatim verdict.
//
// [LAW:effects-at-boundaries] `updateReading` / `updateNotice` are pure:
// (currency samples) → the update's reading, and (update, act state, session
// context) → diagnostic channels. The watch below is the edge: the clocks, the
// registry fetch, the act's record, the validator registrations.

import type { RendererAddress } from "./home.js";
import {
  effectsUrl,
  VERB_APPLY_UPDATE,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
} from "../click/wire";
import {
  assessCurrency,
  fetchLatestVersion,
  formatVersion,
  PACKAGE_NAME,
  type Currency,
  type Version,
} from "../install/currency";
import type { LaunchOpts, Launcher } from "../proc/launch";
import {
  diagnosticSpan,
  UPDATE_SEVERITY,
  type DiagnosticLine,
  type DiagnosticMessage,
} from "../render/diagnostics";
import { shortDigest } from "../source-digest";
import { PACKAGE_VERSION } from "../version";
import {
  assessBuild,
  bundleStamp,
  type BuildCurrency,
  type SourceStamp,
} from "./build-currency";
import {
  claimAct,
  endOverdue,
  IDLE,
  judgeAct,
  leaveGroup,
  makeActReader,
  makeLeftReader,
  spendLook,
  type ActAwake,
  type ActFacts,
  type ActJob,
  type ActState,
  type LeftGroup,
} from "./update-act";
import type { ProcessProbe } from "./process-fingerprint";
import { runInAction } from "mobx";
import { restamp } from "../facts/fact";
import type { UpdateFact } from "./update-fact";
import { instantAt } from "../utils/instant";
import {
  ABSENT,
  failed,
  ok,
  pendingOf,
  type Reading,
  type Sampled,
} from "../utils/outcome";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue";
import { changeLogger, type LogLevel } from "../utils/logger";
import { BadVerbArgs, DaemonClosing } from "./verb-error";
import type { Gates } from "./foundations/gates";
import {
  UPDATE_DISMISSED_KEY,
  UPDATE_NOTICE_FIELD,
  UPDATE_NOTICE_SESSION_KEY,
} from "./update-keys";
import type { Timekeeper } from "../time.js";

// [LAW:types-are-the-program] What is newer than the running code. `source`
// is a checkout whose tree no longer matches the bundle; `release` is an
// install behind the registry. Each carries both sides of the comparison
// under one name pair, so the sentence reads the same fields off either.
export type Update =
  | {
      readonly kind: "source";
      readonly root: string;
      readonly newer: SourceStamp;
      readonly running: SourceStamp;
    }
  | {
      readonly kind: "release";
      readonly newer: Version;
      readonly running: Version;
    };

// What a dismissal names: the newer thing's identity, so a dismissal lapses
// the moment something newer again appears — the digest for source (the
// version alone would miss every uncommitted edit), the version for a release.
export function updateIdentity(update: Update): string {
  return update.kind === "source"
    ? update.newer.digest
    : formatVersion(update.newer);
}

// How a stamp reads to a person: the version it reports and the short digest
// that tells two builds of one version apart.
export const describeStamp = (s: SourceStamp): string =>
  `${s.version} [${shortDigest(s.digest)}]`;

// [LAW:dataflow-not-control-flow] The words and the command, as one table
// the notice and the act both read. Nothing downstream asks which kind it is.
interface UpdateFacts {
  readonly headline: string;
  readonly newer: string;
  readonly running: string;
  readonly act: string;
  readonly busy: string;
  readonly command: Pick<LaunchOpts, "bin" | "args" | "cwd">;
}

export function factsOf(update: Update): UpdateFacts {
  switch (update.kind) {
    case "source":
      return {
        headline: "Newer source",
        newer: describeStamp(update.newer),
        running: describeStamp(update.running),
        act: "rebuild",
        busy: "rebuilding…",
        command: { bin: "pnpm", args: ["build"], cwd: update.root },
      };
    case "release":
      return {
        headline: "Newer release",
        newer: formatVersion(update.newer),
        running: formatVersion(update.running),
        act: "upgrade",
        busy: "upgrading…",
        command: {
          bin: "pnpm",
          args: [
            "dlx",
            `${PACKAGE_NAME}@${formatVersion(update.newer)}`,
            "install",
          ],
        },
      };
  }
}

// The per-session facts the notice reads: whose clicks these are, what this
// session dismissed (the identity it wrote, or nothing), and whether the
// session's config allows the notice at all (Globals.updateNotice).
export interface NoticeContext {
  // The renderer the notice's clicks are addressed to.
  readonly to: RendererAddress;
  readonly sessionId: string;
  readonly dismissed: string | null;
  readonly enabled: boolean;
}

// [LAW:dataflow-not-control-flow] One update becomes zero or one channel —
// the list IS the answer, so the diagnostics fold it beside the errors and
// warnings with no "is there a notice" branch. Line one is the
// sentence and the three affordances; a failed act adds a second line naming
// the failure, and while the act runs its affordance is a busy label.
export function updateNotice(
  update: Update | null,
  act: ActState,
  ctx: NoticeContext,
): DiagnosticMessage[] {
  if (update === null) return [];
  const identity = updateIdentity(update);
  if (!ctx.enabled || ctx.dismissed === identity) return [];
  const facts = factsOf(update);
  const sentence = `${facts.headline}: ${facts.newer}. You're on ${facts.running}.`;
  const failure =
    act.kind === "failed" && act.identity === identity
      ? [`${facts.act} failed: ${act.reason}`]
      : [];
  const message = [sentence, ...failure].join("\n");
  // The sentence is plain text (the viewer's ⧉ copies it); the affordances
  // each carry their own effect.
  const actSpan =
    act.kind === "running"
      ? diagnosticSpan(`[${facts.busy}]`, null)
      : diagnosticSpan(
          `[${facts.act}]`,
          effectsUrl(ctx.to, [
            { verb: VERB_APPLY_UPDATE, args: [ctx.sessionId] },
          ]),
        );
  const first: DiagnosticLine = [
    diagnosticSpan(sentence, null),
    actSpan,
    diagnosticSpan(
      "[dismiss]",
      effectsUrl(ctx.to, [
        {
          verb: VERB_SET_STATE,
          args: [ctx.sessionId, UPDATE_DISMISSED_KEY, identity],
        },
      ]),
    ),
    diagnosticSpan(
      "[disable]",
      effectsUrl(ctx.to, [
        {
          verb: VERB_SET_CONFIG,
          args: [ctx.sessionId, UPDATE_NOTICE_FIELD, "false"],
        },
        {
          verb: VERB_SET_STATE,
          args: [ctx.sessionId, UPDATE_NOTICE_SESSION_KEY, "false"],
        },
      ]),
    ),
  ];
  const rest = failure.map((f): DiagnosticLine => [diagnosticSpan(f, null)]);
  return [
    {
      severity: UPDATE_SEVERITY,
      about: `update\0${identity}`,
      message,
      copy: message,
      lines: [first, ...rest],
    },
  ];
}

// [LAW:dataflow-not-control-flow] The two currency samples folded into the one
// reading of "is something newer": a checkout answers with its build; the
// release check only means something for a published install (a checkout's
// package.json version is whatever `main` says, not what is running), so the
// release is consulted only under the not-source-checkout arm — that
// discriminator is the domain's own. A sample not taken yet is pending, one
// that could not be assessed is a failed read, and nothing newer is absent.
export function updateReading(
  build: Sampled<BuildCurrency>,
  release: Sampled<Currency>,
): Reading<Update> {
  if (build.kind === "pending") return build;
  const b = build.value;
  switch (b.kind) {
    case "stale":
      return ok({
        kind: "source",
        root: b.root,
        newer: b.source,
        running: b.running,
      });
    case "current":
      return ABSENT;
    case "unchecked":
      return failed(`build: unchecked: ${b.reason}`, "read");
    case "not-source-checkout":
      return releaseReading(release);
  }
}

function releaseReading(release: Sampled<Currency>): Reading<Update> {
  if (release.kind === "pending") return release;
  const c = release.value;
  switch (c.kind) {
    case "stale":
      return ok({ kind: "release", newer: c.latest, running: c.installed });
    case "current":
    case "ahead":
      return ABSENT;
    case "unchecked":
      return failed(`release: unchecked: ${c.reason}`, "read");
  }
}

export interface UpdateWatchOptions {
  // The fact the watch publishes each sample into.
  readonly fact: UpdateFact;
  // The daemon's clock: the act's looks and the watch's timers run on it.
  readonly clock: Timekeeper;
  // Who the act's job belongs to.
  readonly launcher: Launcher;
  // Where a job's leader start time is read.
  readonly probe: Pick<ProcessProbe, "startTime">;
  // The daemon's `import.meta.url` — the bundle whose checkout is assessed.
  readonly entryUrl: string;
  // The digest that bundle was stamped with, which the checkout is assessed
  // against.
  readonly digest: string | null;
  // Where this bundle's acts are recorded (src/daemon/update-act.ts).
  readonly actsDir: string;
  // How often the source tree is re-digested.
  readonly intervalMs: number;
  // How often the registry is asked for `latest` (published installs only).
  readonly releaseIntervalMs: number;
  readonly registryUrl: string;
  readonly fetchImpl: typeof fetch;
  // The gates whose dismiss key follows the notice's identity.
  readonly gates: Gates;
  // Runs after a successful act: the bundle on disk has changed, and the
  // binary watch should notice now rather than at its next tick. Called in a
  // turn of the act queue and not awaited, since what it starts may wait on
  // that queue: a rejection is its own to log.
  readonly onApplied: () => void;
  readonly log: (level: LogLevel, msg: string) => void;
}

// One ⚠ message of the watch's, named by what it is about, never its text, so
// a viewer open on it stays on it as its words move.
export interface WatchError {
  readonly about: string;
  readonly text: string;
}

export interface UpdateWatch {
  arm(): void;
  close(): void;
  notice(ctx: NoticeContext): DiagnosticMessage[];
  // The apply-update verb's effect. Rejects with BadVerbArgs when there is
  // nothing to apply or an act is already running on this bundle, and with
  // DaemonClosing when the daemon closed before the claim stood.
  act(): Promise<void>;
  // Whether an act may be rewriting this bundle now, whichever daemon started
  // it. False while its files can't be read: the error says so, and holding
  // every restart on a file nothing repairs would hold them for good.
  running(): Promise<boolean>;
  // What the ⚠ shows of this bundle's acts, each message its own: why the act
  // files can't be read or take a look, why the act last read was ended with
  // no verdict to say so, and each group an end left running.
  errors(): readonly WatchError[];
}

// A build or an install is a long child; ten minutes of being watched running
// is generous for either and bounds a wedged one.
const ACT_TIMEOUT_MS = 10 * 60 * 1000;
// How often the act's record is looked at for an end: the notice's busy label
// and the restart after a success trail an end by at most this.
const ACT_POLL_MS = 2_000;
// The longest span one look spends of the budget. A look trails the one before
// it by the poll and the turn it waited behind; a gap many polls long is a
// machine that was not running the loop, and spends nothing, however many dark
// wakes a sleep has.
const LONGEST_LOOK_MS = 5 * ACT_POLL_MS;

// [LAW:one-source-of-truth] The one spelling of an overdue act whose files
// went before its end, for every way its group stood.
const goneEnd = (act: number, pid: number): string =>
  `apply-update: act ${act} timed out, and its files were removed before it could be ended; its group (pid ${pid})`;

// [LAW:one-source-of-truth] The one spelling of what an end did to the
// group, for the log and the ⚠ alike.
const signalOf = (signalled: boolean): string =>
  signalled ? "ending it" : "its group took no signal";

// What an end of a group proven the job's by its leader logs.
const provenEnd = (act: number, pid: number, signalled: boolean): string =>
  `${goneEnd(act, pid)} is led by the job's own process; ${signalOf(signalled)}`;

// What the log and every daemon's ⚠ say of a group an end left running, with
// the one act that clears it.
const leftReason = ({ act, pid }: LeftGroup): string =>
  `${goneEnd(act, pid)} has no leader whose start time proves it the job's, so it was not signalled; if it is still the update, end it with \`kill -TERM -${pid}\``;

function describeBuild(b: BuildCurrency): [LogLevel, string] {
  switch (b.kind) {
    case "current":
      return ["info", `build: current ${describeStamp(b.stamp)}`];
    case "stale":
      return [
        "info",
        `build: stale — source ${describeStamp(b.source)}, running ${describeStamp(b.running)}`,
      ];
    case "not-source-checkout":
      return ["info", "build: not a source checkout"];
    case "unchecked":
      return ["warn", `build: unchecked: ${b.reason}`];
  }
}

function describeRelease(c: Currency): [LogLevel, string] {
  switch (c.kind) {
    case "current":
      return ["info", `release: current ${formatVersion(c.installed)}`];
    case "stale":
      return [
        "info",
        `release: stale — latest ${formatVersion(c.latest)}, running ${formatVersion(c.installed)}`,
      ];
    case "ahead":
      return [
        "info",
        `release: ahead — running ${formatVersion(c.installed)}, latest ${formatVersion(c.latest)}`,
      ];
    case "unchecked":
      return ["warn", `release: unchecked: ${c.reason}`];
  }
}

// [LAW:single-enforcer] The daemon's one owner of "what is newer than me":
// it samples the build on a clock, polls the registry on a slower one when
// the layout is a published install, starts and watches the act, and owns the two
// click gates — the dismiss allow-list (re-registered to the current
// identity whenever it changes, so a stale dismissal simply stops matching)
// and the dismiss allow-list's identity. The disable allow-list is in the
// gates themselves (`daemonGates`), where a daemon is built with them.
export function makeUpdateWatch(opts: UpdateWatchOptions): UpdateWatch {
  const {
    fact,
    clock,
    launcher,
    probe,
    entryUrl,
    digest,
    actsDir,
    intervalMs,
    releaseIntervalMs,
    registryUrl,
    fetchImpl,
    gates,
    onApplied,
    log,
  } = opts;
  // [LAW:no-ambient-temporal-coupling] Before a sample is taken it is pending,
  // not a build or a release that failed — a notice asked for before arm()
  // renders nothing.
  let build: Sampled<BuildCurrency> = pendingOf("unread");
  let release: Sampled<Currency> = pendingOf("unread");
  // [LAW:single-enforcer] A `ps` the close aborted says nothing about the job,
  // so no caller gets to judge it.
  const readStart = async (pid: number) => {
    const read = await probe.startTime(pid);
    if (closed) throw new DaemonClosing("apply-update");
    return read;
  };
  const acts = makeActReader(actsDir, readStart, launcher, clock);
  // [LAW:one-source-of-truth] The act as last read, for the notice's render
  // and for noticing an end; null until the first read. Every decision — a
  // second click, a restart's hold — reads the record afresh instead, since a
  // read a tick old can say "idle" after a build has cleared the bundle.
  let seen: ActState | null = null;
  let gate: { readonly identity: string; readonly dispose: () => void } | null =
    null;
  const logBuild = changeLogger(log);
  const logRelease = changeLogger(log);

  // [LAW:no-ambient-temporal-coupling][LAW:single-enforcer] The one owner of
  // the act files: every read and claim is a turn here, so `known` has one
  // writer, a claim holds its gated job across its `ps`, and a tick runs wholly
  // before or after an act(), never judging a read older than `seen`.
  const actQueue = new KeyedSerialQueue<"acts">();
  const actTurn = <T>(body: () => Promise<T>): Promise<T> =>
    actQueue.run("acts", body);

  // [LAW:no-ambient-temporal-coupling] A closed watch knows of no update, so a
  // release poll landing after the close registers no gate, and a turn that
  // reads this after its await judges nothing: the launches abort first, so
  // what a closing daemon's `ps` answered says nothing.
  let closed = false;
  const armed: Array<() => void> = [];
  const every = (run: () => void, ms: number): void => {
    armed.push(clock.every(ms, run, { unref: true }));
  };

  // The update as the fact says it, so the notice, the gate and the apply verb
  // read the one fold every session's document carries.
  const current = (): Update | null => {
    const held = fact.get();
    return held.kind === "ok" ? held.value : null;
  };

  // The dismiss gate follows the identity: dispose the old allow-list, register
  // the new one, none when nothing is newer.
  function syncGate(): void {
    const update = current();
    const identity = update === null ? null : updateIdentity(update);
    if ((gate === null ? null : gate.identity) === identity) return;
    gate?.dispose();
    gate =
      identity === null
        ? null
        : {
            identity,
            dispose: gates.state.register(UPDATE_DISMISSED_KEY, [identity]),
          };
  }

  // [LAW:single-enforcer] The one writer of the fact: what the samples say now,
  // stamped at this turn, and the gate that follows the fact's identity. A
  // closed watch knows of no update, so a poll landing after the close
  // publishes that.
  function publish(): void {
    const reading = closed ? ABSENT : updateReading(build, release);
    const next = restamp(fact.get(), reading, instantAt(clock));
    runInAction(() => fact.set(next));
    syncGate();
  }

  function sampleBuild(): BuildCurrency {
    const sampled = assessBuild(entryUrl, () => bundleStamp(digest));
    build = ok(sampled);
    logBuild(describeBuild(sampled));
    publish();
    return sampled;
  }

  async function pollRelease(): Promise<void> {
    const latest = await fetchLatestVersion(
      PACKAGE_NAME,
      fetchImpl,
      registryUrl,
      clock,
    );
    const assessed = assessCurrency(PACKAGE_VERSION, latest);
    release = ok(assessed);
    logRelease(describeRelease(assessed));
    publish();
  }

  // [LAW:single-enforcer] The one edge every touch of the act files passes
  // through. [LAW:no-silent-failure] Files that can't be read or written are
  // an error the indicator shows, never a throw out of a timer: that would end
  // this daemon, and each one after it on this bundle at its first look.
  type ActsTouch<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: string };
  let unreadable: string | null = null;
  const logUnreadable = changeLogger(log);
  // The one spelling of the ⚠ text an act-file fault shows.
  const actsFault = (why: string): string =>
    `update act files (${actsDir}): ${why}`;
  async function touchActs<T>(touch: () => Promise<T>): Promise<ActsTouch<T>> {
    try {
      const value = await touch();
      unreadable = null;
      return { ok: true, value };
    } catch (err) {
      if (err instanceof DaemonClosing) {
        return { ok: false, error: err.message };
      }
      unreadable = actsFault((err as Error).message);
      logUnreadable(["error", unreadable]);
      return { ok: false, error: unreadable };
    }
  }

  // This daemon's last look at the act, of the job its reader said it was of.
  // While the act's files can't take a look, this copy is what carries the
  // spend, so the bound is ten minutes of one daemon's watching: the spend
  // crosses no daemon, and one started mid-act (only a crash or a kill starts
  // one, since a restart for a changed bundle waits on the act) counts from the
  // last spend the files hold, and shows the same fault.
  let lastLook: { readonly job: ActJob; readonly awake: ActAwake } | null =
    null;
  // [LAW:no-silent-failure] Why the watch ended an act whose verdict it could
  // not write. Readers judge that act lost, and the touch that next succeeds
  // clears the fault that said why, so the reason is kept while the act last
  // read is that job. Keyed by job, not act number: a number is taken again
  // once the acts directory is emptied.
  let unrecorded: { readonly job: ActJob; readonly reason: string } | null =
    null;
  // [LAW:one-source-of-truth] Why the act's files could not take the watch's
  // last look at the spend. Its own, not `unreadable`: only a look can say
  // whether the spend file took one, and a read that succeeds says nothing of
  // it, so a read between ticks must not clear it.
  let spendFault: string | null = null;
  const logSpendFault = changeLogger(log);
  // [LAW:one-source-of-truth] The groups an end left running, as last read
  // from the acts directory, which every daemon on the bundle reads.
  let left: readonly LeftGroup[] = [];
  // Groups this daemon left that the directory has not taken yet: shown, and
  // written again each tick, so a write that fails loses no group. A copy the
  // directory outranks once it holds the group.
  let unwritten: readonly LeftGroup[] = [];
  // [LAW:one-source-of-truth] Why left groups could not be written or read.
  // Its own, not `unreadable`: the act's own read stands whatever `left/`
  // holds, and a read of the act alone must not clear it.
  let leftFault: string | null = null;
  const logLeftFault = changeLogger(log);
  const lefts = makeLeftReader(actsDir, readStart, launcher, clock);

  // Spends a look on the act if its group is alive, and ends it once that has
  // spent its budget, with a timeout verdict unless the job's own landed first.
  // [LAW:one-source-of-truth] The one budget is observed time, shared through
  // the act's files by every daemon that looks.
  // Returns why the act's files could not take the look, null when they did
  // or no look was spent; the spend is judged first, so a write that fails
  // ends nothing early.
  async function endIfOverdue(facts: ActFacts | null): Promise<string | null> {
    if (!facts?.alive) return null;
    const own = lastLook?.job === facts.job ? lastLook.awake : null;
    const look = spendLook(actsDir, facts, own, clock.now(), LONGEST_LOOK_MS);
    if (look === null) return null;
    lastLook = { job: facts.job, awake: look.awake };
    if (look.awake.spentMs > ACT_TIMEOUT_MS) await endAct(facts);
    return look.fault === null ? null : actsFault(look.fault);
  }

  async function endAct(facts: ActFacts): Promise<void> {
    const ending = await endOverdue(
      actsDir,
      facts,
      readStart,
      launcher,
      clock.bootTime(),
    );
    const { pid } = facts.record;
    // The act's files went between the look and its end: a newer claim pruned
    // it, or the state directory was removed.
    if (ending.verdict === "gone") {
      switch (ending.proof) {
        case "fingerprinted":
          log("error", provenEnd(facts.act, pid, ending.signalled));
          return;
        case "absent":
          log("info", `${goneEnd(facts.act, pid)} had already ended`);
          return;
        case "assumed":
          // [LAW:no-silent-failure] Left running, and written where every
          // daemon's ⚠ reads it; one the directory did not take is held here
          // and written again.
          log("error", leftReason(ending.left));
          if (ending.unwritten !== null) {
            unwritten = [...unwritten, ending.left];
          }
          return;
      }
    }
    const signal = signalOf(ending.signalled);
    if (ending.verdict !== "unrecorded") {
      const why =
        ending.verdict === "stands" ? "timed out" : "outlived its verdict";
      log("error", `apply-update: act ${facts.act} ${why}; ${signal}`);
      return;
    }
    const reason = actsFault(
      `act ${facts.act} timed out; its verdict could not be written: ${ending.error}; ${signal}`,
    );
    log("error", `apply-update: ${reason}`);
    unrecorded = { job: facts.job, reason };
  }

  // Writes again the groups the directory did not take, then reads every left
  // group. Its own step after the act's read, so that read stands whatever
  // `left/` holds.
  async function watchLeft(): Promise<void> {
    const faults: string[] = [];
    unwritten = unwritten.filter((group) => {
      const fault = leaveGroup(actsDir, group);
      if (fault !== null) faults.push(fault);
      return fault !== null;
    });
    try {
      const read = await lefts.read();
      left = read.groups;
      for (const { left: group, signalled } of read.ended) {
        log("error", provenEnd(group.act, group.pid, signalled));
      }
      faults.push(...read.faults);
    } catch (err) {
      // A `ps` the close aborted says nothing of the group.
      if (err instanceof DaemonClosing) return;
      faults.push((err as Error).message);
    }
    leftFault = faults.length === 0 ? null : actsFault(faults.join("; "));
    if (leftFault !== null) logLeftFault(["error", leftFault]);
  }

  // Notices an act ending, whichever daemon started it: a success means the
  // bundle on disk changed, so the build is sampled and the binary watch asked
  // now.
  async function watchAct(): Promise<void> {
    const read = await touchActs(async () => {
      const facts = await acts.read();
      if (!closed) spendFault = await endIfOverdue(facts);
      return facts;
    });
    if (closed) return;
    await watchLeft();
    if (closed || !read.ok) return;
    if (spendFault !== null) logSpendFault(["error", spendFault]);
    if (unrecorded !== null && read.value?.job !== unrecorded.job) {
      unrecorded = null;
    }
    const next = judgeAct(read.value);
    if (seen === null && next.kind === "running") {
      log("info", `apply-update: act ${next.act} is running; watching it`);
    }
    if (seen?.kind === "running" && next.kind !== "running") {
      if (next.kind === "succeeded") {
        log("info", `apply-update: act ${next.act} succeeded`);
        sampleBuild();
        onApplied();
      }
      if (next.kind === "failed") {
        log("error", `apply-update: act ${next.act} failed: ${next.reason}`);
      }
    }
    seen = next;
  }

  // [LAW:no-ambient-temporal-coupling] Each tick scheduled only once the last
  // has answered, as limits.ts's are: a slow read delays the next.
  let clearTick: (() => void) | undefined;
  async function tick(): Promise<void> {
    await actTurn(watchAct);
    if (closed) return;
    clearTick = clock.after(ACT_POLL_MS, () => void tick(), { unref: true });
  }

  return {
    arm() {
      const sampled = sampleBuild();
      every(sampleBuild, intervalMs);
      armed.push(() => clearTick?.());
      void tick();
      // The registry is a question only a published install asks: a checkout
      // rebuilds from the source beside it, whatever npm has.
      if (sampled.kind === "not-source-checkout") {
        void pollRelease();
        every(() => void pollRelease(), releaseIntervalMs);
      }
    },
    close() {
      closed = true;
      publish();
      armed.forEach((release) => release());
    },
    notice: (ctx) => updateNotice(current(), seen ?? IDLE, ctx),
    running: () =>
      actTurn(async () => {
        const read = await touchActs(() => acts.read());
        return read.ok && judgeAct(read.value).kind === "running";
      }),
    // [LAW:dataflow-not-control-flow] Every message the watch holds, each its
    // own, so none hides another; a group both written and still held shows
    // once, by its pid.
    errors: () =>
      [
        { about: "files", text: unreadable },
        { about: "spend", text: spendFault },
        { about: "unrecorded", text: unrecorded?.reason ?? null },
        { about: "left-files", text: leftFault },
        ...[
          ...new Map(
            [...left, ...unwritten].map((group) => [group.pid, group]),
          ).values(),
        ].map((group) => ({
          about: `left\0${group.pid}`,
          text: leftReason(group),
        })),
      ].flatMap(({ about, text }) => (text === null ? [] : [{ about, text }])),
    act: () =>
      actTurn(async () => {
        if (closed) throw new DaemonClosing("apply-update");
        const read = await touchActs(() => acts.read());
        if (closed) throw new DaemonClosing("apply-update");
        if (!read.ok) throw new BadVerbArgs(`apply-update: ${read.error}`);
        // [LAW:no-ambient-temporal-coupling] Read past the await: the sampler
        // moves the build on timers of its own.
        const update = current();
        if (update === null) {
          throw new BadVerbArgs(
            "apply-update: nothing newer is known to apply",
          );
        }
        const facts = factsOf(update);
        const newest = read.value;
        if (judgeAct(newest).kind === "running") {
          throw new BadVerbArgs(`apply-update: already ${facts.busy}`);
        }
        // The child inherits the daemon's environment (PATH included): no env
        // is passed, so nothing about the command is composed from data.
        const claim = await claimAct(
          launcher,
          actsDir,
          newest === null ? null : newest.act,
          updateIdentity(update),
          { ...facts.command, category: "update.apply" },
          ACT_TIMEOUT_MS,
          clock.now(),
          readStart,
        );
        if (!claim.ok) {
          throw new BadVerbArgs(`apply-update: ${claim.reason}`);
        }
        log(
          "info",
          `apply-update: act ${claim.act}: ${facts.act} — ${facts.command.bin} ${facts.command.args?.join(" ") ?? ""}`,
        );
        seen = { kind: "running", act: claim.act };
        unrecorded = null;
      }),
  };
}
