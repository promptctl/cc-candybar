// Which tmux panes a client is showing (src/daemon/pane-visibility.ts): the
// pure reading of `tmux list-panes`, and the poller's answers — a session is
// shown unless its server said otherwise, and a change is announced once.

import {
  PaneVisibility,
  controlledSessions,
  shownPanes,
} from "../src/daemon/pane-visibility";
import type { TmuxRun } from "../src/proc/tmux";

const hint = (socket: string, pane: string) => ({
  socket,
  pane,
  truecolor: null,
});

describe("shownPanes", () => {
  test("a pane is shown in its session's current window, while a client is attached", () => {
    const out = [
      "%1 $1 1 1 0 1", // shown
      "%2 $1 1 1 0 0", // shown: a split pane beside the active one
      "%3 $1 1 0 0 1", // another window of that session
      "%4 $2 0 1 0 1", // a session nobody is attached to
      "%5 $3 2 1 1 1", // zoomed, and the active pane: shown
      "%6 $3 2 1 1 0", // zoomed under another pane
      "",
    ].join("\n");
    expect([...shownPanes(out, new Set())].sort()).toEqual(["%1", "%2", "%5"]);
  });

  test("every window of a session a control-mode client draws can be on screen", () => {
    const clients = ["$1 1", "$2 0", ""].join("\n");
    expect([...controlledSessions(clients)]).toEqual(["$1"]);
    const out = [
      "%1 $1 1 0 0 1", // another window, drawn natively by tmux -CC
      "%2 $1 1 0 1 0", // zoomed under another pane, still hidden
      "%3 $2 1 0 0 1", // another window of a plainly attached session
      "",
    ].join("\n");
    expect([...shownPanes(out, controlledSessions(clients))]).toEqual(["%1"]);
  });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The loop's clock is faked: each test passes its time, so a count of asks is
// exact rather than a guess at what a loaded machine fits in a wall-clock wait.
describe("PaneVisibility", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const INTERVAL_MS = 1000;
  // Lets the loop's clock run `ms` on, every ask that falls due answering.
  const pass = (ms: number): Promise<void> => jest.advanceTimersByTimeAsync(ms);

  // `sockets` is the servers the loop is told to ask, and reading them throws
  // while `readFails` is set. `answerMs` holds each
  // list-panes answer back that long; `asks` counts them and `overlap`
  // records whether two were ever out at once.
  function harness(answers: Record<string, TmuxRun>, answerMs = 0) {
    const changes: string[][] = [];
    const log: string[] = [];
    const sockets = new Set(Object.keys(answers));
    const counts = { asks: 0, inFlight: 0, overlap: false, readFails: false };
    const visibility = new PaneVisibility({
      listPanes: async (socket) => {
        counts.asks++;
        counts.inFlight++;
        if (counts.inFlight > 1) counts.overlap = true;
        if (answerMs > 0) await sleep(answerMs);
        counts.inFlight--;
        return answers[socket]!;
      },
      listClients: () => Promise.resolve({ kind: "ok", stdout: "" } as TmuxRun),
      sockets: () => {
        if (counts.readFails) throw new Error("the read broke");
        return sockets;
      },
      onChange: (changed) => changes.push([...changed]),
      intervalMs: INTERVAL_MS,
      log: (_level, line) => log.push(line),
    });
    const serverLog = () => log.filter((l) => l.startsWith("visibility socket="));
    return { visibility, changes, log, serverLog, answers, sockets, counts };
  }

  test("a session outside tmux, or on a server not yet asked, counts as shown", () => {
    const { visibility } = harness({});
    expect(visibility.shown(null)).toBe(true);
    expect(visibility.shown(undefined)).toBe(true);
    expect(visibility.shown(hint("/s", "%1"))).toBe(true);
  });

  test("an asked server's answer decides, and only a change is announced", async () => {
    const h = harness({
      "/s": { kind: "ok", stdout: "%1 $1 1 1 0 1\n%2 $2 0 1 0 1\n" },
    });
    const stop = h.visibility.follow();
    await pass(0);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    expect(h.visibility.shown(hint("/s", "%2"))).toBe(false);
    expect(h.changes).toHaveLength(1);
    await pass(INTERVAL_MS);
    expect(h.changes).toHaveLength(1);
    h.answers["/s"] = { kind: "ok", stdout: "%2 $2 1 1 0 1\n" };
    await pass(INTERVAL_MS);
    stop();
    expect(h.changes).toEqual([["/s"], ["/s"]]);
    expect(h.serverLog()).toEqual([
      'visibility socket="/s" shown=%1',
      'visibility socket="/s" shown=%2',
    ]);
  });

  test("a server that cannot be asked shows every pane, and says why once", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } });
    const stop = h.visibility.follow();
    await pass(0);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    h.answers["/s"] = {
      kind: "failed",
      reason: "tmux list-panes failed (no server)",
    };
    await pass(2 * INTERVAL_MS);
    stop();
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    expect(h.log.filter((l) => l.includes("unasked"))).toHaveLength(1);
  });

  test("a server no watched session is on is forgotten", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } });
    const stop = h.visibility.follow();
    await pass(0);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    h.sockets.delete("/s");
    await pass(INTERVAL_MS);
    stop();
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
  });

  test("a throw reading which servers to ask is logged, and the loop goes on", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } });
    h.counts.readFails = true;
    const stop = h.visibility.follow();
    await pass(0);
    expect(h.log.filter((l) => l.includes("refresh threw"))).toEqual([
      expect.stringContaining("the read broke"),
    ]);
    h.counts.readFails = false;
    await pass(INTERVAL_MS);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    stop();
  });

  test("follow asks at once and each interval after, never twice at once, until it stops", async () => {
    // Each answer takes longer than the interval: the next ask is due an
    // interval after the last answered, at 0, 2500 and 5000 ms.
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } }, 1500);
    const stop = h.visibility.follow();
    // A second follow while the loop runs starts no second loop.
    h.visibility.follow();
    await pass(10);
    expect(h.counts.asks).toBe(1);
    await pass(5090);
    expect(h.counts.asks).toBe(3);
    expect(h.counts.overlap).toBe(false);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    // Stopped with an ask out: it answers, and no other is made.
    stop();
    await pass(10 * INTERVAL_MS);
    expect(h.counts.asks).toBe(3);
    // The stopped loop keeps no timer and no server's answer.
    expect(jest.getTimerCount()).toBe(0);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    // One start and one stop, the stop naming the answers it dropped.
    expect(h.log.filter((l) => !l.startsWith("visibility socket="))).toEqual([
      "visibility following",
      "visibility stopped forgot=1",
    ]);
  });

  test("an answer that arrives after the stop does not stand, and a follow at once after it waits its turn", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } }, 1500);
    const stop = h.visibility.follow();
    await pass(5);
    stop();
    await pass(3000);
    expect(h.counts.asks).toBe(1);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    // Stopped and followed again while an ask is out: the loop carries on
    // from that ask rather than starting a second beside it.
    const again = h.visibility.follow();
    await pass(5);
    again();
    const resumed = h.visibility.follow();
    await pass(10 * INTERVAL_MS);
    resumed();
    expect(h.counts.overlap).toBe(false);
    // The one before the stop, then from the follow at 3005 ms an ask every
    // 2500 ms through 13005.
    expect(h.counts.asks).toBe(6);
  });
});
