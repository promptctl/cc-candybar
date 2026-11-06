import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemLauncher } from "../../src/proc/system-launcher";
import {
  MAX_CAPTURED_BYTES,
  PIPE_EVENT_HOLD_S,
  type LaunchCategory,
  type TestableLauncher,
  type WarningChange,
} from "../../src/proc/launch";
import type { DrainEnd, LaunchStatsHandle } from "../../src/proc/stats-handle";
import { systemSpawner } from "../../src/proc/spawner";
import { heldClock } from "../../src/held-clock";
import { until } from "../helpers/until";
import { systemTimekeeper, type Timekeeper } from "../../src/time";
import { instantOf, type Instant } from "../../src/utils/instant";

// What these cases launch leaves its process group with setsid, which only
// python reaches portably: macOS has no setsid command.
const python = (code: string) => ({ bin: "python3", args: ["-c", code] });

// `hold` waits while its path exists: a case ends what it holds by removing the
// path, and the minute's bound ends it when a killed worker never does.
const SET =
  "import os,sys,time\ndef hold(p):\n  b=time.time()+60\n  while os.path.exists(p) and time.time()<b: time.sleep(0.05)\n";
// The case's directory, removed after it: what holds by it outlives the case's
// body, so a launch that waited for it could not resolve.
let holding: string;
// Forks a process that leaves the group and holds the inherited stdout.
const forkHolder = (path = holding) =>
  `if os.fork()==0:\n  os.setsid()\n  hold(${JSON.stringify(path)})\n  os._exit(0)\n`;

interface DrainClose {
  category: LaunchCategory;
  // What every drain had read by this close.
  bytes: number;
  end: DrainEnd;
}
let drainRead: number;

let ending: AbortController;
let launcher: TestableLauncher;
let heard: WarningChange[];
let drainsOpened: LaunchCategory[];
let drainsClosed: DrainClose[];
const stats: LaunchStatsHandle = {
  onStart: () => {},
  onEnd: () => {},
  onRefused: () => {},
  onDrainOpen: (category) => drainsOpened.push(category),
  onDrainRead: (_category, bytes) => {
    drainRead += bytes;
  },
  onDrainClose: (category, end) =>
    drainsClosed.push({ category, bytes: drainRead, end }),
  onPipeError: () => {},
};
// The case's owner, on whichever clock the case drives.
const launcherOn = (clock: Timekeeper): TestableLauncher =>
  systemLauncher(
    {
      inherited: process.env,
      signal: ending.signal,
      stats,
      observeWarnings: (change) => heard.push(change),
    },
    clock,
  );
beforeEach(() => {
  ending = new AbortController();
  drainsOpened = [];
  drainsClosed = [];
  drainRead = 0;
  heard = [];
  holding = mkdtempSync(join(tmpdir(), "launch-group-end-"));
  launcher = launcherOn(systemTimekeeper);
});
afterEach(() => {
  rmSync(holding, { recursive: true, force: true });
  ending.abort();
});

const launch = (run: { bin: string; args: string[] }, timeoutMs?: number) =>
  launcher.launch({
    category: "user-shell",
    bin: run.bin,
    args: run.args,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe("a launch whose child ends with a descendant outside its group", () => {
  // A timeout armed past the case's own, so only the child's exit can answer:
  // one that fires concludes on the gone group as well.
  it.each([[undefined], [60_000]])(
    "resolves on the child's exit code (timeoutMs %s)",
    async (timeoutMs) => {
      const r = await launch(
        python(`${SET}print('out',flush=True)\n${forkHolder()}os._exit(0)\n`),
        timeoutMs,
      );
      expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: "out\n" });
    },
  );

  it("shows a character cut short at the end of its output as U+FFFD", async () => {
    const r = await launch(
      python(
        `${SET}os.write(1,b'ok \\xe2')\nos.write(2,b'no \\xe2')\n${forkHolder()}os._exit(0)\n`,
      ),
    );
    expect(r).toMatchObject({
      ok: true,
      stdout: "ok \ufffd",
      stderr: "no \ufffd",
    });
  });

  it("leaves the descendant its pipes, so a later write does not kill it", async () => {
    const marker = join(holding, "wrote");
    const r = await launch(
      python(
        `${SET}if os.fork()==0:\n  os.setsid()\n  time.sleep(0.3)\n  print('late',flush=True)\n  open(${JSON.stringify(marker)},'w').close()\n  os._exit(0)\nos._exit(0)\n`,
      ),
    );
    expect(r).toMatchObject({ ok: true, stdout: "" });
    await until(() => existsSync(marker), "the holder's later write");
  });

  // [LAW:no-ambient-temporal-coupling] A launch whose group ended between two of
  // its samples: its child exits at once, a sample sees the group's one member
  // alive and arms the next poll, then the member ends. The launch runs on a
  // held clock, so it samples only when the case advances, and the case moves
  // on each end it observes, never on a span of real time. Every timer the
  // launch arms waits on the case, kill grace included, so a case resolves its
  // launch by the advance it makes next.
  const groupEndedBetweenSamples = async (timeoutMs?: number) => {
    const clock = heldClock(new Date());
    const member = join(holding, "member");
    const pidFile = join(holding, "group");
    writeFileSync(member, "");
    const abort = new AbortController();
    const running = launcherOn(clock).launch({
      category: "user-shell",
      bin: "sh",
      args: [
        "-c",
        'echo $$ > "$2"; python3 -c "$3" & python3 -c "$1"; exit 0',
        "sh",
        `${SET}${forkHolder()}`,
        pidFile,
        `${SET}hold(${JSON.stringify(member)})\n`,
      ],
      signal: abort.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const armed = clock.pending();
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
      "the child to name its group",
    );
    const group = Number(readFileSync(pidFile, "utf8"));
    // The launch has seen the child exit: its first sample waits on the clock.
    await until(
      () => clock.pending() > armed,
      "the launch to see its child exit",
    );
    clock.advance(0);
    rmSync(member);
    await until(
      () => systemSpawner.groupGone(group),
      "the group's member to end",
    );
    return { clock, abort, running };
  };

  it("reports the child's exit when its group ended before the timeout", async () => {
    // The timeout falls before the next sample, which waits at least a poll.
    const { clock, running } = await groupEndedBetweenSamples(1);
    clock.advance(1);
    expect(await running).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("reports an abort once the child has ended, whatever the group did", async () => {
    const { clock, abort, running } = await groupEndedBetweenSamples();
    abort.abort();
    clock.advance(0);
    expect(await running).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("reports a non-zero exit as one", async () => {
    const r = await launch(python(`${SET}${forkHolder()}os._exit(3)\n`));
    expect(r).toMatchObject({ ok: false, reason: "non-zero", exitCode: 3 });
  });

  it("resolves timeout for a child that ignores SIGTERM", async () => {
    const r = await launch(
      python(
        `${SET}import signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\n${forkHolder()}time.sleep(10)\n`,
      ),
      200,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("resolves when a group member ends just after the child", async () => {
    for (let i = 0; i < 50; i += 1) {
      // Each run's holder ends with its run, so the runs never pile up.
      const held = join(holding, `run-${i}`);
      writeFileSync(held, "");
      const r = await launch({
        bin: "sh",
        args: [
          "-c",
          'sleep 0.002 & python3 -c "$1"; exit 0',
          "sh",
          `${SET}${forkHolder(held)}`,
        ],
      });
      rmSync(held);
      expect(r.ok).toBe(true);
    }
  }, 60_000);

  it("is bounded by its timeout when a zombie keeps the group from ending", async () => {
    // A member forks a child it never reaps, then leaves the group holding
    // stdout: the zombie stays a member of the group for the holder's life.
    const r = await launch(
      python(
        `${SET}if os.fork()==0:\n  if os.fork()==0:\n    os._exit(0)\n  os.setsid()\n  hold(${JSON.stringify(holding)})\n  os._exit(0)\nos._exit(0)\n`,
      ),
      300,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("a launch whose group outlives its child", () => {
  it("waits for a member holding stdout, and signals it on timeout", async () => {
    const t0 = Date.now();
    const r = await launch(
      { bin: "sh", args: ["-c", "sleep 5 & exit 0"] },
      200,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it("reads what a member wrote just before the group ended", async () => {
    // The block spans the member's end, so its write and the group's end are
    // seen together: a release in that same callback loses the bytes.
    const block = setInterval(() => {
      const until = Date.now() + 150;
      while (Date.now() < until);
    }, 30);
    try {
      for (let i = 0; i < 50; i += 1) {
        const r = await launch({
          bin: "sh",
          args: ["-c", "(sleep 0.03; head -c 60000 /dev/zero) & exit 0"],
        });
        expect(r.stdout.length).toBe(60000);
      }
    } finally {
      clearInterval(block);
    }
  }, 120_000);

  it("polls nothing once `close` has settled it", async () => {
    const r = await launch({
      bin: "sh",
      args: ["-c", "exec >&- 2>&-; sleep 0.5 & sleep 0.1; exit 0"],
    });
    expect(r.ok).toBe(true);
    const spy = jest.spyOn(process, "kill");
    await new Promise((end) => setTimeout(end, 150));
    const probes = spy.mock.calls.filter(([, sig]) => sig === 0);
    spy.mockRestore();
    expect(probes).toEqual([]);
  });
});

it("a child that ends alone loses nothing it wrote", async () => {
  for (let i = 0; i < 30; i += 1) {
    const r = await launch({
      bin: "head",
      args: ["-c", "1048576", "/dev/zero"],
    });
    expect(r.stdout.length).toBe(1048576);
  }
}, 60_000);

describe("the pipes a descendant holds past its launch", () => {
  it("are drained in the open and closed when the holder ends", async () => {
    const r = await launch(
      python(
        `${SET}if os.fork()==0:\n  os.setsid()\n  time.sleep(0.5)\n  print('late',flush=True)\n  os._exit(0)\nos._exit(0)\n`,
      ),
    );
    expect(r).toMatchObject({ ok: true, stdout: "" });
    expect(drainsOpened).toEqual(["user-shell", "user-shell"]);
    await until(() => drainsClosed.length === 2, "the holder's end");
    expect(drainsClosed.map((d) => d.end)).toEqual(["closed", "closed"]);
    expect(drainRead).toBe(5);
  });

  it("are cut at the bound, so a holder that writes without end dies", async () => {
    const r = await launch(
      python(
        `${SET}if os.fork()==0:\n  os.setsid()\n  time.sleep(0.3)\n  while True: os.write(1,b'x'*65536)\nos._exit(0)\n`,
      ),
    );
    expect(r.ok).toBe(true);
    await until(
      () => drainsClosed.some((d) => d.end === "cut"),
      "the chatty holder's pipe cut",
    );
    const cut = drainsClosed.find((d) => d.end === "cut");
    expect(cut?.bytes).toBeGreaterThan(MAX_CAPTURED_BYTES);
    // The holder died writing to the cut pipe, so its stderr closed too.
    await until(() => drainsClosed.length === 2, "the holder's end");
    // The cut is a pipe event: held for every render, owed to a request until
    // an answer carries it.
    expect(heard.some((c) => c.kind === "launch-pipes")).toBe(true);
    // What a render at `t` seconds after the event shows of it.
    // Found by kind, read now, inside its hold: a lifeline fault under load
    // would list first.
    const pipes = launcher
      .launcherWarnings(instantOf(new Date()), "feed")
      .find((w) => w.kind === "launch-pipes");
    if (pipes?.kind !== "launch-pipes")
      throw new Error("no pipe event shown inside its hold");
    const event = pipes.event;
    const shown = (t: number, render: "feed" | "request") =>
      launcher
        .launcherWarnings((event.at + t) as Instant, render)
        .filter((w) => w.kind === "launch-pipes");
    expect(event.text).toContain("user-shell output cut at the");
    expect(event.text).toContain("now fails its writes");
    expect(shown(PIPE_EVENT_HOLD_S - 1, "feed")).toHaveLength(1);
    expect(shown(PIPE_EVENT_HOLD_S + 1, "feed")).toEqual([]);
    expect(shown(PIPE_EVENT_HOLD_S + 600, "request")).toHaveLength(1);
    launcher.answeredPipeEvent(event);
    expect(shown(PIPE_EVENT_HOLD_S - 1, "feed")).toHaveLength(1);
    expect(shown(PIPE_EVENT_HOLD_S + 1, "request")).toEqual([]);
  });

  it("count only what the holder writes after the launch, against a bound of their own", async () => {
    const r = await launch(
      python(
        `${SET}os.write(1,b'x'*(${MAX_CAPTURED_BYTES}-100))\nif os.fork()==0:\n  os.setsid()\n  time.sleep(0.3)\n  os.write(1,b'y'*4096)\n  os._exit(0)\nos._exit(0)\n`,
      ),
    );
    expect(r).toMatchObject({ ok: true });
    await until(() => drainsClosed.length === 2, "the holder's end");
    expect(drainsClosed.map((d) => d.end)).toEqual(["closed", "closed"]);
  });

  it("are destroyed on the spot when the launcher closed while the launch ran", async () => {
    // The holder writes without end once the launch is over: only a destroyed
    // pipe ends it, since an open one nobody reads blocks it for good.
    const pidFile = join(tmpdir(), `drain-abort-${process.pid}`);
    const pending = launch(
      python(
        `${SET}if os.fork()==0:\n  os.setsid()\n  open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\n  time.sleep(0.5)\n  while True: os.write(1,b'x'*65536)\ntime.sleep(0.3)\nos._exit(0)\n`,
      ),
    );
    await until(() => existsSync(pidFile), "the holder's start");
    ending.abort();
    await pending;
    expect(drainsOpened).toEqual([]);
    const pid = Number(readFileSync(pidFile, "utf8"));
    rmSync(pidFile);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the holder's end at its cut pipe");
  });
});
