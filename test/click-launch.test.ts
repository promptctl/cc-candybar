// A click's launch of a program (src/renderer/verbs/index.ts): one that fails
// says what the launch itself said of why, so the click's reply and its event
// carry the cause, not only the class of failure.

import { systemLauncher } from "../src/proc/system-launcher";
import { systemTimekeeper } from "./helpers/system-clock";
import {
  CLICK_PROGRAM_TIMEOUT_MS,
  clickLaunch,
  clickLaunchVia,
} from "../src/daemon/foundations/click-launch";
import { hangs } from "../src/proc/spawner-fake";
import { fakeLauncher } from "./helpers/fake-launcher";
import { heldClock } from "./helpers/held-clock";

describe("clickLaunch", () => {
  test("a program that cannot start fails with the spawn's own error", async () => {
    await expect(
      clickLaunch(
        clickLaunchVia(
          systemLauncher({ inherited: process.env }, systemTimekeeper),
        ),
        {
          bin: "/nonexistent/cc-candybar-no-such-opener",
          args: ["https://example.com"],
          category: "click.open",
        },
        "opening https://example.com",
        "opened",
      ),
    ).resolves.toMatchObject({
      outcome: {
        kind: "failed",
        reason: expect.stringMatching(/^opening https:\/\/example\.com failed \(.*ENOENT\)$/),
      },
    });
  });

  test("a launch the rate limit refused fails with its reason", async () => {
    await expect(
      clickLaunch(
        async () => ({
          ok: false,
          reason: "rate-limited",
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          error: "too many click.pbcopy launches",
        }),
        { bin: "/usr/bin/pbcopy", stdinInput: "x", category: "click.pbcopy" },
        "pbcopy",
        "copied",
      ),
    ).resolves.toEqual({
      outcome: {
        kind: "failed",
        reason: expect.stringMatching(/^pbcopy not run: /),
      },
      said: expect.stringMatching(/^pbcopy not run: /),
    });
  });

  test("keeps the launch timeout and returns its failure", async () => {
    const clock = heldClock(new Date(0));
    const closing = new AbortController();
    const { launcher, spawner } = fakeLauncher(clock, { signal: closing.signal });
    spawner.program((bin) => bin === "/example/opener", hangs());
    try {
      const result = clickLaunch(
        clickLaunchVia(launcher),
        { bin: "/example/opener", category: "click.open" },
        "opening a file",
        "opened",
      );
      await clock.settle(CLICK_PROGRAM_TIMEOUT_MS);
      await expect(result).resolves.toMatchObject({
        outcome: {
          kind: "failed",
          reason: "opening a file failed (timed out after 5 s)",
        },
      });
    } finally {
      closing.abort();
      await clock.settle(0);
      await launcher.settled();
    }
  });
});
