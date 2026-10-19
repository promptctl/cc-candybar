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

describe("PaneVisibility", () => {
  // `answerMs` holds each list-panes answer back that long; `asks` counts
  // them and `inFlight`/`overlap` record whether two were ever out at once.
  function harness(answers: Record<string, TmuxRun>, answerMs = 0) {
    const changes: string[][] = [];
    const log: string[] = [];
    const counts = { asks: 0, inFlight: 0, overlap: false };
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
      sockets: () => new Set(Object.keys(answers)),
      onChange: (sockets) => changes.push([...sockets]),
      intervalMs: 20,
      log: (_level, line) => log.push(line),
    });
    return { visibility, changes, log, answers, counts };
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
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    expect(h.visibility.shown(hint("/s", "%2"))).toBe(false);
    expect(h.changes).toHaveLength(1);
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.changes).toHaveLength(1);
    h.answers["/s"] = { kind: "ok", stdout: "%2 $2 1 1 0 1\n" };
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%2"))).toBe(true);
    expect(h.changes).toEqual([["/s"], ["/s"]]);
    expect(h.log).toEqual([
      'visibility socket="/s" shown=%1',
      'visibility socket="/s" shown=%2',
    ]);
  });

  test("a server that cannot be asked shows every pane, and says why once", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } });
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    h.answers["/s"] = {
      kind: "failed",
      reason: "tmux list-panes failed (no server)",
    };
    await h.visibility.refresh(new Set(["/s"]));
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    expect(h.log.filter((l) => l.includes("unasked"))).toHaveLength(1);
  });

  test("a server no watched session is on is forgotten", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } });
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    await h.visibility.refresh(new Set());
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
  });

  test("follow asks at once and each interval after, never twice at once, until it stops", async () => {
    // Each answer takes longer than the interval.
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } }, 30);
    const stop = h.visibility.follow();
    // A second follow while the loop runs starts no second loop.
    h.visibility.follow();
    await sleep(10);
    expect(h.counts.asks).toBe(1);
    await sleep(150);
    const asked = h.counts.asks;
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(h.counts.overlap).toBe(false);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    stop();
    await sleep(100);
    // The ask in flight at the stop may answer; no other is made, and the
    // stopped loop keeps no server's answer.
    expect(h.counts.asks).toBeLessThanOrEqual(asked + 1);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    // One start and one stop, the stop naming the answers it dropped.
    expect(h.log.filter((l) => !l.startsWith("visibility socket="))).toEqual([
      "visibility following",
      "visibility stopped forgot=1",
    ]);
  });

  test("an answer that arrives after the stop does not stand, and a follow at once after it waits its turn", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 $1 0 1 0 1\n" } }, 30);
    const stop = h.visibility.follow();
    await sleep(5);
    stop();
    await sleep(60);
    expect(h.counts.asks).toBe(1);
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    // Stopped and followed again while an ask is out: the loop carries on
    // from that ask rather than starting a second beside it.
    const again = h.visibility.follow();
    await sleep(5);
    again();
    const resumed = h.visibility.follow();
    await sleep(100);
    resumed();
    expect(h.counts.overlap).toBe(false);
    expect(h.counts.asks).toBeGreaterThanOrEqual(3);
  });
});
