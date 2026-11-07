// candybar-gather-renderer-76bb.1dh.aom: a session runs in the tmux pane its
// client names only when the Claude Code that ran the client holds it, by its
// own record, so a client run inside the pane under any other session does not
// take the pane's status line or bar pane.

import { LANE_NAMES, type LaneSwitches } from "../../src/config/lanes";
import type { ClientHints } from "../../src/daemon/protocol";
import {
  paneFact,
  runsNowIn,
  sessionPaneError,
  sessionPaneOf,
  type HeldSession,
  type HeldSessionOf,
} from "../../src/daemon/session-pane";
import type { TmuxHint } from "../../src/tmux-hint";
import { CLAUDE_START } from "../helpers/claude-record";

const TMUX: TmuxHint = { socket: "/tmp/tmux-501/default", pane: "%7", truecolor: null };
const CLAUDE = 4242;
const BY = { pid: CLAUDE, startTime: CLAUDE_START, configDir: undefined };
// What every unread parent's why ends with: the likely cause and its fix.
const WRAPPED = ". A statusline command that runs the client through a shell or a wrapper (a script, `pnpm dlx`) hands it that process instead: `cc-candybar install` writes one that runs it directly";

// Claude Code's records, by pid and configuration directory, as a fake of
// the port: every read it is asked for is kept, so a case can say none was.
// Whether a record names the process's start is the reader's to judge
// (test/lane-edge-held-session.test.ts).
const records = (held: Record<string, HeldSession>) => {
  const asked: Array<[number, string | undefined]> = [];
  const of: HeldSessionOf = ({ pid, configDir }) => {
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
  parent: { pid: CLAUDE, startTime: CLAUDE_START },
  ...over,
});

const lanes = (...on: string[]): LaneSwitches =>
  Object.fromEntries(LANE_NAMES.map((lane) => [lane, on.includes(lane)])) as LaneSwitches;

describe("sessionPaneOf", () => {
  test("a session the Claude Code that ran its client holds runs in the client's pane", () => {
    const { of } = records({ [`${CLAUDE}@default`]: holds("s1") });
    const pane = sessionPaneOf(hints({}), "s1", of);
    expect(pane).toEqual({ kind: "runs", tmux: TMUX, claude: BY });
    expect(paneFact(pane)).toBe("runs");
  });

  test("the record is read in the configuration directory the client names", () => {
    const { of, asked } = records({ [`${CLAUDE}@/home/u/.claude.zai`]: holds("s1") });
    const pane = sessionPaneOf(hints({ claudeConfigDir: "/home/u/.claude.zai" }), "s1", of);
    expect(pane).toMatchObject({ kind: "runs", claude: { ...BY, configDir: "/home/u/.claude.zai" } });
    expect(asked).toEqual([[CLAUDE, "/home/u/.claude.zai"]]);
  });

  test("a request whose Claude Code holds another session is mismatched", () => {
    const { of } = records({ [`${CLAUDE}@default`]: holds("real") });
    const pane = sessionPaneOf(hints({}), "test-1", of);
    expect(pane).toEqual({
      kind: "mismatched",
      tmux: TMUX,
      claude: BY,
      held: "real",
      why: `the Claude Code that ran its statusline (pid ${CLAUDE}) holds session real`,
    });
  });

  test("a client whose parent keeps no record, as a shell in the pane, is not the pane's", () => {
    const { of } = records({});
    const pane = sessionPaneOf(hints({ parent: { pid: 999, startTime: CLAUDE_START } }), "test-1", of);
    expect(pane.kind).toBe("unconfirmed");
    expect(paneFact(pane)).toBe(
      `unconfirmed: the process that ran its statusline (pid 999) is no Claude Code whose session can be read: it keeps no session record for 999${WRAPPED}`,
    );
  });

  test("a client too old to name its parent is not the pane's, and no record is read", () => {
    const { of, asked } = records({ [`${CLAUDE}@default`]: holds("s1") });
    const pane = sessionPaneOf({ tmux: TMUX }, "s1", of);
    expect(pane.kind).toBe("unconfirmed");
    expect(paneFact(pane)).toMatch(/^unconfirmed: its client is too old to say which process ran it/);
    expect(asked).toEqual([]);
  });

  test("a client that could not read when its parent started is not the pane's, and no record is read", () => {
    const { of, asked } = records({ [`${CLAUDE}@default`]: holds("s1") });
    const pane = sessionPaneOf(hints({ parent: { pid: CLAUDE, startTime: null } }), "s1", of);
    expect(paneFact(pane)).toBe(`unconfirmed: its client could not read when the process that ran it (pid ${CLAUDE}) started`);
    expect(asked).toEqual([]);
  });

  test("a session its record holds outside tmux runs outside, and one it does not is unconfirmed there too", () => {
    const { of } = records({ [`${CLAUDE}@default`]: holds("s1") });
    for (const tmux of [null, undefined]) {
      const pane = sessionPaneOf(hints({ tmux }), "s1", of);
      expect(pane).toEqual({ kind: "runs", tmux: null, claude: BY });
      expect(paneFact(pane)).toBe("outside");
      expect(sessionPaneOf(hints({ tmux, parent: { pid: 999, startTime: CLAUDE_START } }), "s1", of)).toMatchObject({ kind: "unconfirmed", tmux: null });
    }
  });

});

describe("runsNowIn", () => {
  test("reads the record at the lookup, so a request that arrived before its /clear's rewrite runs in its pane once the record names it", () => {
    const held: Record<string, HeldSession> = { [`${CLAUDE}@default`]: holds("before") };
    const { of } = records(held);
    const req = { hints: hints({}), sessionId: "after" };
    expect(sessionPaneOf(req.hints, req.sessionId, of).kind).toBe("mismatched");
    held[`${CLAUDE}@default`] = holds("after");
    expect(runsNowIn(TMUX, of)(req)).toBe(true);
    expect(runsNowIn(TMUX, of)({ ...req, sessionId: "before" })).toBe(false);
  });

  test("a request naming another pane, or none, runs in none of this one's, and no record is read for it", () => {
    const { of, asked } = records({ [`${CLAUDE}@default`]: holds("s1") });
    expect(runsNowIn({ socket: TMUX.socket, pane: "%8" }, of)({ hints: hints({}), sessionId: "s1" })).toBe(false);
    expect(runsNowIn({ socket: "/tmp/other", pane: "%7" }, of)({ hints: hints({}), sessionId: "s1" })).toBe(false);
    expect(runsNowIn(TMUX, of)({ hints: hints({ tmux: null }), sessionId: "s1" })).toBe(false);
    expect(asked).toEqual([]);
  });

  test("one lookup reads each record once, whatever number of its sessions it weighs", () => {
    const { of, asked } = records({ [`${CLAUDE}@default`]: holds("s3") });
    const lookup = runsNowIn(TMUX, of);
    expect(["s1", "s2", "s3"].map((sessionId) => lookup({ hints: hints({}), sessionId }))).toEqual([false, false, true]);
    expect(asked).toEqual([[CLAUDE, undefined]]);
  });
});

// A tick of `sessionId` from the pane's Claude Code, whose record holds `held`.
const tick = (sessionId: string, held: string) =>
  sessionPaneOf(hints({}), sessionId, records({ [`${CLAUDE}@default`]: holds(held) }).of);

describe("sessionPaneError", () => {
  const unconfirmed = sessionPaneOf(hints({ parent: { pid: 999, startTime: CLAUDE_START } }), "test-1", records({}).of);

  test("says why while a lane that shows the pane's session is on", () => {
    expect(sessionPaneError(unconfirmed, lanes("tmuxStatus"), false)).toBe(
      `The tmux status line of pane %7 shows the session the pane's Claude Code holds, and this one is not known to be it: the process that ran its statusline (pid 999) is no Claude Code whose session can be read: it keeps no session record for 999${WRAPPED}`,
    );
    expect(sessionPaneError(unconfirmed, lanes("pane", "tmuxStatus"), false)).toMatch(
      /^The 🧪 tmux pane \(C\) and tmux status line of pane %7 /,
    );
  });

  test("says nothing of a /clear's straggler or forerunner inside the race, whose render line still says why", () => {
    for (const [sessionId, held] of [["before", "after"], ["after", "before"]] as const) {
      const mismatched = tick(sessionId, held);
      expect(sessionPaneError(mismatched, lanes("pane", "tmuxStatus"), false)).toBeNull();
      expect(paneFact(mismatched)).toBe(`mismatched: the Claude Code that ran its statusline (pid ${CLAUDE}) holds session ${held}`);
    }
  });

  test("names the session the record holds once its mismatch has lasted past the race", () => {
    const mismatched = tick("new", "old");
    expect(sessionPaneError(mismatched, lanes("pane"), true)).toBe(
      `The 🧪 tmux pane (C) of pane %7 shows the session the pane's Claude Code holds, and this one is not it: the Claude Code that ran its statusline (pid ${CLAUDE}) holds session old, for longer than a \`/clear\` or \`/resume\` takes to rewrite it`,
    );
    expect(sessionPaneError(mismatched, lanes("band", "statusline"), true)).toBeNull();
    expect(sessionPaneError({ ...mismatched, tmux: null }, lanes("pane"), true)).toBeNull();
  });

  test("says nothing while no such lane is on, or of a session that runs in its pane", () => {
    expect(sessionPaneError(unconfirmed, lanes(), false)).toBeNull();
    expect(sessionPaneError(unconfirmed, lanes("band", "statusline"), false)).toBeNull();
    const runs = tick("s1", "s1");
    expect(sessionPaneError(runs, lanes("pane", "tmuxStatus"), false)).toBeNull();
    expect(sessionPaneError({ ...runs, tmux: null }, lanes("pane", "tmuxStatus"), false)).toBeNull();
    expect(sessionPaneError({ kind: "unconfirmed", tmux: null, why: "w" }, lanes("pane", "tmuxStatus"), false)).toBeNull();
  });
});
