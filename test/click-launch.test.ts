// A click's launch of a program (src/daemon/verbs/index.ts): one that fails
// says what the launch itself said of why, so the click's reply and its event
// carry the cause, not only the class of failure.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clickHandoff, clickLaunch } from "../src/daemon/verbs";
import { createLauncher } from "../src/proc/launch";

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
      createLauncher({}),
      {
        bin: "/bin/sh",
        args: ["-c", `echo $$ > ${pidFile}; exec sleep 30`],
        category: "click.open",
      },
      "opening a browser",
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Past the kill grace a timed-out launch would have used.
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
  }, 10_000);

  test("an opener that exits non-zero fails the click with its stderr", async () => {
    await expect(
      clickHandoff(
        createLauncher({}),
        {
          bin: "/bin/sh",
          args: ["-c", "echo no method available >&2; exit 3"],
          category: "click.open",
        },
        "opening https://example.com",
      ),
    ).rejects.toThrow(
      "opening https://example.com failed (non-zero, exit 3): no method available",
    );
  });

  test("an opener that exits zero is answered at once", async () => {
    const t0 = Date.now();
    await clickHandoff(
      createLauncher({}),
      { bin: "/usr/bin/true", category: "click.open" },
      "opening https://example.com",
    );
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("clickLaunch", () => {
  test("a program that cannot start is a throw naming the spawn's own error", async () => {
    await expect(
      clickLaunch(
        createLauncher({}),
        {
          bin: "/nonexistent/cc-candybar-no-such-opener",
          args: ["https://example.com"],
          category: "click.open",
        },
        "opening https://example.com",
        () => {},
      ),
    ).rejects.toThrow(
      /^opening https:\/\/example\.com failed \(spawn-error, exit null\): .*ENOENT/,
    );
  });
});
