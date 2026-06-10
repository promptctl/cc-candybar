// [LAW:behavior-not-structure] describeFailure is the operator-CLI rendering
// of a failed round-trip outcome. The load-bearing contract: the "daemon may
// not be running" spawn hint appears ONLY on transient failures — a permanent
// failure means the daemon is demonstrably up and answering, and suggesting a
// respawn would send the operator down the wrong path (the CLI analogue of
// the render path's kick-vs-no-kick split).

import { describeFailure } from "../src/daemon/client-transport";
import type {
  PermanentOutcome,
  TransientOutcome,
} from "../src/daemon/client-transport";

const HINT = "daemon may not be running";

describe("describeFailure", () => {
  test("every transient cause carries the spawn hint", () => {
    const causes: TransientOutcome["cause"][] = [
      "unreachable",
      "timeout",
      "io_error",
    ];
    for (const cause of causes) {
      const text = describeFailure({ kind: "transient", cause, message: "x" });
      expect(text).toContain(HINT);
      expect(text).toContain(cause);
    }
  });

  test("no permanent cause carries the spawn hint", () => {
    const outcomes: PermanentOutcome[] = [
      { kind: "permanent", cause: "version_mismatch", clientV: 3, daemonV: 4 },
      { kind: "permanent", cause: "bad_request", message: "x" },
      { kind: "permanent", cause: "render_failed", message: "x" },
      { kind: "permanent", cause: "malformed_response", message: "x" },
    ];
    for (const outcome of outcomes) {
      expect(describeFailure(outcome)).not.toContain(HINT);
    }
  });

  test("version mismatch names both protocol versions", () => {
    const text = describeFailure({
      kind: "permanent",
      cause: "version_mismatch",
      clientV: 3,
      daemonV: 4,
    });
    expect(text).toContain("client v3");
    expect(text).toContain("daemon v4");
  });

  test("an unechoed daemon version renders as unknown, not v0", () => {
    const text = describeFailure({
      kind: "permanent",
      cause: "version_mismatch",
      clientV: 3,
      daemonV: 0,
    });
    expect(text).toContain("unknown");
    expect(text).not.toContain("v0");
  });

  test("message-bearing permanent causes surface the daemon's message", () => {
    const text = describeFailure({
      kind: "permanent",
      cause: "render_failed",
      message: "template exploded",
    });
    expect(text).toContain("render_failed");
    expect(text).toContain("template exploded");
  });
});
