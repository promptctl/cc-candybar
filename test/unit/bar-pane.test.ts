// `cc-candybar bar-pane` (src/bar-pane): what it paints, where it stands in
// tmux, and the arguments it takes. The frames themselves are the daemon's push,
// covered by test/frame-feed.test.ts and test/daemon-frame-feed-e2e.test.ts.

import { parseArgs, placementFrom, tmuxPatience } from "../../src/bar-pane";
import { paint } from "../../src/bar-pane/paint";
import { reportPointer } from "../../src/bar-pane/report";
import { singleFlight } from "../../src/bar-pane/single-flight";
import type { ClientOutcome } from "../../src/daemon/client";
import type { TmuxRun } from "../../src/proc/tmux";
import type { Monotonic } from "../../src/time";

describe("bar-pane paint", () => {
  it("places each bar line on its own row and erases what is below", () => {
    expect(paint("row one\nrow two")).toEqual({
      bytes:
        "\x1b[?2026h\x1b[1Hrow one\x1b[0m\x1b[K\x1b[2Hrow two\x1b[0m\x1b[K\x1b[J\x1b[?2026l",
      rows: 2,
    });
  });

  // A newline at the pane's bottom row would scroll its first line away.
  it("writes no newline, whatever newlines the frame ends with", () => {
    expect(paint("only\n\n")).toEqual(paint("only"));
    expect(paint("a\nb\nc").bytes).not.toMatch(/[\r\n]/);
  });
});

// tmux's answers in the daemon's formats (src/daemon/pane-visibility.ts):
// `list-panes` lines of pane id, session id, clients attached, window current,
// window zoomed, pane active; `list-clients` lines of session id and
// control mode.
describe("bar-pane placement", () => {
  const at = (...lines: string[]): string => `${lines.join("\n")}\n`;
  const client = at("$1 0");

  it("is shown while its window is the current one of an attached session", () => {
    expect(
      placementFrom(at("%3 $1 1 1 0 1", "%4 $1 1 1 0 0"), client, "%3", "%4"),
    ).toEqual({
      kind: "shown",
      zoomed: false,
    });
  });

  it("is hidden in another window or a detached session", () => {
    expect(
      placementFrom(at("%3 $1 1 0 0 1", "%4 $1 1 0 0 0"), client, "%3", "%4"),
    ).toEqual({
      kind: "hidden",
    });
    expect(
      placementFrom(at("%3 $1 0 1 0 1", "%4 $1 0 1 0 0"), "", "%3", "%4"),
    ).toEqual({
      kind: "hidden",
    });
  });

  // iTerm2's `tmux -CC` draws every window of its session as a native window.
  it("is shown in any window of a session a control-mode client draws", () => {
    expect(
      placementFrom(
        at("%3 $1 1 0 0 1", "%4 $1 1 0 0 0"),
        at("$1 1"),
        "%3",
        "%4",
      ),
    ).toEqual({
      kind: "shown",
      zoomed: false,
    });
  });

  // A zoom shows one pane: the bar pane behind another's zoom is drawn for
  // nobody, and one that is itself the zoomed pane must not be resized, which
  // would unzoom it.
  it("is hidden behind another pane's zoom, and shown but zoomed as the zoomed pane", () => {
    expect(
      placementFrom(at("%3 $1 1 1 1 1", "%4 $1 1 1 1 0"), client, "%3", "%4"),
    ).toEqual({
      kind: "hidden",
    });
    expect(
      placementFrom(at("%3 $1 1 1 1 0", "%4 $1 1 1 1 1"), client, "%3", "%4"),
    ).toEqual({
      kind: "shown",
      zoomed: true,
    });
  });

  it("is shown when any session holding a linked window shows it", () => {
    expect(
      placementFrom(
        at("%3 $1 0 1 0 1", "%4 $1 0 1 0 0", "%3 $2 1 1 0 1", "%4 $2 1 1 0 0"),
        at("$2 0"),
        "%3",
        "%4",
      ),
    ).toEqual({ kind: "shown", zoomed: false });
  });

  it("is gone once tmux no longer lists the session's pane", () => {
    expect(placementFrom(at("%4 $1 1 1 0 1"), client, "%3", "%4")).toEqual({
      kind: "gone",
    });
  });
});

describe("bar-pane tmux patience", () => {
  const missed: TmuxRun = { kind: "failed", reason: "no answer" };
  const ok: TmuxRun = { kind: "ok", stdout: "" };

  // A call made rarely, as a press is, counts its silence from its own first
  // miss: the time since its last answer says nothing of how long tmux has been
  // silent.
  it("tolerates one miss however long ago the call last answered", () => {
    let now = 0;
    const patience = tmuxPatience({ monotonic: () => now as Monotonic });
    now = 60_000;
    expect(() => patience(missed)).not.toThrow();
    now = 61_000;
    expect(() => patience(ok)).not.toThrow();
    now = 200_000;
    expect(() => patience(missed)).not.toThrow();
  });

  // Two presses that missed twenty minutes apart are not twenty minutes of
  // silence from tmux: the placement loop asks it every tick and says if it is
  // gone.
  it("starts a run of its own for a miss that comes long after the last one", () => {
    let now = 0;
    const patience = tmuxPatience({ monotonic: () => now as Monotonic });
    patience(missed);
    now = 1_200_000;
    expect(() => patience(missed)).not.toThrow();
    now = 1_204_000;
    expect(() => patience(missed)).not.toThrow();
    now = 1_205_001;
    expect(() => patience(missed)).toThrow(/tmux has not answered for 5 s/);
  });

  it("gives up when the misses run past the patience, and an answer ends the run", () => {
    let now = 0;
    const patience = tmuxPatience({ monotonic: () => now as Monotonic });
    patience(missed);
    now = 4_000;
    patience(ok);
    now = 5_000;
    patience(missed);
    now = 9_000;
    expect(() => patience(missed)).not.toThrow();
    now = 10_001;
    expect(() => patience(missed)).toThrow(/tmux has not answered for 5 s/);
  });
});

// The pane's draw and its report of the pointer each go through it.
describe("bar-pane single flight", () => {
  const never = (e: unknown): never => {
    throw e;
  };
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

  // A report made while the pane follows no session has nothing to send and
  // returns at once: the run must still end, or no later report is sent.
  it("runs again after a run whose work ended without waiting", async () => {
    let runs = 0;
    const flight = singleFlight(async () => {
      runs += 1;
    }, never);
    flight();
    await settled();
    flight();
    await settled();
    expect(runs).toBe(2);
  });

  it("makes the requests that come during a run the one run after it, reading the state then", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: number[] = [];
    let state = 0;
    const flight = singleFlight(async () => {
      seen.push(state);
      if (seen.length === 1) await gate;
    }, never);
    flight();
    state = 1;
    flight();
    state = 2;
    flight();
    expect(seen).toEqual([0]);
    release();
    await settled();
    expect(seen).toEqual([0, 2]);
  });

  it("hands a failed run to the failure handler", async () => {
    const failures: unknown[] = [];
    const flight = singleFlight(
      async () => {
        throw new Error("boom");
      },
      (e) => {
        failures.push(e);
        return undefined as never;
      },
    );
    flight();
    await settled();
    expect(failures).toEqual([new Error("boom")]);
  });
});

// The host takes a pointer report only from a pane whose stream it holds.
describe("bar-pane pointer report", () => {
  const facts = { id: "pane", gestures: ["left"], hover: null };
  const sends = () => {
    const sent: string[] = [];
    return {
      sent,
      send: async (sessionId: string): Promise<ClientOutcome> => {
        sent.push(sessionId);
        return { kind: "ok", value: "" } as ClientOutcome;
      },
    };
  };

  it("sends nothing while no stream is held, whether the pane follows no session or its lane is off", async () => {
    const { sent, send } = sends();
    const failures: string[] = [];
    await reportPointer(
      null,
      send,
      () => facts,
      (m) => failures.push(m),
    );
    await reportPointer(
      { sessionId: "s", wire: { attached: false } },
      send,
      () => facts,
      (m) => failures.push(m),
    );
    expect(sent).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("sends the facts as they stand while the stream is held, and says a failure it meets", async () => {
    const { sent, send } = sends();
    const followed = { sessionId: "s", wire: { attached: true } };
    await reportPointer(
      followed,
      send,
      () => facts,
      () => {},
    );
    expect(sent).toEqual(["s"]);
    const failures: string[] = [];
    await reportPointer(
      followed,
      async () =>
        ({ kind: "busy", phase: "deadline", message: "slow" }) as ClientOutcome,
      () => facts,
      (m) => failures.push(m),
    );
    expect(failures).toEqual([
      expect.stringContaining("pointer report failed: daemon busy (slow)"),
    ]);
  });
});

describe("bar-pane arguments", () => {
  it("take one pane id", () => {
    expect(parseArgs(["%3"])).toEqual({ pane: "%3" });
  });

  it.each([[[]], [["3"]], [["%3", "%4"]], [["%3", "--fps", "20"]]])(
    "refuse %j with the usage line",
    (argv) => {
      expect(() => parseArgs(argv)).toThrow(/usage: cc-candybar bar-pane/);
    },
  );
});
