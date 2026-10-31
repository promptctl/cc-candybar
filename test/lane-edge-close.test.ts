// [LAW:no-ambient-temporal-coupling] The lane edge's polls end with the daemon:
// a setup waiting on a process or a subscriber does not outlive its close, and
// no signal is sent from a daemon that is gone.

import { productionLaneEdge } from "../src/daemon/lane-edge";
import { processLauncher } from "../src/proc/launch";

describe("the lane edge after its daemon closes", () => {
  const edgeOver = (closing: AbortController) =>
    productionLaneEdge(processLauncher, () => new Set(), closing.signal);

  test("a wait for a subscriber ends at once, before its deadline", async () => {
    const closing = new AbortController();
    const waiting = edgeOver(closing).followed("s", "pane", 30_000);
    closing.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a wait for a process to exit ends at once, with the process alive", async () => {
    const closing = new AbortController();
    const waiting = edgeOver(closing).exited(process.pid, 15_000);
    closing.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  test("no signal is sent", () => {
    const closing = new AbortController();
    closing.abort();
    const kill = jest.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(() => edgeOver(closing).terminate(4242)).toThrow();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
