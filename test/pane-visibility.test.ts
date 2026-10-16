// Which tmux panes a client is showing (src/daemon/pane-visibility.ts): the
// pure reading of `tmux list-panes`, and the poller's answers — a session is
// shown unless its server said otherwise, and a change is announced once.

import { PaneVisibility, shownPanes } from "../src/daemon/pane-visibility";
import type { TmuxRun } from "../src/proc/tmux";

const hint = (socket: string, pane: string) => ({
  socket,
  pane,
  truecolor: null,
});

describe("shownPanes", () => {
  test("a pane is shown in its session's current window, while a client is attached", () => {
    const out = [
      "%1 1 1 0 1", // shown
      "%2 1 1 0 0", // shown: a split pane beside the active one
      "%3 1 0 0 1", // another window of that session
      "%4 0 1 0 1", // a session nobody is attached to
      "%5 2 1 1 1", // zoomed, and the active pane: shown
      "%6 2 1 1 0", // zoomed under another pane
      "",
    ].join("\n");
    expect([...shownPanes(out)].sort()).toEqual(["%1", "%2", "%5"]);
  });
});

describe("PaneVisibility", () => {
  function harness(answers: Record<string, TmuxRun>) {
    const changes: number[] = [];
    const log: string[] = [];
    const visibility = new PaneVisibility({
      listPanes: (socket) => Promise.resolve(answers[socket]!),
      onChange: () => changes.push(1),
      log: (_level, line) => log.push(line),
    });
    return { visibility, changes, log, answers };
  }

  test("a session outside tmux, or on a server not yet asked, counts as shown", () => {
    const { visibility } = harness({});
    expect(visibility.shown(null)).toBe(true);
    expect(visibility.shown(undefined)).toBe(true);
    expect(visibility.shown(hint("/s", "%1"))).toBe(true);
  });

  test("an asked server's answer decides, and only a change is announced", async () => {
    const h = harness({
      "/s": { kind: "ok", stdout: "%1 1 1 0 1\n%2 0 1 0 1\n" },
    });
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
    expect(h.visibility.shown(hint("/s", "%2"))).toBe(false);
    expect(h.changes).toHaveLength(1);
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.changes).toHaveLength(1);
    h.answers["/s"] = { kind: "ok", stdout: "%2 1 1 0 1\n" };
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%2"))).toBe(true);
    expect(h.changes).toHaveLength(2);
    expect(h.log).toEqual([
      'visibility socket="/s" shown=%1',
      'visibility socket="/s" shown=%2',
    ]);
  });

  test("a server that cannot be asked shows every pane, and says why once", async () => {
    const h = harness({ "/s": { kind: "ok", stdout: "%1 0 1 0 1\n" } });
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
    const h = harness({ "/s": { kind: "ok", stdout: "%1 0 1 0 1\n" } });
    await h.visibility.refresh(new Set(["/s"]));
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(false);
    await h.visibility.refresh(new Set());
    expect(h.visibility.shown(hint("/s", "%1"))).toBe(true);
  });
});
