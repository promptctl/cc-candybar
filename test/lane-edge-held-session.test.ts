// [LAW:one-source-of-truth] The session a restart's Claude Code holds is read
// from the record Claude Code keeps of its process, on the disk, where the
// record lives, and only when the record names the process's start: a record
// an exited Claude Code left under a pid since reused is not the live
// process's (candybar-gather-renderer-76bb.1dh.ycm).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { heldSessionIn, heldSessionUnder } from "../src/daemon/lane-edge";
import type { StartToken } from "../src/daemon/process-fingerprint";
import { sessionPaneError, sessionPaneOf } from "../src/daemon/session-pane";
import { LANE_NAMES, type LaneSwitches } from "../src/config/lanes";
import { CLAUDE_START } from "./helpers/claude-record";

const SID = "3819990b-dd3f-4b32-ab79-c817debfc940";
// The process at pid 4242 now: the one whose record it is, unless a case says.
const LIVE = { pid: 4242, startTime: CLAUDE_START };
// A later process the kernel handed the same pid: a shell, say.
const LATER = "Sat Nov  7 09:30:00 2026" as StartToken;

describe("a Claude Code process's session record", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-session-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file: string, text: string): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  const record = (fields: object): string =>
    write(path.join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SID, status: "idle", ...fields }));

  test("names the session its process holds, when it names the process's start", () => {
    const file = record({ procStart: CLAUDE_START });
    expect(heldSessionIn(file, LIVE)).toEqual({ kind: "holds", sessionId: SID });
  });

  test("an exited Claude Code left, under a pid a later process holds, is unread, naming both starts", () => {
    const file = record({ procStart: CLAUDE_START });
    expect(heldSessionIn(file, { pid: 4242, startTime: LATER })).toEqual({
      kind: "unread",
      why: `its session record ${file} was left by a Claude Code that has exited: the record names a process started ${CLAUDE_START}, and pid 4242 is a process started ${LATER}`,
    });
  });

  test.each([
    ["missing", null, (file: string) => expect.stringMatching(new RegExp(`^it keeps no session record at ${file} \\(update Claude Code`))],
    ["not JSON", "{\"pid\": 42", (file: string) => expect.stringContaining(`its session record ${file} is not JSON (`)],
    ["without a session", JSON.stringify({ pid: 4242, procStart: CLAUDE_START }), (file: string) => `its session record ${file} names no session`],
    ["not an object", "42", (file: string) => `its session record ${file} names no session`],
    [
      "without a process start",
      JSON.stringify({ pid: 4242, sessionId: SID }),
      (file: string) => `its session record ${file} names no process start (update Claude Code with \`claude update\`: recent releases name one)`,
    ],
    // Not an exited Claude Code's: a start this reader cannot compare says so.
    [
      "with a start not in the form ps prints",
      JSON.stringify({ pid: 4242, sessionId: SID, procStart: "2026-11-06T02:12:23Z" }),
      (file: string) => `its session record ${file} names its process start as "2026-11-06T02:12:23Z", not in the form \`ps -o lstart=\` prints it`,
    ],
  ])("%s, is said as unread, never as a session", (_case, text, why) => {
    const file = path.join(dir, "4242.json");
    if (text !== null) write(file, text);
    expect(heldSessionIn(file, LIVE)).toEqual({ kind: "unread", why: why(file) });
  });

  // The client names Claude Code's configuration directory only when
  // CLAUDE_CONFIG_DIR set one; otherwise it is the user's ~/.claude.
  test("is read for the pid under the client's configuration directory, else under the user's home", () => {
    const heldSession = heldSessionUnder(dir);
    write(path.join(dir, ".claude", "sessions", "4242.json"), JSON.stringify({ sessionId: "default-dir", procStart: CLAUDE_START }));
    write(path.join(dir, "zai", "sessions", "4242.json"), JSON.stringify({ sessionId: "named-dir", procStart: CLAUDE_START }));
    expect(heldSession({ ...LIVE, configDir: undefined })).toEqual({ kind: "holds", sessionId: "default-dir" });
    expect(heldSession({ ...LIVE, configDir: path.join(dir, "zai") })).toEqual({ kind: "holds", sessionId: "named-dir" });
  });

  // The ticket's case, through the stamp: a shell or wrapper that ran the
  // client under the pid an exited Claude Code's record still names.
  test("a request from a later process under the record's pid is unconfirmed, and its pane's lane says the wrapper fix", () => {
    const configDir = path.join(dir, ".claude");
    write(path.join(configDir, "sessions", "4242.json"), JSON.stringify({ sessionId: SID, procStart: CLAUDE_START }));
    const tmux = { socket: "/tmp/tmux-501/default", pane: "%7", truecolor: null };
    const pane = sessionPaneOf({ tmux, parent: { pid: 4242, startTime: LATER }, claudeConfigDir: configDir }, SID, heldSessionUnder(dir));
    expect(pane).toMatchObject({ kind: "unconfirmed" });
    const lanes = Object.fromEntries(LANE_NAMES.map((lane) => [lane, lane === "tmuxStatus"])) as LaneSwitches;
    expect(sessionPaneError(pane, lanes, false)).toBe(
      `The tmux status line of pane %7 shows the session the pane's Claude Code holds, and this one is not known to be it: the process that ran its statusline (pid 4242) is no Claude Code whose session can be read: its session record ${path.join(configDir, "sessions", "4242.json")} was left by a Claude Code that has exited: the record names a process started ${CLAUDE_START}, and pid 4242 is a process started ${LATER}. A statusline command that runs the client through a shell or a wrapper (a script, \`pnpm dlx\`) hands it that process instead: \`cc-candybar install\` writes one that runs it directly`,
    );
  });
});
