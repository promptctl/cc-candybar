// A click's launch of a program (a copy's or an open's act, and an opener's
// handoff): one that fails says what the launch itself said of why, so the
// outcome and the click's event carry the cause, not only the class of failure.

import {
  clickLaunchVia,
  launchOutcome,
} from "../src/daemon/foundations/click-launch";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { HOST } from "./helpers/host";
import { tmpdir } from "node:os";
import path from "node:path";
import { clickHandoff } from "../src/daemon/click-handoff";
import { systemLauncher } from "../src/proc/system-launcher";
import { systemTimekeeper } from "../src/time";
import type { Launcher } from "../src/proc/launcher";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// An opener's handoff (xdg-open with no browser running stays the browser's
// parent): the click answers by its bound and leaves what it opened running.
describe("clickHandoff", () => {
  test("an opener still running at the bound is answered and left running", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "handoff-test-"));
    const pidFile = path.join(dir, "pid");
    await clickHandoff(
      systemLauncher({ inherited: process.env }, systemTimekeeper),
      {
        bin: "/bin/sh",
        args: ["-c", `echo $$ > ${pidFile}; exec sleep 30`],
        category: "click.open",
      },
      "opening a browser",
      () => {},
      200,
      HOST.tmp,
    );
    // A loaded machine can answer the bound before the opener has started.
    const started = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < started)
      await new Promise((r) => setTimeout(r, 20));
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      // Past the kill grace a timed-out launch would have used.
      await new Promise((r) => setTimeout(r, 500));
      expect(alive(pid)).toBe(true);
    } finally {
      process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an opener whose sh dies with no verdict fails the click as lost", async () => {
    await expect(
      clickHandoff(
        systemLauncher({ inherited: process.env }, systemTimekeeper),
        // Kills the job's whole group, the verdict-writing sh with it.
        { bin: "/bin/sh", args: ["-c", "kill -9 0"], category: "click.open" },
        "opening https://example.com",
        () => {},
        2000,
        HOST.tmp,
      ),
    ).rejects.toThrow("opening https://example.com failed (lost)");
  });

  test("a rate-limited opener is logged and the click acknowledged", async () => {
    const launcher = systemLauncher(
      { inherited: process.env },
      systemTimekeeper,
    );
    const opts = { bin: "/usr/bin/true", category: "click.open" } as const;
    await clickHandoff(launcher, opts, "first", () => {}, 2000, HOST.tmp);
    const logged: string[] = [];
    await clickHandoff(
      launcher,
      opts,
      "second",
      (_l, m) => logged.push(m),
      2000,
      HOST.tmp,
    );
    expect(logged).toEqual([
      expect.stringMatching(/^rate-limited: click.open /),
    ]);
  });

  test("an opener that exits non-zero fails the click with its stderr", async () => {
    await expect(
      clickHandoff(
        systemLauncher({ inherited: process.env }, systemTimekeeper),
        {
          bin: "/bin/sh",
          args: ["-c", "echo no method available >&2; exit 3"],
          category: "click.open",
        },
        "opening https://example.com",
        () => {},
        2000,
        HOST.tmp,
      ),
    ).rejects.toThrow(
      "opening https://example.com failed (exited with code 3: no method available)",
    );
  });

  test("an opener that exits zero is answered at once", async () => {
    const t0 = Date.now();
    await clickHandoff(
      systemLauncher({ inherited: process.env }, systemTimekeeper),
      { bin: "/usr/bin/true", category: "click.open" },
      "opening https://example.com",
      () => {},
      2000,
      HOST.tmp,
    );
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("launchOutcome", () => {
  const launcher = systemLauncher({ inherited: process.env }, systemTimekeeper);
  // `launcher`, running `bin` and `args` for every launch asked of it.
  const running = (bin: string, args: string[]): Pick<Launcher, "launch"> => ({
    launch: (opts) =>
      launcher.launch({ ...opts, bin, args, stdinInput: undefined }),
  });

  test("a hung copy fails its act at the click's bound", async () => {
    const launched = await clickLaunchVia(running("/bin/sleep", ["30"]))({
      bin: "/usr/bin/pbcopy",
      stdinInput: "x",
      category: "click.pbcopy",
    });
    expect(launchOutcome(launched, "pbcopy", () => {})).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/^pbcopy failed/),
    });
  }, 15_000);

  test("a setsid descendant holding stdout leaves the loop answering while it lives", async () => {
    const script =
      "import os,time\nif os.fork()==0:\n  os.setsid()\n  time.sleep(3)\n  os._exit(0)\nos._exit(0)\n";
    let ticks = 0;
    const ticking = setInterval(() => ticks++, 10);
    const started = performance.now();
    const launched = await clickLaunchVia(
      running("python3", ["-c", script]),
    )({ bin: "/usr/bin/pbcopy", stdinInput: "x", category: "click.pbcopy" });
    clearInterval(ticking);
    expect(launchOutcome(launched, "pbcopy", () => {})).toEqual({ kind: "ok" });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(ticks).toBeGreaterThan(0);
  });

  test("a program that cannot start fails its act, naming the spawn's own error", async () => {
    const launched = await clickLaunchVia(
      systemLauncher({ inherited: process.env }, systemTimekeeper),
    )({
      bin: "/nonexistent/cc-candybar-no-such-opener",
      args: ["https://example.com"],
      category: "click.open",
    });
    expect(
      launchOutcome(launched, "opening https://example.com", () => {}),
    ).toEqual({
      kind: "failed",
      reason: expect.stringMatching(
        /^opening https:\/\/example\.com failed \(.*ENOENT\)$/,
      ),
    });
  });
});
