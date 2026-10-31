// [LAW:behavior-not-structure] The update act's record
// (brandon-unfiled-3248.z676): an act is a job whose running and verdict are
// files, so any daemon reads how it stands; one claim wins per bundle; and a
// verdict, once written, is never overwritten.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  endJob,
  processLauncher,
  readJobEnd,
  type JobFiles,
} from "../src/proc/launch";
import {
  actsDir,
  claimAct,
  isRecordedJob,
  judgeAct,
  makeActReader,
  type ActFacts,
  type ActRecord,
} from "../src/daemon/update-act";
import type { StartTimeRead } from "../src/daemon/process-fingerprint";
import {
  makeUpdateWatch,
  UPDATE_DISMISSED_KEY,
} from "../src/daemon/update-notice";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { stateGate } from "../src/daemon/verbs/state-validators";
import { until } from "./helpers/until";

let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-act-"));
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

const RECORD: ActRecord = {
  identity: "id-1",
  pid: 1,
  startTime: "t",
  started: 0,
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
const sameLeader = (): StartTimeRead => ({ kind: "start", token: "t" });

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
      { kind: "running", act: 3 },
    ],
    [
      "exit 0 with a child still in its group",
      facts({ end: { kind: "exit", code: 0 } }),
      { kind: "running", act: 3 },
    ],
    [
      "a timeout, its group gone",
      facts({ alive: false, end: { kind: "timeout" } }),
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
    const job = processLauncher.launchJobSync(
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
    const job = processLauncher.launchJobSync(
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
    const job = processLauncher.launchJobSync(
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
    const quick = processLauncher.launchJobSync(
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
    const slow = processLauncher.launchJobSync(
      { bin: "sleep", args: ["30"], category: "update.apply" },
      ended,
    );
    if (!slow.ok) throw new Error(slow.error);
    slow.release();
    expect(endJob(slow.pid, ended.status, { kind: "timeout" })).toBe(true);
    await until(() => !groupAlive(slow.pid), "the ended job's group to go");
    expect(readJobEnd(ended.status)).toEqual({ kind: "timeout" });
  });

  test("ending a job whose program exited still ends what it left running, and keeps the exit", async () => {
    const files = jobFiles();
    const job = processLauncher.launchJobSync(
      {
        bin: "sh",
        args: ["-c", "sleep 30 & exit 0"],
        category: "update.apply",
      },
      files,
    );
    if (!job.ok) throw new Error(job.error);
    job.release();
    await until(() => readJobEnd(files.status) !== null, "the job's verdict");
    expect(groupAlive(job.pid)).toBe(true);
    expect(endJob(job.pid, files.status, { kind: "timeout" })).toBe(false);
    await until(() => !groupAlive(job.pid), "the left-behind child to end");
    expect(readJobEnd(files.status)).toEqual({ kind: "exit", code: 0 });
  });

  test("ending a job whose files are gone is a no-op, not an error", () => {
    const status = path.join(scratch, "gone", "status");
    expect(endJob(process.pid, status, { kind: "timeout" })).toBe(false);
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
    const claim = claimAct(
      processLauncher,
      dir,
      null,
      "id-1",
      SLEEP,
      60_000,
      Date.now(),
      sameLeader,
    );
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
    const first = claimAct(
      processLauncher,
      dir,
      null,
      "id-1",
      SLEEP,
      60_000,
      Date.now(),
      sameLeader,
    );
    expect(first.ok).toBe(true);
    ended.push(makeActReader(dir, sameLeader).read()!.record.pid);
    // A second daemon that judged the bundle idle from the same empty read.
    const second = claimAct(
      processLauncher,
      dir,
      null,
      "id-1",
      TOUCH(marker()),
      60_000,
      Date.now(),
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
      processLauncher,
      dir,
      2,
      "id-1",
      TOUCH(marker()),
      60_000,
      Date.now(),
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
      claimAct(
        processLauncher,
        dir,
        null,
        "id-1",
        TOUCH(marker()),
        60_000,
        Date.now(),
        sameLeader,
      ),
    ).toEqual({ ok: true, act: 1 });
    const reader = makeActReader(dir, sameLeader);
    await until(
      () => judgeAct(reader.read()).kind === "succeeded",
      "the first act to succeed",
    );
    expect(
      claimAct(processLauncher, dir, 1, "id-2", TOUCH(marker()), 60_000, Date.now(), sameLeader),
    ).toEqual({ ok: true, act: 2 });
    expect(fs.readdirSync(dir)).toEqual(["2"]);
    await until(
      () => judgeAct(reader.read()).kind === "succeeded",
      "the second act to succeed",
    );
  });

  test("a job `ps` can't fingerprint runs, recorded with no start time", async () => {
    const dir = dirOf();
    const unreadable = (): StartTimeRead => ({
      kind: "unavailable",
      detail: "ps timeout",
    });
    expect(
      claimAct(
        processLauncher,
        dir,
        null,
        "id-1",
        TOUCH(marker()),
        60_000,
        Date.now(),
        unreadable,
      ),
    ).toEqual({ ok: true, act: 1 });
    const reader = makeActReader(dir, unreadable);
    expect(reader.read()!.record.startTime).toBeNull();
    await until(
      () => judgeAct(reader.read()).kind === "succeeded",
      "the act to succeed",
    );
    expect(fs.existsSync(marker())).toBe(true);
  });

  test("a job started before this boot is not the recorded one, whatever holds its pid", () => {
    const dir = dirOf();
    claimAct(processLauncher, dir, null, "id-1", SLEEP, 60_000, Date.now(), sameLeader);
    const { record } = makeActReader(dir, sameLeader).read()!;
    ended.push(record.pid);
    expect(isRecordedJob(record, sameLeader)).toBe(true);
    expect(isRecordedJob({ ...record, started: 0 }, sameLeader)).toBe(false);
  });

  test("an act pruned under a read gives way to the newer act that pruned it", () => {
    const dir = dirOf();
    const write = (act: number, status: string) => {
      fs.mkdirSync(path.join(dir, String(act)), { recursive: true });
      fs.writeFileSync(
        path.join(dir, String(act), "record.json"),
        JSON.stringify({ ...RECORD, identity: `id-${act}` }),
      );
      fs.writeFileSync(path.join(dir, String(act), "status"), status);
    };
    write(1, "exit 0\n");
    const real = fs.readFileSync;
    const spy = jest.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: never[]
    ) => {
      // Another daemon claims act 2 and prunes act 1 between the listing
      // and the read of act 1's record.
      if (String(file).endsWith(path.join("1", "record.json"))) {
        spy.mockRestore();
        write(2, "exit 1\n");
        fs.rmSync(path.join(dir, "1"), { recursive: true });
      }
      return real(file, ...rest);
    }) as typeof fs.readFileSync);
    const facts = makeActReader(dir, sameLeader).read()!;
    expect(facts.act).toBe(2);
    expect(facts.record.identity).toBe("id-2");
  });

  test("an act number claimed again names the new act, not the one this reader knew", async () => {
    const dir = dirOf();
    claimAct(
      processLauncher,
      dir,
      null,
      "id-1",
      TOUCH(marker()),
      60_000,
      Date.now(),
      sameLeader,
    );
    const reader = makeActReader(dir, sameLeader);
    await until(
      () => judgeAct(reader.read()).kind === "succeeded",
      "the first act to succeed",
    );
    fs.rmSync(dir, { recursive: true });
    claimAct(processLauncher, dir, null, "id-2", SLEEP, 60_000, Date.now(), sameLeader);
    const again = reader.read()!;
    ended.push(again.record.pid);
    expect(again.record.identity).toBe("id-2");
    expect(judgeAct(again)).toEqual({ kind: "running", act: 1 });
  });

  test("act files that can't be read are an error the watch shows, and hold no restart", () => {
    const dir = dirOf();
    fs.mkdirSync(path.join(dir, "1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "1", "record.json"), "{ torn");
    const logged: string[] = [];
    const watch = makeUpdateWatch({
      launcher: processLauncher,
      entryUrl: "file:///some/bundle/index.mjs",
      actsDir: dir,
      intervalMs: 60_000,
      releaseIntervalMs: 60_000,
      registryUrl: "http://127.0.0.1:1",
      fetchImpl: fetch,
      onApplied: () => {},
      log: (_level, msg) => logged.push(msg),
    });
    expect(watch.running()).toBe(false);
    expect(watch.error()).toMatch(/update act files .*JSON/);
    expect(logged).toEqual([watch.error()]);
    fs.writeFileSync(
      path.join(dir, "1", "record.json"),
      JSON.stringify({ ...RECORD, started: Date.now() }),
    );
    expect(watch.running()).toBe(false);
    expect(watch.error()).toBeNull();
  });

  // [LAW:no-ambient-temporal-coupling] A release poll out when the daemon
  // closes lands on a watch that knows of no update, and leaves no gate.
  test("a closed watch keeps no dismiss gate, and a late release poll registers none", async () => {
    let answer!: (latest: Response) => void;
    const watch = makeUpdateWatch({
      launcher: processLauncher,
      entryUrl: "file:///some/bundle/index.mjs",
      actsDir: dirOf(),
      intervalMs: 60_000,
      releaseIntervalMs: 60_000,
      registryUrl: "http://127.0.0.1:1",
      fetchImpl: () => new Promise((resolve) => (answer = resolve)),
      onApplied: () => {},
      log: () => {},
    });
    const gate = (): string[] => [
      ...stateGate(DEFAULT_DSL_CONFIG).listKeys(),
    ];
    watch.arm();
    expect(gate()).toContain(UPDATE_DISMISSED_KEY);

    watch.close();
    answer(new Response(JSON.stringify({ latest: "999.0.0" })));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(gate()).not.toContain(UPDATE_DISMISSED_KEY);
    expect(
      watch.notice({ sessionId: "s", dismissed: null, enabled: true }),
    ).toEqual([]);
  });

  test("acts are kept per bundle", () => {
    expect(actsDir(scratch, "/a/index.mjs")).not.toBe(
      actsDir(scratch, "/b/index.mjs"),
    );
  });
});
