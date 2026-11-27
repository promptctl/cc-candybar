// `cc-candybar bar-pane` (src/bar-pane): what it paints, where it stands in
// tmux, and the arguments it takes. The frames themselves are the daemon's push,
// covered by test/frame-feed.test.ts and test/daemon-frame-feed-e2e.test.ts.

import { parseArgs, tmuxPatience } from "../../src/bar-pane";
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
  // The flight is promises only, so every run it owes finishes within these
  // microtask turns: no clock is needed to wait for it.
  const settled = async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  };

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
  it("takes a source and exact managed instance", () => {
    const instance="ef584b38-1144-4257-9bc2-7f1b01c773ec";
    expect(parseArgs(["%3",instance])).toEqual({ pane: "%3", instance });
  });

  it.each([[[]], [["3"]], [["%3", "%4"]], [["%3", "--fps", "20"]]])(
    "refuse %j with the usage line",
    (argv) => {
      expect(() => parseArgs(argv)).toThrow(/usage: cc-candybar bar-pane/);
    },
  );
});
