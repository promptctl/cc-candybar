// The Node client states when it will hang up (brandon-unfiled-3248.8ro6,
// §4c), and hangs up then: one instant, its budget counted from the connect,
// is both the `deadline` its render request carries and the one its own timer
// gives up at. A stand-in daemon on a fake dialer reads what the client sent,
// and a held clock says when the client gives up.

import type { Duplex } from "node:stream";
import { RENDER_BUDGETS, tryRenderViaDaemon } from "../../src/daemon/client";
import { HOME_ENV, NAME_ENV, homeOf } from "../../src/daemon/home";
import { socketPath } from "../../src/daemon/paths";
import {
  CONNECT_TIMEOUT_MS,
  encodeFrame,
  makeFrameReader,
  TOTAL_BUDGET_MS,
} from "../../src/daemon/protocol";
import { heldClock } from "../../src/held-clock";
import { fakeDialer } from "../helpers/dial";
import { hostOf } from "../helpers/host";

const host = hostOf({ [HOME_ENV]: "/fake-home", [NAME_ENV]: "deadline" });
const home = homeOf(host);

// A daemon that hands every request it reads to `seen`, and answers it with
// `reply`, or, given none, never answers.
function standIn(
  reply: object | null,
  seen: (req: Record<string, unknown>) => void,
) {
  const dialer = fakeDialer();
  dialer.listen(socketPath(home), (end: Duplex) => {
    end.on(
      "data",
      makeFrameReader(
        (frame) => {
          seen(frame as Record<string, unknown>);
          if (reply !== null) end.end(encodeFrame(reply));
        },
        (err) => {
          throw err;
        },
      ),
    );
  });
  return dialer;
}

const HOOK = {
  session_id: "deadline",
  workspace: { project_dir: "/tmp" },
  model: { id: "x", display_name: "X" },
} as never;

describe("the Node client's deadline", () => {
  test("the statusline's budgets are the wire facts", () => {
    expect(RENDER_BUDGETS).toEqual({
      connectMs: CONNECT_TIMEOUT_MS,
      budgetMs: TOTAL_BUDGET_MS,
    });
  });

  test("a render request states the client's budget from the connect", async () => {
    const clock = heldClock(new Date(1_000_000));
    let deadline: unknown;
    const dialer = standIn({ ok: true, output: "bar" }, (req) => {
      deadline = req.deadline;
    });
    await expect(
      tryRenderViaDaemon(
        { host, home, clock, dialer },
        HOOK,
        ["cc-candybar"],
        "/tmp",
        {},
      ),
    ).resolves.toEqual({ kind: "ok", value: "bar" });
    expect(deadline).toBe(clock.now() + RENDER_BUDGETS.budgetMs);
  });

  test("a client the daemon never answers gives up at the deadline it stated", async () => {
    const clock = heldClock(new Date(1_000_000));
    let heard!: (deadline: number) => void;
    const asked = new Promise<number>((r) => (heard = r));
    const dialer = standIn(null, (req) => heard(req.deadline as number));
    const outcome = tryRenderViaDaemon(
      { host, home, clock, dialer },
      HOOK,
      ["cc-candybar"],
      "/tmp",
      {},
    );
    const deadline = await asked;
    clock.advance(deadline - clock.now() - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    // Its own deadline timer, not the connect's: the request reached the
    // stand-in and the client waited for an answer it never got. Busy, not
    // transient: a daemon accepted the request, so a kick's candidate would
    // lose the bind to it.
    expect(await outcome).toEqual({
      kind: "busy",
      phase: "deadline",
      message: "TIMEOUT",
    });
  });
});
