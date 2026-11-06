// A click's launch of a program (src/daemon/verbs/index.ts): one that fails
// says what the launch itself said of why, so the click's reply and its event
// carry the cause, not only the class of failure.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { HOST } from "./helpers/host";
import { tmpdir } from "node:os";
import path from "node:path";
import { clickLaunch } from "../src/daemon/apply";
import { clickHandoff } from "../src/daemon/verbs";
import { systemLauncher } from "../src/proc/system-launcher";
import { systemTimekeeper } from "../src/time";

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
    await clickHandoff(
      launcher,
      opts,
      "first",
      () => {},
      2000,
      HOST.tmp,
    );
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

describe("clickLaunch", () => {
  test("a program that cannot start is a failed outcome naming the spawn's own error", async () => {
    const outcome = await clickLaunch(
      systemLauncher({ inherited: process.env }, systemTimekeeper),
      {
        bin: "/nonexistent/cc-candybar-no-such-opener",
        args: ["https://example.com"],
        category: "click.open",
      },
      "opening https://example.com",
    );
    expect(outcome.kind).toBe("failed");
    expect(outcome.said).toMatch(
      /^opening https:\/\/example\.com failed \(.*ENOENT\)$/,
    );
  });
});
