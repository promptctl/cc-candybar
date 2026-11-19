// A click's launch of a program (src/renderer/verbs/index.ts): one that fails
// says what the launch itself said of why, so the click's reply and its event
// carry the cause, not only the class of failure.

import { WITHHOLDS_NOTHING } from "../src/proc/repository-vars";
import { systemLauncher } from "../src/proc/system-launcher";
import { systemTimekeeper } from "../src/time";
import { clickLaunchVia } from "../src/daemon/foundations/click-launch";
import { clickLaunch } from "../src/daemon/foundations/click-launch";

describe("clickLaunch", () => {
  test("a program that cannot start is a throw naming the spawn's own error", async () => {
    await expect(
      clickLaunch(
        clickLaunchVia(
          systemLauncher({ withholds: WITHHOLDS_NOTHING, inherited: process.env }, systemTimekeeper),
        ),
        {
          bin: "/nonexistent/cc-candybar-no-such-opener",
          args: ["https://example.com"],
          category: "click.open",
        },
        "opening https://example.com",
        "opened",
      ),
    ).rejects.toThrow(/^opening https:\/\/example\.com failed \(.*ENOENT\)$/);
  });

  test("a launch the rate limit refused is skipped, saying it did not run", async () => {
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
        kind: "skipped",
        reason: expect.stringMatching(/^pbcopy not run: /),
      },
      said: expect.stringMatching(/^pbcopy not run: /),
    });
  });
});
