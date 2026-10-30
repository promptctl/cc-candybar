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
import path from "node:path";

import {
  endJob,
  jobGroupAlive,
  launchJobSync,
  readJobEnd,
  type JobEnd,
  type JobFiles,
  type LaunchOpts,
} from "../proc/launch";
import { readStartTime, type StartTimeRead } from "./process-fingerprint";

export function actsDir(stateDir: string, entryPath: string): string {
  const key = createHash("sha256").update(entryPath).digest("hex").slice(0, 16);
  return path.join(stateDir, "update-act", key);
}

// What `act()` started: the identity of the newer thing it applies (the
// notice names a failure against it), the job's process identity, and when the
// act is overdue.
export interface ActRecord {
  readonly identity: string;
  readonly pid: number;
  readonly startTime: string | null;
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
// never wrote one, and an act that ends between the two reads reads as
// running for one more look.
export interface ActFacts {
  readonly act: number;
  readonly record: ActRecord;
  readonly alive: boolean;
  readonly end: JobEnd | null;
  // The last line the program left: stderr's, else stdout's.
  readonly lastLine: string | null;
}

// [LAW:dataflow-not-control-flow] Facts to state, nothing read here.
export function judgeAct(facts: ActFacts | null): ActState {
  if (facts === null) return IDLE;
  const { act, record, alive, end, lastLine } = facts;
  if (end === null) {
    return alive
      ? { kind: "running", act }
      : {
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
// name, which is no act.
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
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return (
      buf
        .toString("utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .at(-1) ?? null
    );
  } finally {
    fs.closeSync(fd);
  }
}

// Whether the job's group is the one the record names. A pid is never reused
// while a process group of that id exists, so a live group whose leader has
// gone is still the job's; only a live leader can be someone else's (a
// reboot recycled the pid), and its start time tells.
export function isRecordedJob(
  record: ActRecord,
  read: (pid: number) => StartTimeRead = readStartTime,
): boolean {
  if (!jobGroupAlive(record.pid)) return false;
  if (record.startTime === null) return true;
  const leader = read(record.pid);
  return leader.kind === "unavailable" || leader.token === record.startTime;
}

export interface ActReader {
  // The newest act on the bundle, read now.
  read(): ActFacts | null;
}

// [LAW:effects-at-boundaries] The edge that reads acts. Who the recorded job
// is gets settled by a fingerprint once per act (a `ps`); after that each read
// asks only whether its group is alive.
export function makeActReader(
  dir: string,
  read: (pid: number) => StartTimeRead = readStartTime,
): ActReader {
  const ours = new Map<number, boolean>();
  return {
    read() {
      const act = actNumbers(dir).at(-1);
      if (act === undefined) return null;
      const actDir = path.join(dir, String(act));
      const record = JSON.parse(
        fs.readFileSync(recordOf(actDir), "utf8"),
      ) as ActRecord;
      const files = filesOf(actDir);
      if (!ours.has(act)) ours.set(act, isRecordedJob(record, read));
      const alive = ours.get(act)! && jobGroupAlive(record.pid);
      const end = readJobEnd(files.status);
      const lastLine =
        end === null
          ? null
          : (lastLineOf(files.stderr) ?? lastLineOf(files.stdout));
      return { act, record, alive, end, lastLine };
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
  dir: string,
  after: number | null,
  identity: string,
  command: LaunchOpts,
  timeoutMs: number,
  now: number,
  read: (pid: number) => StartTimeRead = readStartTime,
): Claim {
  const act = (after ?? 0) + 1;
  const actDir = path.join(dir, String(act));
  fs.mkdirSync(dir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dir, ".claim-"));
  // The job writes where the act will be, once released.
  const job = launchJobSync(command, filesOf(actDir));
  if (!job.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`apply-update: ${job.error}`);
  }
  const start = read(job.pid);
  const record: ActRecord = {
    identity,
    pid: job.pid,
    startTime: start.kind === "start" ? start.token : null,
    deadline: now + timeoutMs,
  };
  fs.writeFileSync(recordOf(staging), JSON.stringify(record));
  try {
    fs.renameSync(staging, actDir);
  } catch (err) {
    job.withdraw();
    fs.rmSync(staging, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return { ok: false, reason: "another act claimed this bundle first" };
    }
    throw err;
  }
  const acts = actNumbers(dir);
  if (acts.some((n) => n > act)) {
    job.withdraw();
    fs.rmSync(actDir, { recursive: true, force: true });
    return { ok: false, reason: "another act claimed this bundle first" };
  }
  job.release();
  for (const n of acts.filter((n) => n < act)) {
    fs.rmSync(path.join(dir, String(n)), { recursive: true, force: true });
  }
  return { ok: true, act };
}

// Ends an act past its deadline with a `timeout` verdict, once its group is
// proven the recorded job afresh (the cached proof may predate a reboot).
// False when the job's own verdict landed first.
export function endOverdue(
  dir: string,
  facts: ActFacts,
  read: (pid: number) => StartTimeRead = readStartTime,
): boolean {
  if (!isRecordedJob(facts.record, read)) return false;
  const status = filesOf(path.join(dir, String(facts.act))).status;
  return endJob(facts.record.pid, status, { kind: "timeout" });
}
