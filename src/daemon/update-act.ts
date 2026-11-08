// The update act's record: the act rewrites the bundle a daemon runs from, so
// it is a job (src/proc/launch.ts) that outlives the daemon that started it,
// and its running and its verdict are files every daemon on that bundle reads.
// A daemon that dies mid-act leaves the act running; the next daemon reads it
// as running, refuses a second, and shows the verdict when it lands.
//
// [LAW:one-source-of-truth] The acts directory is the one answer to "is an
// act running on this bundle, and how did the last one end"; each daemon
// judges the directory when it asks. What a daemon holds beside it is its own
// last look at an act's spend, a copy the act's files outrank once they hold a
// larger spend (`latestLook`), and why it ended an act whose verdict it could
// not write, which the directory cannot say.
//
// Layout: `<state>/update-act/<bundle key>/<n>/` per act, `n` counting up.
// Each act directory holds `record.json` (what was started, by whom it is
// identified) beside the job's `stdout`, `stderr` and `status`, and
// `awake.json` once a daemon has watched it running; `left/<pid>.json` names
// a group an end could not prove and left running. The key is the
// bundle's path, because the bundle is what an act writes: two daemons on one
// state folder running two bundles never see each other's acts.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type JobEnding,
  readJobEnd,
  type JobEnd,
  type JobFiles,
  type LaunchOpts,
  type Launcher,
  type ProvenJobGroup,
} from "../proc/launch";
import { stagedPath } from "../utils/staged-path";
import { writeAtomic } from "../utils/atomic-write";
import { readTailSync } from "../utils/transcript-fs";
import type { StartTimeRead } from "./process-fingerprint";
import type { Timekeeper } from "../time.js";

export function actsDir(stateDir: string, entryPath: string): string {
  const key = createHash("sha256").update(entryPath).digest("hex").slice(0, 16);
  return path.join(stateDir, "update-act", key);
}

// What `act()` started: the identity of the newer thing it applies (the
// notice names a failure against it), the job's process identity (its start
// time null where `ps` could not answer, as process-fingerprint.ts allows),
// and when it started.
export interface ActRecord {
  readonly identity: string;
  readonly pid: number;
  readonly startTime: string | null;
  readonly started: number;
  // [LAW:one-source-of-truth] exception: the budget's wall-time end, which
  // this version never judges by (an act's budget is the `ActAwake` below).
  // Daemons of older versions read the same acts during an update and end an
  // act once their clock passes it, so a record without it would be ended by
  // every one of them at its next look.
  readonly deadline: number;
}

// [LAW:types-are-the-program] What an act has spent of its budget, in observed
// time: the time some daemon watched it running, as of the last look. Wall time
// runs while the machine sleeps, and on macOS so do `hrtime` and `os.uptime`, so
// no clock reads awake time; what bounds a wedged act is time it could have run.
export interface ActAwake {
  readonly spentMs: number;
  readonly lastSeen: number;
}

// An act no daemon has looked at, as of its start.
export const unwatched = (record: ActRecord): ActAwake => ({
  spentMs: 0,
  lastSeen: record.started,
});

// [LAW:one-source-of-truth] The look a daemon counts on from: the latest one
// known, as the act's files hold it (`shared`) or as this daemon took it
// (`own`), else the act's start. One fact, two copies: the files are every
// daemon's, so another daemon's later look wins, and a daemon's own is how its
// looks still add up while the files can't take a write. Latest is the larger
// spend, since a job's spend only grows; a `lastSeen` is the wall clock's, and
// a clock set back would hand a stale copy the win. Equal spends go to the
// later look, which a span already counted from.
export const latestLook = (
  record: ActRecord,
  shared: ActAwake | null,
  own: ActAwake | null,
): ActAwake => {
  if (own === null) return shared ?? unwatched(record);
  if (shared === null) return own;
  const ownLater =
    own.spentMs > shared.spentMs ||
    (own.spentMs === shared.spentMs && own.lastSeen > shared.lastSeen);
  return ownLater ? own : shared;
};

// [LAW:dataflow-not-control-flow] One more look at the act running, at `now`:
// the span since the last look, whichever daemon took it, when the loop could
// have run that span, which is one of at most `longestMs`. A longer gap is a
// machine that was not running the loop (asleep, or a dark wake's first look),
// and a clock set back spans nothing: both count 0. Daemons looking in turn
// sum to the time the act was watched, not a multiple of it.
export const observe = (
  awake: ActAwake,
  now: number,
  longestMs: number,
): ActAwake => {
  const span = now - awake.lastSeen;
  return {
    spentMs: awake.spentMs + (span >= 0 && span <= longestMs ? span : 0),
    lastSeen: now,
  };
};

// [LAW:types-are-the-program] The act as every daemon sees it. `succeeded`
// is its own arm, not `idle`, so a daemon watching an act end can tell a
// rebuilt bundle from nothing having happened.
export type ActState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly act: number }
  | { readonly kind: "succeeded"; readonly act: number }
  | {
      readonly kind: "failed";
      readonly act: number;
      readonly identity: string;
      readonly reason: string;
    };

export const IDLE: ActState = { kind: "idle" };

// [LAW:one-source-of-truth] Which job an act's facts are of: one value per job
// the reader came to know, so a holder of an earlier read tells the same job
// by identity and never matches records itself.
declare const actJob: unique symbol;
export interface ActJob {
  readonly [actJob]: true;
}

// One act as read from disk. `alive` is read before `end`: a job writes its
// verdict before its group ends, so "gone, then no verdict" is a job that
// never wrote one.
export interface ActFacts {
  readonly act: number;
  // The job these facts are of, as their reader settled it.
  readonly job: ActJob;
  readonly record: ActRecord;
  readonly alive: boolean;
  readonly end: JobEnd | null;
  // The last line the program left: stderr's, else stdout's.
  readonly lastLine: string | null;
}

// [LAW:dataflow-not-control-flow] Facts to state, nothing read here. An act
// runs while anything of its group is alive, whatever its verdict: a
// timed-out group is still dying, and a program can leave a child running past
// its own exit, and either may still be writing the bundle. Its verdict
// stands once the group is gone.
export function judgeAct(facts: ActFacts | null): ActState {
  if (facts === null) return IDLE;
  const { act, record, alive, end, lastLine } = facts;
  if (alive) return { kind: "running", act };
  if (end === null) {
    return {
      kind: "failed",
      act,
      identity: record.identity,
      reason: "lost: the act ended without a verdict",
    };
  }
  if (end.kind === "exit" && end.code === 0) return { kind: "succeeded", act };
  const reason =
    end.kind === "timeout"
      ? "timeout"
      : `non-zero (exit ${end.code}): ${lastLine ?? "no output"}`;
  return { kind: "failed", act, identity: record.identity, reason };
}

const filesOf = (actDir: string): JobFiles => ({
  stdout: path.join(actDir, "stdout"),
  stderr: path.join(actDir, "stderr"),
  status: path.join(actDir, "status"),
});
const recordOf = (actDir: string): string => path.join(actDir, "record.json");
const awakeOf = (actDir: string): string => path.join(actDir, "awake.json");

// The numbered acts, ascending. A claim in progress stages under a dotted
// name, and an act being removed leaves under one, which is no act.
function actNumbers(dir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);
}

// The last non-empty line of a file's tail — where a build tool puts its
// verdict. Only the tail is read: a build's log can be long.
const TAIL_BYTES = 4096;
function lastLineOf(file: string): string | null {
  const tail = readTailSync(file, TAIL_BYTES);
  switch (tail.kind) {
    case "absent":
      return null;
    case "failed":
      throw new Error(`${file}: ${tail.reason}`);
    case "ok":
      return (
        tail.value.buf
          .toString("utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .at(-1) ?? null
      );
  }
}

// Removes an act in one step, by renaming it to a dotted name first: removed
// in place, its files would go one by one, and a reader between them could
// find the record without the verdict and read an end it never had.
// Another claim that won after this one may have removed it already.
function removeAct(dir: string, act: number): void {
  const leaving = path.join(dir, `.removed-${act}-${process.pid}`);
  try {
    fs.renameSync(path.join(dir, String(act)), leaving);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  fs.rmSync(leaving, { recursive: true, force: true });
}

// [LAW:types-are-the-program] How the job's group stands against the record,
// read now. `fingerprinted`: its leader is live and its start time is the
// record's, the one proof that needs nothing but the group. `assumed`: a live
// group whose leader has gone, or whose job `ps` could not fingerprint, has no
// start time to tell by and is taken as the job's, since the sh leads it, so
// the program outliving it is the likelier story. `absent`: a job started
// before this boot is gone, whatever holds its pid now, and a live leader whose
// start time differs is someone else's. Only the fingerprinted arm carries a
// group the launcher can end without a verdict.
export type JobProof =
  | { readonly kind: "fingerprinted"; readonly group: ProvenJobGroup }
  | { readonly kind: "assumed" | "absent" };

// What a job's group is judged by: its pid, its leader's start time, and when
// it started.
type JobIdentity = Pick<ActRecord, "pid" | "startTime" | "started">;

// A group of this boot that is still alive: the part of the proof that needs
// no `ps`.
const groupStands = (
  record: JobIdentity,
  jobs: Pick<Launcher, "jobGroupAlive">,
  boot: number,
): boolean => record.started > boot && jobs.jobGroupAlive(record.pid);

export async function jobProof(
  record: JobIdentity,
  read: (pid: number) => Promise<StartTimeRead>,
  jobs: Pick<Launcher, "jobGroupAlive">,
  boot: number,
): Promise<JobProof> {
  if (!groupStands(record, jobs, boot)) return { kind: "absent" };
  const leader = await read(record.pid);
  if (record.startTime === null || leader.kind === "unavailable") {
    return { kind: "assumed" };
  }
  // [LAW:single-enforcer] The one place a group is proven by its fingerprint.
  return leader.token === record.startTime
    ? { kind: "fingerprinted", group: record.pid as ProvenJobGroup }
    : { kind: "absent" };
}

// Whether the job's group is the one the record names.
// [LAW:one-source-of-truth] Derived from the proof, so a reader and an end
// judge a group by one rule.
export const isRecordedJob = async (
  ...args: Parameters<typeof jobProof>
): Promise<boolean> => (await jobProof(...args)).kind !== "absent";

// One of an act's files, or null when it is not there.
function readActFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// The record of an act, or null when the act is gone.
function readRecord(actDir: string): ActRecord | null {
  const text = readActFile(recordOf(actDir));
  return text === null ? null : (JSON.parse(text) as ActRecord);
}

export interface ActReader {
  // The newest act on the bundle, read now. Reads must not overlap: `known`
  // spans the `ps` a new job costs, so the reader's one caller runs them in
  // turn (the act queue, src/daemon/update-notice.ts).
  read(): Promise<ActFacts | null>;
}

// The newest act as one reader knows it, keyed by its job, since an act's
// number is claimed again once its directory is gone. `ours` turns false for
// good once the group reads gone: a gone group never comes back as the job's,
// though its pid may come back as someone else's. `final` holds the facts from
// then on, since a job writes its verdict before its group ends.
interface Known {
  readonly record: ActRecord;
  readonly job: ActJob;
  ours: boolean;
  final: ActFacts | null;
}

const sameJob = (a: ActRecord, b: ActRecord): boolean =>
  a.pid === b.pid && a.startTime === b.startTime;

// [LAW:effects-at-boundaries] The edge that reads acts. Who the recorded job
// is gets settled by a fingerprint once per job (a `ps`); after that each read
// asks only whether its group is alive and whether it left a verdict, until
// the group is gone.
export function makeActReader(
  dir: string,
  read: (pid: number) => Promise<StartTimeRead>,
  jobs: Pick<Launcher, "jobGroupAlive">,
  clock: Pick<Timekeeper, "bootTime">,
): ActReader {
  let known: Known | null = null;

  // The act's facts, or null when the act vanished under the read.
  async function factsOf(act: number): Promise<ActFacts | null> {
    const actDir = path.join(dir, String(act));
    const record = readRecord(actDir);
    if (record === null) return null;
    if (known === null || !sameJob(known.record, record)) {
      known = {
        record,
        job: {} as ActJob,
        // [LAW:one-source-of-truth] The boot is read off the clock the
        // record's start was written by, never beside it.
        ours: await isRecordedJob(record, read, jobs, clock.bootTime()),
        final: null,
      };
    }
    if (known.final !== null) return known.final;
    known.ours = known.ours && jobs.jobGroupAlive(record.pid);
    const files = filesOf(actDir);
    const end = readJobEnd(files.status);
    const lastLine =
      end === null
        ? null
        : (lastLineOf(files.stderr) ?? lastLineOf(files.stdout));
    // An act removed after its record was read reads as an end it never had,
    // so what was read stands only while the act still does.
    if (!fs.existsSync(actDir)) return null;
    const facts = {
      act,
      job: known.job,
      record,
      alive: known.ours,
      end,
      lastLine,
    };
    if (!facts.alive) known.final = facts;
    return facts;
  }

  return {
    async read() {
      // An act vanishes only when a newer one's claim prunes it, so the
      // listing after a vanish names a newer act. The same act twice is a
      // numbered directory no claim made.
      let vanished: number | null = null;
      for (;;) {
        const act = actNumbers(dir).at(-1);
        if (act === undefined) return null;
        if (act === vanished) {
          throw new Error(
            `${path.join(dir, String(act))}: an act with no record`,
          );
        }
        const facts = await factsOf(act);
        if (facts !== null) return facts;
        vanished = act;
      }
    },
  };
}

// [LAW:no-ambient-temporal-coupling] Synchronous, so no exit lands between the
// staging directory and its removal: nothing sweeps a stranded one. False when
// the act already exists.
function stakeClaim(dir: string, actDir: string, record: ActRecord): boolean {
  fs.mkdirSync(dir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dir, ".claim-"));
  try {
    fs.writeFileSync(recordOf(staging), JSON.stringify(record));
    fs.renameSync(staging, actDir);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw err;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export type Claim =
  | { readonly ok: true; readonly act: number }
  | { readonly ok: false; readonly reason: string };

// [LAW:single-enforcer] The one way an act starts, and the claim is the
// filesystem's: the record is staged in a private directory and renamed to
// the next act number, and a rename onto an act that exists fails, so of two
// daemons that both judged the bundle idle, one claims. The job is spawned
// before the rename, its gate shut, and released only once the claim stands:
// a claimer that loses, or dies, never runs the program. The winner lists the
// acts again before releasing: a claimer stalled mid-claim can land on a
// number already pruned while a later act runs, and it withdraws. A daemon
// closing during the job's `ps` throws from `read`, which withdraws too.
export async function claimAct(
  launcher: Launcher,
  dir: string,
  after: number | null,
  identity: string,
  command: LaunchOpts,
  timeoutMs: number,
  now: number,
  read: (pid: number) => Promise<StartTimeRead>,
): Promise<Claim> {
  const act = (after ?? 0) + 1;
  const actDir = path.join(dir, String(act));
  // The job writes where the act will be, once released.
  const job = launcher.launchJobSync(command, filesOf(actDir));
  if (!job.ok) throw new Error(`apply-update: ${job.error}`);
  // [LAW:single-enforcer] The gate opens on a standing claim and on nothing
  // else: every other way out, a throw included, shuts it unopened.
  let stood = false;
  try {
    const start = await read(job.pid);
    const record: ActRecord = {
      identity,
      pid: job.pid,
      startTime: start.kind === "start" ? start.token : null,
      started: now,
      deadline: now + timeoutMs,
    };
    if (!stakeClaim(dir, actDir, record)) return CLAIMED_FIRST;
    if (actNumbers(dir).some((n) => n > act)) {
      removeAct(dir, act);
      return CLAIMED_FIRST;
    }
    stood = true;
  } finally {
    if (stood) job.release();
    else job.withdraw();
  }
  for (const n of actNumbers(dir).filter((n) => n < act)) {
    removeAct(dir, n);
  }
  return { ok: true, act };
}

const CLAIMED_FIRST: Claim = {
  ok: false,
  reason: "another act claimed this bundle first",
};

// [LAW:parse-dont-validate] What an act's spend file says: a spend, none yet
// (no daemon has watched the act), bytes this version can't parse, or a read
// that failed. Unparsed bytes are replaced, since nothing else repairs them;
// a failed read is left in place, since the spend it holds may be every
// daemon's and still good, and a transient fault must not hand it back.
type SpendRead =
  | { readonly kind: "spend"; readonly awake: ActAwake | null }
  | { readonly kind: "unparsed"; readonly reason: string }
  | { readonly kind: "unread"; readonly reason: string };

function readAwake(file: string): SpendRead {
  let text: string | null;
  try {
    text = readActFile(file);
  } catch (err) {
    return { kind: "unread", reason: (err as Error).message };
  }
  if (text === null) return { kind: "spend", awake: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "unparsed", reason: `${(err as Error).message}: ${text}` };
  }
  const { spentMs, lastSeen } = (parsed ?? {}) as Partial<
    Record<keyof ActAwake, unknown>
  >;
  // A negative or infinite spend would end a healthy build at once or never.
  return typeof spentMs === "number" &&
    typeof lastSeen === "number" &&
    spentMs >= 0 &&
    Number.isFinite(spentMs) &&
    Number.isFinite(lastSeen)
    ? { kind: "spend", awake: { spentMs, lastSeen } }
    : { kind: "unparsed", reason: `not an act's spend: ${text}` };
}

// [LAW:parse-dont-validate] One look: what the act has spent as of it, and
// why its files could not take it, if they could not. A fault is the caller's
// to report once it has judged the spend, so a write that fails never stands
// between an act and its end.
export interface ActLook {
  readonly awake: ActAwake;
  readonly fault: string | null;
}

// [LAW:effects-at-boundaries] Spends one look at an act its reader saw alive
// at `now`, counting on from the latest look known (`latestLook`, with `own`
// this daemon's last look of the same job), and writes what it has spent for
// every daemon after this one: a daemon started mid-act carries on from it.
// Two daemons racing one look lose nothing whichever write lands: each moves
// spend and last look on together, so the next look counts from the last look
// the file names. Null when the act is gone: a newer claim pruned it under
// this look, and a look never makes an act's directory.
export function spendLook(
  dir: string,
  facts: ActFacts,
  own: ActAwake | null,
  now: number,
  longestMs: number,
): ActLook | null {
  const actDir = path.join(dir, String(facts.act));
  const file = awakeOf(actDir);
  const read = readAwake(file);
  const awake = observe(
    latestLook(facts.record, read.kind === "spend" ? read.awake : null, own),
    now,
    longestMs,
  );
  // [LAW:no-silent-failure] A spend that can't be read is left as it is, and
  // this look counts on from the latest look this daemon knows of, then says
  // so. The fault names the file and why, not where the look counted from:
  // that moves from the act's start to this daemon's own after one look, and
  // one fault would read as two.
  if (read.kind === "unread") {
    return { awake, fault: `${file}: ${read.reason}; left in place` };
  }
  const faults: string[] = [];
  // [LAW:no-silent-failure] A spend this version can't parse is replaced by
  // the latest look this daemon knows of, then reported. Read as spent, it
  // ends a build mid-write; left in place, nothing repairs it, and the act runs
  // unbounded while it holds every restart.
  if (read.kind === "unparsed") {
    const carried =
      own === null
        ? "its spend restarts"
        : "its spend carries on from this daemon's last look";
    faults.push(`${file}: ${read.reason}; ${carried}`);
  }
  // [LAW:one-type-per-behavior] Staged where every write stages, so two
  // daemons' looks never write one file. Not flushed: a crash ends the act's
  // group with the boot it ran in, and its spend with it.
  const staged = stagedPath(file);
  try {
    fs.writeFileSync(staged, JSON.stringify(awake));
    fs.renameSync(staged, file);
  } catch (err) {
    // Only a staging that is there is removed: a directory that can't be
    // searched, where none could be staged, answers a removal with EACCES, a
    // throw that would stand between the act and its end.
    if (fs.existsSync(staged)) fs.rmSync(staged, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // The code, not the message: that names the staging, a new path each look,
    // and the fault would read as a new one at every look.
    faults.push(`${file}: not written: ${code ?? (err as Error).message}`);
  }
  return { awake, fault: faults.length === 0 ? null : faults.join("; ") };
}

// [LAW:types-are-the-program] What ending an overdue act did. An act whose
// files went before its end (a newer claim pruned it, or the state directory
// was removed) carries how its group stood at the end: signalled only when
// `fingerprinted`, and `assumed` is a live group nothing proved, left running.
export type ActEnding =
  | Exclude<JobEnding, { verdict: "gone" }>
  | {
      readonly verdict: "gone";
      readonly proof: "fingerprinted";
      readonly signalled: boolean;
    }
  | { readonly verdict: "gone"; readonly proof: "absent" }
  | {
      readonly verdict: "gone";
      readonly proof: "assumed";
      readonly left: LeftGroup;
      // Why the left group could not be written, null when it was.
      readonly unwritten: string | null;
    };

// Ends an act whose group its reader saw alive past its budget, with a
// `timeout` verdict unless the job's own landed first: a live read already
// proved the group the recorded job, and the act's standing status is what
// keeps that proof. Once the act's files are gone nothing keeps it, so the
// group is proven again, now, by its leader alone.
export async function endOverdue(
  dir: string,
  facts: ActFacts,
  read: (pid: number) => Promise<StartTimeRead>,
  jobs: Pick<Launcher, "endJob" | "endJobGroup" | "jobGroupAlive">,
  boot: number,
): Promise<ActEnding> {
  const { record } = facts;
  const status = filesOf(path.join(dir, String(facts.act))).status;
  const ending = jobs.endJob(record.pid, status, { kind: "timeout" });
  if (ending.verdict !== "gone") return ending;
  const { pid, startTime, started } = record;
  const left: LeftGroup = { act: facts.act, pid, startTime, started };
  // [LAW:no-ambient-temporal-coupling] Left before the proof's `ps`, so a
  // daemon that exits during it leaves the group for the next one to judge;
  // a proof that settles it takes the entry back.
  const unwritten = leaveGroup(dir, left);
  // [LAW:no-silent-failure] A group left running beside a newer act is the
  // harm. [LAW:single-enforcer] Signalled on the fingerprint and nothing else,
  // read just before the signal, so a pid another process now leads is never
  // signalled, and a group only the vanished status could prove stays left.
  const proof = await jobProof(record, read, jobs, boot);
  switch (proof.kind) {
    case "fingerprinted": {
      const signalled = jobs.endJobGroup(proof.group);
      forgetGroup(dir, left);
      return { verdict: "gone", proof: proof.kind, signalled };
    }
    case "absent":
      forgetGroup(dir, left);
      return { verdict: "gone", proof: proof.kind };
    case "assumed":
      return { verdict: "gone", proof: proof.kind, left, unwritten };
  }
}

// A group an end left running because nothing proved it the job's once its
// act's files were gone: the act it was, and the job it is judged by.
export interface LeftGroup extends JobIdentity {
  readonly act: number;
}

// [LAW:one-source-of-truth] Left groups live beside the acts, one file per
// group, so every daemon on the bundle shows one until it is no longer the
// job's: a restart, which the newer act's success sets off, must not forget a
// group still running. A claim prunes only numbered acts, so it never removes
// one.
const leftDirOf = (dir: string): string => path.join(dir, "left");
const leftFileOf = (dir: string, left: LeftGroup): string =>
  path.join(leftDirOf(dir), `${left.pid}.json`);

// Writes a left group for every daemon on the bundle, and says why it could
// not, null when it did. [LAW:no-silent-failure] Never a throw: the caller
// still owes the group its proof, and holds an unwritten one until it is.
export function leaveGroup(dir: string, left: LeftGroup): string | null {
  const { act, pid, startTime, started } = left;
  try {
    writeAtomic(
      leftFileOf(dir, left),
      JSON.stringify({ act, pid, startTime, started }),
    );
    return null;
  } catch (err) {
    // The code, not the message: that names the staging, a new path each
    // try, and the fault would read as a new one at every tick.
    const code = (err as NodeJS.ErrnoException).code;
    return `left group (pid ${pid}): not written: ${code ?? (err as Error).message}`;
  }
}

const forgetGroup = (dir: string, left: LeftGroup): void =>
  fs.rmSync(leftFileOf(dir, left), { force: true });

// [LAW:parse-dont-validate] A left group as its file holds it, or null when
// the bytes are not one.
function parseLeftGroup(text: string): LeftGroup | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const { act, pid, startTime, started } = (parsed ?? {}) as Partial<
    Record<keyof LeftGroup, unknown>
  >;
  return Number.isSafeInteger(act) &&
    Number.isSafeInteger(pid) &&
    (pid as number) > 0 &&
    (startTime === null || typeof startTime === "string") &&
    typeof started === "number" &&
    Number.isFinite(started)
    ? {
        act: act as number,
        pid: pid as number,
        startTime,
        started,
      }
    : null;
}

// A left group a reader proved the job's, and whether it took the signal.
export interface LeftEnded {
  readonly left: LeftGroup;
  readonly signalled: boolean;
}

// The left groups that still run, those the read proved and ended, and why
// any entry could not be read as one.
export interface LeftRead {
  readonly groups: readonly LeftGroup[];
  readonly ended: readonly LeftEnded[];
  readonly faults: readonly string[];
}

export interface LeftReader {
  // Reads must not overlap, as an act reader's must not: the act queue runs
  // them in turn.
  read(): Promise<LeftRead>;
}

// [LAW:effects-at-boundaries] The edge that reads left groups, judging each
// by `jobProof` once per entry (a `ps`), since a group that died while no
// daemon watched may have handed its pid to someone else's; after that only
// whether its group is alive. An entry whose group is not the job's is
// removed, and one its fingerprint proves is ended and removed. [LAW:no-silent-failure] An
// entry that can't be parsed is left in place and named, since nothing else
// repairs it.
export function makeLeftReader(
  dir: string,
  read: (pid: number) => Promise<StartTimeRead>,
  jobs: Pick<Launcher, "jobGroupAlive" | "endJobGroup">,
  clock: Pick<Timekeeper, "bootTime">,
): LeftReader {
  // The entries this reader has fingerprinted, by everything they name.
  let proven = new Set<string>();
  return {
    async read() {
      const leftDir = leftDirOf(dir);
      let names: string[];
      try {
        names = fs.readdirSync(leftDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        names = [];
      }
      const boot = clock.bootTime();
      const groups: LeftGroup[] = [];
      const ended: LeftEnded[] = [];
      const faults: string[] = [];
      const standing = new Set<string>();
      for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
        const file = path.join(leftDir, name);
        // Another daemon may have removed it since the listing.
        const text = readActFile(file);
        if (text === null) continue;
        const left = parseLeftGroup(text);
        if (left === null) {
          faults.push(`${file}: not a left group: ${text}; remove it`);
          continue;
        }
        const key = JSON.stringify(left);
        const proof: JobProof = proven.has(key)
          ? { kind: groupStands(left, jobs, boot) ? "assumed" : "absent" }
          : await jobProof(left, read, jobs, boot);
        switch (proof.kind) {
          // [LAW:single-enforcer] What the end does with a fingerprint, for
          // an entry an end left before its proof ran: a daemon that exited
          // during it.
          case "fingerprinted":
            ended.push({ left, signalled: jobs.endJobGroup(proof.group) });
            fs.rmSync(file, { force: true });
            break;
          case "absent":
            fs.rmSync(file, { force: true });
            break;
          case "assumed":
            standing.add(key);
            groups.push(left);
        }
      }
      proven = standing;
      return { groups, ended, faults };
    },
  };
}
