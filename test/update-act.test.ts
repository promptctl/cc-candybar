// [LAW:behavior-not-structure] The update act's record
// (brandon-unfiled-3248.z676): an act is a job whose running and verdict are
// files, so any daemon reads how it stands; one claim wins per bundle; and a
// verdict, once written, is never overwritten.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  endJob,
  launchJobSync,
  readJobEnd,
  type JobFiles,
} from "../src/proc/launch";
import {
  actsDir,
  claimAct,
  judgeAct,
  makeActReader,
  type ActFacts,
  type ActRecord,
} from "../src/daemon/update-act";
import type { StartTimeRead } from "../src/daemon/process-fingerprint";
import { until } from "./helpers/until";

let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-act-"));
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

const RECORD: ActRecord = {
  identity: "id-1",
  pid: 1,
  startTime: null,
  deadline: 0,
};
const facts = (over: Partial<ActFacts>): ActFacts => ({
  act: 3,
  record: RECORD,
  alive: true,
  end: null,
  lastLine: null,
  ...over,
});
// The fingerprint is not under test here: every leader reads as the recorded one.
const sameLeader = (): StartTimeRead => ({ kind: "unavailable", detail: "-" });

describe("judgeAct: the act as every daemon sees it", () => {
  test.each([
    ["no act", null, { kind: "idle" }],
    ["alive with no verdict", facts({}), { kind: "running", act: 3 }],
    [
      "gone with no verdict",
      facts({ alive: false }),
      {
        kind: "failed",
        act: 3,
        identity: "id-1",
        reason: "lost: the act ended without a verdict",
      },
    ],
    [
      "exit 0",
      facts({ alive: false, end: { kind: "exit", code: 0 } }),
      { kind: "succeeded", act: 3 },
    ],
    [
      "a non-zero exit, with the last line it left",
      facts({ alive: false, end: { kind: "exit", code: 2 }, lastLine: "boom" }),
      {
        kind: "failed",
        act: 3,
        identity: "id-1",
        reason: "non-zero (exit 2): boom",
      },
    ],
    [
      "a non-zero exit that left nothing",
      facts({ alive: false, end: { kind: "exit", code: 1 } }),
      {
        kind: "failed",
        act: 3,
        identity: "id-1",
        reason: "non-zero (exit 1): no output",
      },
    ],
    [
      "a timeout, still dying",
      facts({ end: { kind: "timeout" } }),
      { kind: "failed", act: 3, identity: "id-1", reason: "timeout" },
    ],
  ])("%s", (_name, input, expected) => {
    expect(judgeAct(input)).toEqual(expected);
  });
});

const jobFiles = (): JobFiles => ({
  stdout: path.join(scratch, "stdout"),
  stderr: path.join(scratch, "stderr"),
  status: path.join(scratch, "status"),
});
const marker = () => path.join(scratch, "ran");

describe("launchJobSync: a job whose output and verdict are files", () => {
  test("released, it runs: output and the exit land in its files", async () => {
    const files = jobFiles();
    const job = launchJobSync(
      {
        bin: "sh",
        args: ["-c", "echo out; echo err >&2; touch ran; exit 3"],
        cwd: scratch,
        category: "update.apply",
      },
      files,
    );
    if (!job.ok) throw new Error(job.error);
    job.release();
    await until(() => readJobEnd(files.status) !== null, "the job's verdict");
    expect(readJobEnd(files.status)).toEqual({ kind: "exit", code: 3 });
    expect(fs.readFileSync(files.stdout, "utf8")).toBe("out\n");
    expect(fs.readFileSync(files.stderr, "utf8")).toBe("err\n");
    expect(fs.existsSync(marker())).toBe(true);
  });

  test("withdrawn, the program never runs and no verdict is written", async () => {
    const files = jobFiles();
    const job = launchJobSync(
      { bin: "touch", args: [marker()], category: "update.apply" },
      files,
    );
    if (!job.ok) throw new Error(job.error);
    job.withdraw();
    await until(
      () => !groupAlive(job.pid),
      "the withdrawn job's shell to exit",
    );
    expect(fs.existsSync(marker())).toBe(false);
    expect(readJobEnd(files.status)).toBeNull();
  });

  test("a program that is not found fails in its own stderr, as a non-zero exit", async () => {
    const files = jobFiles();
    const job = launchJobSync(
      { bin: "ccb-no-such-program", category: "update.apply" },
      files,
    );
    if (!job.ok) throw new Error(job.error);
    job.release();
    await until(() => readJobEnd(files.status) !== null, "the job's verdict");
    expect(readJobEnd(files.status)).toEqual({ kind: "exit", code: 127 });
    expect(fs.readFileSync(files.stderr, "utf8")).toMatch(/not found/);
  });

  test("the first verdict wins: a timeout never overwrites an exit, and a late exit never overwrites a timeout", async () => {
    const exited = jobFiles();
    const quick = launchJobSync(
      { bin: "true", category: "update.apply" },
      exited,
    );
    if (!quick.ok) throw new Error(quick.error);
    quick.release();
    await until(() => readJobEnd(exited.status) !== null, "the job's verdict");
    expect(endJob(quick.pid, exited.status, { kind: "timeout" })).toBe(false);
    expect(readJobEnd(exited.status)).toEqual({ kind: "exit", code: 0 });

    const ended = {
      ...jobFiles(),
      status: path.join(scratch, "status-2"),
    };
    const slow = launchJobSync(
      { bin: "sleep", args: ["30"], category: "update.apply" },
      ended,
    );
    if (!slow.ok) throw new Error(slow.error);
    slow.release();
    expect(endJob(slow.pid, ended.status, { kind: "timeout" })).toBe(true);
    await until(() => !groupAlive(slow.pid), "the ended job's group to go");
    expect(readJobEnd(ended.status)).toEqual({ kind: "timeout" });
  });

  test("a status this module did not write is an error, not an end", () => {
    const files = jobFiles();
    fs.writeFileSync(files.status, "done\n");
    expect(() => readJobEnd(files.status)).toThrow(/not a job verdict/);
  });
});

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

const SLEEP = { bin: "sleep", args: ["30"], category: "update.apply" as const };
const TOUCH = (file: string) => ({
  bin: "touch",
  args: [file],
  category: "update.apply" as const,
});

describe("claimAct: one act per bundle", () => {
  const dirOf = () => actsDir(scratch, "/some/bundle/index.mjs");
  const ended: number[] = [];
  afterEach(() => {
    for (const pid of ended.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  });

  test("a claim starts the job, and every daemon reading the bundle sees it running, then its verdict", async () => {
    const dir = dirOf();
    const claim = claimAct(dir, null, "id-1", SLEEP, 60_000, 0, sameLeader);
    expect(claim).toEqual({ ok: true, act: 1 });
    const reader = makeActReader(dir, sameLeader);
    const running = reader.read()!;
    ended.push(running.record.pid);
    expect(judgeAct(running)).toEqual({ kind: "running", act: 1 });
    expect(makeActReader(dir, sameLeader).read()!.record.identity).toBe("id-1");

    expect(
      endJob(running.record.pid, path.join(dir, "1", "status"), {
        kind: "timeout",
      }),
    ).toBe(true);
    await until(
      () => judgeAct(reader.read()).kind === "failed",
      "the timeout verdict",
    );
    expect(judgeAct(reader.read())).toMatchObject({ reason: "timeout" });
  });

  test("a claim onto an act that exists loses, and its program never runs", async () => {
    const dir = dirOf();
    const first = claimAct(dir, null, "id-1", SLEEP, 60_000, 0, sameLeader);
    expect(first.ok).toBe(true);
    ended.push(makeActReader(dir, sameLeader).read()!.record.pid);
    // A second daemon that judged the bundle idle from the same empty read.
    const second = claimAct(
      dir,
      null,
      "id-1",
      TOUCH(marker()),
      60_000,
      0,
      sameLeader,
    );
    expect(second).toEqual({
      ok: false,
      reason: "another act claimed this bundle first",
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(marker())).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a claim that lands below a later act withdraws, and its program never runs", async () => {
    const dir = dirOf();
    fs.mkdirSync(path.join(dir, "5"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "5", "record.json"),
      JSON.stringify(RECORD),
    );
    // A claimer that read act 2 as newest before act 5 was claimed.
    const stale = claimAct(
      dir,
      2,
      "id-1",
      TOUCH(marker()),
      60_000,
      0,
      sameLeader,
    );
    expect(stale.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(marker())).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(["5"]);
  });

  test("a new act after an ended one takes the next number and removes the ended", async () => {
    const dir = dirOf();
    expect(
      claimAct(dir, null, "id-1", TOUCH(marker()), 60_000, 0, sameLeader),
    ).toEqual({ ok: true, act: 1 });
    const reader = makeActReader(dir, sameLeader);
    await until(
      () => judgeAct(reader.read()).kind === "succeeded",
      "the first act to succeed",
    );
    expect(
      claimAct(dir, 1, "id-2", TOUCH(marker()), 60_000, 0, sameLeader),
    ).toEqual({ ok: true, act: 2 });
    expect(fs.readdirSync(dir)).toEqual(["2"]);
    await until(
      () => judgeAct(reader.read()).kind === "succeeded",
      "the second act to succeed",
    );
  });

  test("acts are kept per bundle", () => {
    expect(actsDir(scratch, "/a/index.mjs")).not.toBe(
      actsDir(scratch, "/b/index.mjs"),
    );
  });
});
