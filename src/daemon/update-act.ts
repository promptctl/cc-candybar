// The update act's record: the act rewrites the bundle a daemon runs from, so
// it is a job (src/proc/launch.ts) that outlives the daemon that started it,
// and its running and its verdict are files every daemon on that bundle reads.
// A daemon that dies mid-act leaves the act running; the next daemon reads it
// as running, refuses a second, and shows the verdict when it lands.
//
// [LAW:one-source-of-truth] The acts directory is the one answer to "is an
// act running on this bundle, and how did the last one end". No daemon holds
// that answer in memory; each judges the directory when it asks.
//
// Layout: `<state>/update-act/<bundle key>/<n>/` per act, `n` counting up.
// Each act directory holds `record.json` (what was started, by whom it is
// identified) beside the job's `stdout`, `stderr` and `status`. The key is the
// bundle's path, because the bundle is what an act writes: two daemons on one
// state folder running two bundles never see each other's acts.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  endJob,
  jobGroupAlive,
  type JobEnding,
  readJobEnd,
  type JobEnd,
  type JobFiles,
  type LaunchOpts,
  type Launcher,
} from "../proc/launch";
import { readTailSync } from "../utils/transcript-fs";
import type { StartTimeRead } from "./process-fingerprint";

export function actsDir(stateDir: string, entryPath: string): string {
  const key = createHash("sha256").update(entryPath).digest("hex").slice(0, 16);
  return path.join(stateDir, "update-act", key);
}

// What `act()` started: the identity of the newer thing it applies (the
// notice names a failure against it), the job's process identity (its start
// time null where `ps` could not answer, as process-fingerprint.ts allows),
// when it started, and when it is overdue.
export interface ActRecord {
  readonly identity: string;
  readonly pid: number;
  readonly startTime: string | null;
  readonly started: number;
  readonly deadline: number;
}

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

// One act as read from disk. `alive` is read before `end`: a job writes its
// verdict before its group ends, so "gone, then no verdict" is a job that
// never wrote one.
export interface ActFacts {
  readonly act: number;
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

// When this boot began, by the wall clock the record's start is written in.
const bootedAt = (): number => Date.now() - os.uptime() * 1000;

// Whether the job's group is the one the record names. A job started before
// this boot is gone, whatever holds its pid now. A live leader whose start
// time differs is someone else's. A live group whose leader has gone, or whose
// job `ps` could not fingerprint, has no start time to tell by and is taken as
// the job's: the sh leads it, so the program outliving it is the likelier
// story.
export function isRecordedJob(
  record: ActRecord,
  read: (pid: number) => StartTimeRead,
  boot: number = bootedAt(),
): boolean {
  if (record.started <= boot || !jobGroupAlive(record.pid)) return false;
  const leader = read(record.pid);
  return (
    record.startTime === null ||
    leader.kind === "unavailable" ||
    leader.token === record.startTime
  );
}

// The record of an act, or null when the act is gone.
function readRecord(actDir: string): ActRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordOf(actDir), "utf8")) as ActRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface ActReader {
  // The newest act on the bundle, read now.
  read(): ActFacts | null;
}

// The newest act as one reader knows it, keyed by its job, since an act's
// number is claimed again once its directory is gone. `ours` turns false for
// good once the group reads gone: a gone group never comes back as the job's,
// though its pid may come back as someone else's. `final` holds the facts from
// then on, since a job writes its verdict before its group ends.
interface Known {
  readonly record: ActRecord;
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
  read: (pid: number) => StartTimeRead,
): ActReader {
  let known: Known | null = null;

  // The act's facts, or null when the act vanished under the read.
  function factsOf(act: number): ActFacts | null {
    const actDir = path.join(dir, String(act));
    const record = readRecord(actDir);
    if (record === null) return null;
    if (known === null || !sameJob(known.record, record)) {
      known = { record, ours: isRecordedJob(record, read), final: null };
    }
    if (known.final !== null) return known.final;
    known.ours = known.ours && jobGroupAlive(record.pid);
    const files = filesOf(actDir);
    const end = readJobEnd(files.status);
    const lastLine =
      end === null
        ? null
        : (lastLineOf(files.stderr) ?? lastLineOf(files.stdout));
    // An act removed after its record was read reads as an end it never had,
    // so what was read stands only while the act still does.
    if (!fs.existsSync(actDir)) return null;
    const facts = { act, record, alive: known.ours, end, lastLine };
    if (!facts.alive) known.final = facts;
    return facts;
  }

  return {
    read() {
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
        const facts = factsOf(act);
        if (facts !== null) return facts;
        vanished = act;
      }
    },
  };
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
// number already pruned while a later act runs, and it withdraws.
export function claimAct(
  launcher: Launcher,
  dir: string,
  after: number | null,
  identity: string,
  command: LaunchOpts,
  timeoutMs: number,
  now: number,
  read: (pid: number) => StartTimeRead,
): Claim {
  const act = (after ?? 0) + 1;
  const actDir = path.join(dir, String(act));
  fs.mkdirSync(dir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dir, ".claim-"));
  // The job writes where the act will be, once released.
  const job = launcher.launchJobSync(command, filesOf(actDir));
  if (!job.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`apply-update: ${job.error}`);
  }
  // [LAW:single-enforcer] The gate opens on a standing claim and on nothing
  // else: every other way out, a throw included, shuts it unopened.
  let stood = false;
  try {
    const start = read(job.pid);
    const record: ActRecord = {
      identity,
      pid: job.pid,
      startTime: start.kind === "start" ? start.token : null,
      started: now,
      deadline: now + timeoutMs,
    };
    fs.writeFileSync(recordOf(staging), JSON.stringify(record));
    try {
      fs.renameSync(staging, actDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") return CLAIMED_FIRST;
      throw err;
    }
    if (actNumbers(dir).some((n) => n > act)) {
      removeAct(dir, act);
      return CLAIMED_FIRST;
    }
    stood = true;
  } finally {
    if (stood) job.release();
    else job.withdraw();
    fs.rmSync(staging, { recursive: true, force: true });
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

// Ends an act whose group its reader saw alive past its deadline, with a
// `timeout` verdict unless the job's own landed first: a live read already
// proved the group the recorded job.
export function endOverdue(dir: string, facts: ActFacts): JobEnding {
  const status = filesOf(path.join(dir, String(facts.act))).status;
  return endJob(facts.record.pid, status, { kind: "timeout" });
}
