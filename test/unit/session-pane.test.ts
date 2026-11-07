// candybar-gather-renderer-76bb.1dh.aom: a session runs in the tmux pane its
// client names only when the Claude Code that ran the client holds it, by its
// own record, so a client run inside the pane under any other session does not
// take the pane's status line or bar pane.

import { LANE_NAMES, type LaneSwitches } from "../../src/config/lanes";
import type { ClientHints } from "../../src/daemon/protocol";
import {
  paneFact,
  runningPane,
  runsIn,
  sessionPaneError,
  sessionPaneOf,
  type HeldSession,
  type HeldSessionOf,
} from "../../src/daemon/session-pane";
import type { TmuxHint } from "../../src/tmux-hint";

const TMUX: TmuxHint = { socket: "/tmp/tmux-501/default", pane: "%7", truecolor: null };
const CLAUDE = 4242;

// Claude Code's records, by pid and configuration directory, as a fake of
// the port: every read it is asked for is kept, so a case can say none was.
const records = (held: Record<string, HeldSession>) => {
  const asked: Array<[number, string | undefined]> = [];
  const of: HeldSessionOf = (pid, configDir) => {
    asked.push([pid, configDir]);
    return (
      held[`${pid}@${configDir ?? "default"}`] ?? {
        kind: "unread",
        why: `it keeps no session record for ${pid}`,
      }
    );
  };
  return { of, asked };
};
const holds = (sessionId: string): HeldSession => ({ kind: "holds", sessionId });

const hints = (over: Partial<ClientHints>): ClientHints => ({
  tmux: TMUX,
  parentPid: CLAUDE,
  ...over,
});

const lanes = (...on: string[]): LaneSwitches =>
  Object.fromEntries(LANE_NAMES.map((lane) => [lane, on.includes(lane)])) as LaneSwitches;

describe("sessionPaneOf", () => {
  test("a session the Claude Code that ran its client holds runs in the client's pane", () => {
    const { of } = records({ [`${CLAUDE}@default`]: holds("s1") });
    const pane = sessionPaneOf(hints({}), "s1", of);
    expect(pane).toEqual({ kind: "runs", tmux: TMUX });
    expect(paneFact(pane)).toBe("runs");
    expect(runningPane(pane)).toBe(TMUX);
    expect(runsIn(pane, { socket: TMUX.socket, pane: "%7" })).toBe(true);
    expect(runsIn(pane, { socket: TMUX.socket, pane: "%8" })).toBe(false);
    expect(runsIn(pane, { socket: "/tmp/other", pane: "%7" })).toBe(false);
  });

  test("the record is read in the configuration directory the client names", () => {
    const { of, asked } = records({ [`${CLAUDE}@/home/u/.claude.zai`]: holds("s1") });
    const pane = sessionPaneOf(hints({ claudeConfigDir: "/home/u/.claude.zai" }), "s1", of);
    expect(pane.kind).toBe("runs");
    expect(asked).toEqual([[CLAUDE, "/home/u/.claude.zai"]]);
  });

  test("a client run in the pane under another session is not the pane's", () => {
    const { of } = records({ [`${CLAUDE}@default`]: holds("real") });
    const pane = sessionPaneOf(hints({}), "test-1", of);
    expect(pane).toEqual({
      kind: "unconfirmed",
      tmux: TMUX,
      why: `the Claude Code that ran its statusline (pid ${CLAUDE}) holds session real`,
    });
    expect(runningPane(pane)).toBeNull();
    expect(runsIn(pane, TMUX)).toBe(false);
  });

  test("a client whose parent keeps no record, as a shell in the pane, is not the pane's", () => {
    const { of } = records({});
    const pane = sessionPaneOf(hints({ parentPid: 999 }), "test-1", of);
    expect(pane.kind).toBe("unconfirmed");
    expect(paneFact(pane)).toBe(
      "unconfirmed: the process that ran its statusline (pid 999) is no Claude Code whose session can be read: it keeps no session record for 999",
    );
  });

  test("a client too old to name its parent is not the pane's, and no record is read", () => {
    const { of, asked } = records({ [`${CLAUDE}@default`]: holds("s1") });
    const pane = sessionPaneOf({ tmux: TMUX }, "s1", of);
    expect(pane.kind).toBe("unconfirmed");
    expect(paneFact(pane)).toMatch(/^unconfirmed: its client is too old to say which process ran it/);
    expect(asked).toEqual([]);
  });

  test("a session outside tmux runs in no pane, and no record is read", () => {
    const { of, asked } = records({ [`${CLAUDE}@default`]: holds("s1") });
    for (const tmux of [null, undefined]) {
      const pane = sessionPaneOf(hints({ tmux }), "s1", of);
      expect(pane).toEqual({ kind: "outside" });
      expect(paneFact(pane)).toBe("outside");
      expect(runningPane(pane)).toBeNull();
    }
    expect(asked).toEqual([]);
  });
});

describe("sessionPaneError", () => {
  const unconfirmed = sessionPaneOf(hints({ parentPid: 999 }), "test-1", records({}).of);

  test("says why while a lane that shows the pane's session is on", () => {
    expect(sessionPaneError(unconfirmed, lanes("tmuxStatus"))).toBe(
      "The tmux status line of pane %7 shows the session the pane's Claude Code holds, and this one is not known to be it: the process that ran its statusline (pid 999) is no Claude Code whose session can be read: it keeps no session record for 999",
    );
    expect(sessionPaneError(unconfirmed, lanes("pane", "tmuxStatus"))).toMatch(
      /^The 🧪 tmux pane \(C\) and tmux status line of pane %7 /,
    );
  });

  test("says nothing while no such lane is on, or of a session that runs in its pane", () => {
    expect(sessionPaneError(unconfirmed, lanes())).toBeNull();
    expect(sessionPaneError(unconfirmed, lanes("band", "statusline"))).toBeNull();
    const runs = sessionPaneOf(hints({}), "s1", records({ [`${CLAUDE}@default`]: holds("s1") }).of);
    expect(sessionPaneError(runs, lanes("pane", "tmuxStatus"))).toBeNull();
    expect(sessionPaneError({ kind: "outside" }, lanes("pane", "tmuxStatus"))).toBeNull();
  });
});
