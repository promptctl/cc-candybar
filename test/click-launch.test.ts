// A click's launch of a program (src/daemon/verbs/index.ts): one that fails
// says what the launch itself said of why, so the click's reply and its event
// carry the cause, not only the class of failure.

import { clickLaunch } from "../src/daemon/verbs";
import { processLauncher } from "../src/proc/launch";

describe("clickLaunch", () => {
  test("a program that cannot start is a throw naming the spawn's own error", async () => {
    await expect(
      clickLaunch(
        processLauncher,
        {
          bin: "/nonexistent/cc-candybar-no-such-opener",
          args: ["https://example.com"],
          timeoutMs: 1000,
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
