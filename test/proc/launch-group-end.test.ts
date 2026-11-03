import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemLauncher } from "../../src/proc/system-launcher";
import {
  MAX_CAPTURED_BYTES,
  type LaunchCategory,
  type Launcher,
} from "../../src/proc/launch";
import type { DrainEnd, LaunchStatsHandle } from "../../src/proc/stats-handle";
import { until } from "../helpers/until";
import { systemTimekeeper } from "../../src/time";

// What these cases launch leaves its process group with setsid, which only
// python reaches portably: macOS has no setsid command.
const python = (code: string) => ({ bin: "python3", args: ["-c", code] });

const SET = "import os,sys,time\n";
// Forks a process that leaves the group and holds the inherited stdout for 3 s.
const FORK_HOLDER =
  "if os.fork()==0:\n  os.setsid()\n  time.sleep(3)\n  os._exit(0)\n";

interface DrainClose {
  category: LaunchCategory;
  // What every drain had read by this close.
  bytes: number;
  end: DrainEnd;
}
let drainRead: number;

let ending: AbortController;
let launcher: Launcher;
let drainsOpened: LaunchCategory[];
let drainsClosed: DrainClose[];
beforeEach(() => {
  ending = new AbortController();
  drainsOpened = [];
  drainsClosed = [];
  drainRead = 0;
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
  launcher = systemLauncher(
    { inherited: process.env, signal: ending.signal, stats },
    systemTimekeeper,
  );
});
afterEach(() => ending.abort());

const launch = (run: { bin: string; args: string[] }, timeoutMs?: number) =>
  launcher.launch({
    category: "user-shell",
    bin: run.bin,
    args: run.args,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe("a launch whose child ends with a descendant outside its group", () => {
  it.each([[undefined], [2000]])(
    "resolves on the child's exit code (timeoutMs %s)",
    async (timeoutMs) => {
      const t0 = Date.now();
      const r = await launch(
        python(`${SET}print('out',flush=True)\n${FORK_HOLDER}os._exit(0)\n`),
        timeoutMs,
      );
      expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: "out\n" });
      expect(Date.now() - t0).toBeLessThan(2000);
    },
  );

  it("shows a character cut short at the end of its output as U+FFFD", async () => {
    const r = await launch(
      python(
        `${SET}os.write(1,b'ok \\xe2')\nos.write(2,b'no \\xe2')\n${FORK_HOLDER}os._exit(0)\n`,
      ),
    );
    expect(r).toMatchObject({
      ok: true,
      stdout: "ok \ufffd",
      stderr: "no \ufffd",
    });
  });

  it("leaves the descendant its pipes, so a later write does not kill it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-group-end-"));
    const marker = join(dir, "wrote");
    const r = await launch(
      python(
        `${SET}if os.fork()==0:\n  os.setsid()\n  time.sleep(0.3)\n  print('late',flush=True)\n  open(${JSON.stringify(marker)},'w').close()\n  os._exit(0)\nos._exit(0)\n`,
      ),
    );
    expect(r).toMatchObject({ ok: true, stdout: "" });
    try {
      await until(() => existsSync(marker), "the holder's later write");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("reports the child's exit when its group ended before the timeout", async () => {
    const r = await launch(
      {
        bin: "sh",
        args: [
          "-c",
          'sleep 0.9 & python3 -c "$1"; exit 0',
          "sh",
          `${SET}${FORK_HOLDER}`,
        ],
      },
      1450,
    );
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("reports an abort once the child has ended, whatever the group did", async () => {
    const abort = new AbortController();
    const running = launcher.launch({
      category: "user-shell",
      bin: "sh",
      args: [
        "-c",
        'sleep 0.9 & python3 -c "$1"; exit 0',
        "sh",
        `${SET}${FORK_HOLDER}`,
      ],
      signal: abort.signal,
    });
    // After the member ends, before the next sample of the group.
    await new Promise((end) => setTimeout(end, 1300));
    abort.abort();
    expect(await running).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("reports a non-zero exit as one", async () => {
    const r = await launch(python(`${SET}${FORK_HOLDER}os._exit(3)\n`));
    expect(r).toMatchObject({ ok: false, reason: "non-zero", exitCode: 3 });
  });

  it("resolves timeout for a child that ignores SIGTERM", async () => {
    const r = await launch(
      python(
        `${SET}import signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\n${FORK_HOLDER}time.sleep(10)\n`,
      ),
      200,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("resolves when a group member ends just after the child", async () => {
    for (let i = 0; i < 50; i += 1) {
      const r = await launch({
        bin: "sh",
        args: [
          "-c",
          'sleep 0.002 & python3 -c "$1"; exit 0',
          "sh",
          `${SET}${FORK_HOLDER}`,
        ],
      });
      expect(r.ok).toBe(true);
    }
  }, 60_000);

  it("is bounded by its timeout when a zombie keeps the group from ending", async () => {
    // A member forks a child it never reaps, then leaves the group holding
    // stdout: the zombie stays a member of the group for the holder's life.
    const t0 = Date.now();
    const r = await launch(
      python(
        `${SET}if os.fork()==0:\n  if os.fork()==0:\n    os._exit(0)\n  os.setsid()\n  time.sleep(3)\n  os._exit(0)\nos._exit(0)\n`,
      ),
      300,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
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
