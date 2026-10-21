// brandon-menus-sjhy.amf — what a lane's toggle starts beyond the daemon's own
// gate, driven through fakes of every effect (src/daemon/lane-setup.ts), and
// the pure readers the production edge folds tmux's and ps's answers with
// (src/daemon/lane-edge.ts).

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  BAND_PLUGIN,
  BAR_PANE_OPTION,
  ATTACH_PATIENCE_MS,
  EXIT_PATIENCE_MS,
  LANE_SETUP,
  LaneSetups,
  relaunchScript,
  type LaneEdge,
  type LaneHost,
  type LaneOutcome,
  type LaneSession,
  type PaneClaude,
} from "../src/daemon/lane-setup";
import { relaunchArgs } from "../src/daemon/claude-relaunch";
import {
  claudeEnv,
  refusalOf,
  runsAttached,
  taggedBarPanes,
} from "../src/daemon/lane-edge";
import { draftShown, turnRunning } from "../src/claude-input/prompt-screen";
import { BadVerbArgs } from "../src/daemon/verb-error";
import { SessionState } from "../src/daemon/session-state";
import { holdClickError } from "../src/daemon/click-error";
import { instantOf } from "../src/utils/instant";
import type { Lane, LaneSwitches } from "../src/config/lanes";
import type { TmuxHint } from "../src/tmux-hint";

const SID = "1f6e0c2a-0d0e-4a52-9d1b-2b0b0f0e0a11";
const TMUX: TmuxHint = { socket: "/tmp/tmux-1/default", pane: "%7", truecolor: null };
const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];

// A checkout: `src/` beside `dist/`, the native client built.
function checkout(): { root: string; bundle: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-checkout-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "dist"));
  return { root, bundle: path.join(root, "dist", "index.mjs") };
}

const session = (hints: LaneSession["hints"] = { tmux: TMUX }): LaneSession => ({
  sessionId: SID,
  hints,
  origin: { projectDir: "/p", cwd: "/p", configFile: null },
  transcript: "/u/.claude/projects/-p/session.jsonl",
});

// Every effect recorded, in the order it ran.
function fakeEdge(over: Partial<LaneEdge> = {}): { edge: LaneEdge; did: string[] } {
  const did: string[] = [];
  const claude: PaneClaude = {
    pid: 4242,
    executable: "/u/.local/share/claude/versions/2.1.299",
    argv: ["claude", "--dangerously-skip-permissions", "--worktree"],
    cwd: "/work/tree",
    fromShell: true,
    attached: false,
  };
  const edge: LaneEdge = {
    claudeInput: {
      read: () => ({ inMode: false, screen: READY_SCREEN }),
      type: (_hint, line) => {
        did.push(`type ${line}`);
        return { kind: "typed" };
      },
    },
    barPanes: () => [],
    openBarPane: (hint, argv, env) => {
      did.push(`open under ${hint.pane}: ${argv.join(" ")} ${JSON.stringify(env)}`);
      return "%9";
    },
    closePane: (_hint, pane) => void did.push(`close ${pane}`),
    claude: async (args, dir) =>
      void did.push(`claude ${args.join(" ")} [${dir ?? "-"}]`),
    fileExists: () => true,
    paneClaude: async () => claude,
    writeScript: (name, text) => {
      const file = `/run/${name}`;
      did.push(`script ${file}:\n${text}`);
      return file;
    },
    removeScript: (file) => void did.push(`remove ${file}`),
    moduleGraph: async (node, reader, executable) => {
      did.push(`graph ${node} ${reader} ${executable}`);
      return { ok: true };
    },
    exited: async () => true,
    typeShellLine: (_hint, line) => void did.push(`shell ${line}`),
    followed: async (sessionId, lane) => {
      did.push(`followed ${sessionId} ${lane}`);
      return true;
    },
    ...over,
  };
  return { edge, did };
}

const HOST: LaneHost = {
  bundle: "/opt/candybar/dist/index.mjs",
  node: ["/usr/bin/node"],
  socket: "/tmp/cc-candybar-1/socket",
};

describe("lane C, pane", () => {
  test("on opens a bar pane under the session's pane, following this daemon", () => {
    const { edge, did } = fakeEdge();
    const out = LANE_SETUP.pane.on(session(), HOST, edge);
    expect(out).toEqual({ kind: "done", said: "opened bar pane %9 under %7" });
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
  });

  test("on with a bar pane already open opens no second one", () => {
    const { edge, did } = fakeEdge({ barPanes: () => ["%9"] });
    expect(LANE_SETUP.pane.on(session(), HOST, edge)).toEqual({
      kind: "done",
      said: "bar pane %9 already draws %7's bar",
    });
    expect(did).toEqual([]);
  });

  test("off in a session with no tmux pane has nothing to close, and says so", () => {
    const { edge, did } = fakeEdge();
    expect(LANE_SETUP.pane.off(session({ tmux: null }), HOST, edge)).toEqual({
      kind: "done",
      said: expect.stringMatching(/^no bar pane to close: .*not running inside tmux/),
    });
    expect(did).toEqual([]);
  });

  test("off closes every bar pane drawing the session's bar", () => {
    const { edge, did } = fakeEdge({ barPanes: () => ["%9", "%11"] });
    LANE_SETUP.pane.off(session(), HOST, edge);
    expect(did).toEqual(["close %9", "close %11"]);
  });

  test.each([
    [undefined, "predates this daemon"],
    [null, "not running inside tmux"],
  ])("a session with tmux hint %p is refused, saying why", (tmux, why) => {
    const { edge } = fakeEdge();
    expect(() => LANE_SETUP.pane.on(session({ tmux }), HOST, edge)).toThrow(
      new RegExp(why),
    );
  });
});

// The part of a setup that outlives its click.
function finished(out: LaneOutcome): Promise<string> {
  if (out.kind !== "underway") throw new Error(`expected underway: ${out.said}`);
  return out.finished;
}

describe("lane A, band", () => {
  test("on installs the band mod from the checkout's marketplace, then reloads plugins, off the click", async () => {
    const { root, bundle } = checkout();
    const { edge, did } = fakeEdge();
    const out = LANE_SETUP.band.on(
      session({ tmux: TMUX, claudeConfigDir: "/home/u/.claude" }),
      { ...HOST, bundle },
      edge,
    );
    await expect(finished(out)).resolves.toContain(
      `installed ${BAND_PLUGIN} from ${root}`,
    );
    expect(did).toEqual([
      `claude plugin marketplace add ${root} [/home/u/.claude]`,
      `claude plugin install ${BAND_PLUGIN} [/home/u/.claude]`,
      "type /reload-plugins",
    ]);
  });

  test("a daemon not run from a checkout is refused in the click, before anything is installed", () => {
    const { edge, did } = fakeEdge();
    expect(() => LANE_SETUP.band.on(session(), HOST, edge)).toThrow(BadVerbArgs);
    expect(did).toEqual([]);
  });

  test("an unbuilt native client is refused in the click, naming the build", () => {
    const { bundle } = checkout();
    const { edge, did } = fakeEdge({ fileExists: () => false });
    expect(() => LANE_SETUP.band.on(session(), { ...HOST, bundle }, edge)).toThrow(
      /just install-rust/,
    );
    expect(did).toEqual([]);
  });

  test("a prompt that is not ready leaves the mod installed and says so", async () => {
    const { bundle } = checkout();
    const { edge } = fakeEdge({
      claudeInput: {
        read: () => ({ inMode: true, screen: READY_SCREEN }),
        type: () => ({ kind: "typed" }),
      },
    });
    await expect(
      finished(LANE_SETUP.band.on(session(), { ...HOST, bundle }, edge)),
    ).rejects.toThrow(/installed, but \/reload-plugins was not typed: .*copy mode/);
  });
});

describe("lane B, statusline", () => {
  test("on exits Claude Code, then starts the binary it ran again under the launcher beside the bundle, on the same session", async () => {
    const { edge, did } = fakeEdge();
    const out = LANE_SETUP.statusline.on(session(), HOST, edge);
    // The click itself does nothing in the pane.
    expect(did).toEqual([]);
    await expect(finished(out)).resolves.toContain("its statusline follows lane B");
    expect(did).toEqual([
      "graph /usr/bin/node /opt/candybar/dist/cc-extra/src/bun-graph.js /u/.local/share/claude/versions/2.1.299",
      `script /run/relaunch-${SID}.sh:\n${relaunchScript(
        "/work/tree",
        [
          "/usr/bin/node",
          "/opt/candybar/dist/cc-extra/src/bun-attach.js",
          "/u/.local/share/claude/versions/2.1.299",
          "--dangerously-skip-permissions",
          "--resume",
          SID,
        ],
        undefined,
      )}`,
      "type /exit",
      `shell sh /run/relaunch-${SID}.sh`,
      `followed ${SID} statusline`,
      `remove /run/relaunch-${SID}.sh`,
    ]);
  });

  // The launcher starts nothing in place of an attach it could not make, so a
  // restart is confirmed only by the statusline following lane B again.
  test("a restart whose statusline never follows lane B again is a failure, and the script is still removed", async () => {
    const { edge, did } = fakeEdge({ followed: async () => false });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(
      `did not come back attached within ${ATTACH_PATIENCE_MS / 1000} s of its restart — the pane says why`,
    );
    expect(did.at(-1)).toBe(`remove /run/relaunch-${SID}.sh`);
  });

  test("a restart refused after its script is written still removes it", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/did not exit within/);
    expect(did.at(-1)).toBe(`remove /run/relaunch-${SID}.sh`);
  });

  test("a build with no launcher beside its bundle is refused before anything in the pane is touched", () => {
    const { edge, did } = fakeEdge({
      fileExists: (file) => !file.endsWith("bun-attach.js"),
    });
    expect(() => LANE_SETUP.statusline.on(session(), HOST, edge)).toThrow(
      /attach launcher, which is not at \/opt\/candybar\/dist\/cc-extra\/src\/bun-attach\.js/,
    );
    expect(did).toEqual([]);
  });

  // Claude Code writes a session's transcript with its first message; resuming
  // one with none finds no conversation and leaves the pane at its shell.
  test("a session with no conversation yet is refused before /exit is typed", () => {
    const { edge, did } = fakeEdge({
      fileExists: (file) => !file.endsWith(".jsonl"),
    });
    expect(() => LANE_SETUP.statusline.on(session(), HOST, edge)).toThrow(
      /no conversation to resume yet — send a first message/,
    );
    expect(did).toEqual([]);
  });

  test("a Claude Code that does not exit is not started again, and the wait says why", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(`did not exit within ${EXIT_PATIENCE_MS / 1000} s`);
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  // The screen of a session mid-turn, as tmux captured it (2.1.289): `/exit`
  // typed here would queue until the turn ends, after the wait gave up.
  test("a Claude Code in the middle of a turn is refused before /exit is typed", async () => {
    const { edge, did } = fakeEdge({
      claudeInput: {
        read: () => ({
          inMode: false,
          screen: [
            "✽ Processing… (26s · ↓ 2.0k tokens · thought for 15s)",
            ...READY_SCREEN,
          ],
        }),
        type: () => ({ kind: "typed" }),
      },
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/in the middle of a turn/);
    expect(did).toEqual([]);
  });

  // ctrl+s stashes a draft before `/exit`, and the stash ends with the
  // Claude Code holding it.
  test("a draft in the prompt is refused before /exit is typed", async () => {
    const { edge, did } = fakeEdge({
      claudeInput: {
        read: () => ({
          inMode: false,
          screen: [READY_SCREEN[0]!, "❯ half a thought", READY_SCREEN[2]!],
        }),
        type: () => ({ kind: "typed" }),
      },
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/holds a draft/);
    expect(did.some((d) => d.startsWith("type"))).toBe(false);
  });

  test.each([
    ["❯ ", false],
    ["❯\u00a0", false],
    ["❯ half a thought", true],
  ])("draftShown with the prompt row %j is %p", (row, draft) => {
    expect(
      draftShown({
        inMode: false,
        screen: [READY_SCREEN[0]!, row, READY_SCREEN[2]!],
      }),
    ).toBe(draft);
  });

  test.each([
    ["✽ Processing… (26s · ↓ 2.0k tokens · thought for 15s)", true],
    ["✻ Cogitating… (1m 4s · esc to interrupt)", true],
    ["  ⏺ I'll look at the file… (it is long)", false],
    ["❯ ", false],
  ])("turnRunning(%j) is %p", (line, running) => {
    expect(turnRunning({ inMode: false, screen: [line] })).toBe(running);
  });

  test("a Claude Code already under the attach launcher is left running", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        executable: "/bin/claude",
        argv: ["cc-attach"],
        cwd: "/",
        fromShell: true,
        attached: true,
      }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).resolves.toContain("already runs under the attach launcher");
    expect(did).toEqual([]);
  });

  test("a Claude Code that is its pane's first process is refused: nothing would restart it", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        executable: "/bin/claude",
        argv: ["claude"],
        cwd: "/",
        fromShell: false,
        attached: false,
      }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/first process of pane %7/);
    expect(did).toEqual([]);
  });

  // An npm install runs `node …/cli.js`: no module graph for the launcher to
  // run, so exiting it would leave the pane at its shell.
  test("a Claude Code the launcher cannot start is refused before /exit is typed", async () => {
    const { edge, did } = fakeEdge({
      moduleGraph: async () => ({
        ok: false,
        reason: "no-bun-module-graph-trailer",
      }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(
      /runs \/u\/\.local\/share\/claude\/versions\/2\.1\.299, which the attach launcher cannot start \(no-bun-module-graph-trailer\) — .*native Claude Code install .*left running/,
    );
    expect(did).toEqual([]);
  });

  test.each([
    ['{"ok":false,"reason":"no-bun-module-graph-trailer"}\n', "no-bun-module-graph-trailer"],
    ['{"ok":false,"reason":"binary-unreadable","detail":"EACCES"}', "binary-unreadable: EACCES"],
    ["", null],
    ["Error: Cannot find module", null],
    ['{"ok":true}', null],
  ])("the module graph reader's output %j refuses with %p", (stdout, reason) => {
    expect(refusalOf(stdout)).toBe(reason);
  });

  test("a flag cc-candybar cannot carry refuses the restart before /exit is typed", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        executable: "/bin/claude",
        argv: ["claude", "--brand-new-flag", "x"],
        cwd: "/",
        fromShell: true,
        attached: false,
      }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/--brand-new-flag/);
    expect(did.some((d) => d.startsWith("type"))).toBe(false);
  });

  test("a session with no tmux pane is refused in the click", () => {
    const { edge } = fakeEdge();
    expect(() =>
      LANE_SETUP.statusline.on(session({ tmux: null }), HOST, edge),
    ).toThrow(/not running inside tmux/);
  });

  test("off stops nothing", () => {
    const { edge, did } = fakeEdge();
    expect(LANE_SETUP.statusline.off(session(), HOST, edge).kind).toBe("done");
    expect(did).toEqual([]);
  });
});

describe("the restart script", () => {
  test("runs its argv, every word quoted, after leaving the shell's PATH out of it", () => {
    const script = relaunchScript(
      "/it's/here",
      ["/usr/bin/node", "/opt/l.js", "/bin/claude", "--model", "a b"],
      undefined,
    );
    expect(script.split("\n")).toEqual([
      `cd -- '/it'\\''s/here' || exit 1`,
      "unset CLAUDE_CONFIG_DIR",
      "exec '/usr/bin/node' '/opt/l.js' '/bin/claude' '--model' 'a b'",
      "",
    ]);
  });

  test("runs under sh, in Claude Code's directory, under the session's Claude Code directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-script-"));
    const record = path.join(dir, "ran");
    const launcher = path.join(dir, "launcher");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\npwd > ${record}\necho "$CLAUDE_CONFIG_DIR" >> ${record}\nprintf '%s\\n' "$@" >> ${record}\n`,
      { mode: 0o755 },
    );
    const self = path.join(dir, "r.sh");
    fs.writeFileSync(
      self,
      relaunchScript(
        dir,
        [launcher, "/bin/claude", "--model", "a b", "--resume", SID],
        "/u/.claude.zai",
      ),
    );
    const { status } = spawnSync("/bin/sh", [self], {
      // The pane's shell may export a directory of its own; the session's
      // wins. And nothing is looked up on its PATH.
      env: { PATH: "/nonexistent", CLAUDE_CONFIG_DIR: "/u/.claude" },
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(fs.readFileSync(record, "utf8").split("\n")).toEqual([
      dir,
      "/u/.claude.zai",
      "/bin/claude",
      "--model",
      "a b",
      "--resume",
      SID,
      "",
    ]);
  });
});

describe("relaunchArgs", () => {
  test.each([
    [["claude"], []],
    [["claude", "--dangerously-skip-permissions", "--worktree"], ["--dangerously-skip-permissions"]],
    [["claude", "-w", "feature", "--model", "opus"], ["--model", "opus"]],
    [["claude", "--resume", "old-id", "--verbose"], ["--verbose"]],
    [["claude", "-r", "--verbose"], ["--verbose"]],
    [["claude", "-c", "--session-id", "u", "--fork-session"], []],
    [["claude", "--add-dir", "a", "b", "--model=opus"], ["--add-dir", "a", "b", "--model=opus"]],
    [["claude", "fix the bug", "--effort", "high"], ["--effort", "high"]],
    [["claude", "--", "--not-a-flag"], []],
    [["claude", "--append-system-prompt", "-be terse"], ["--append-system-prompt", "-be terse"]],
  ])("%j starts again as %j and the session", (argv, kept) => {
    expect(relaunchArgs(argv, SID)).toEqual({
      kind: "args",
      args: [...kept, "--resume", SID],
    });
  });

  test.each([
    [["claude", "--mystery"], /--mystery/],
    [["claude", "--model"], /--model and no value/],
  ])("%j is refused", (argv, reason) => {
    const out = relaunchArgs(argv, SID);
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(reason);
  });
});

describe("the production edge's readers", () => {
  test("taggedBarPanes names the panes tagged with the session's pane", () => {
    expect(taggedBarPanes("%1 \n%9 %7\n%10 %8\n%11 %7\n", "%7")).toEqual(["%9", "%11"]);
    expect(BAR_PANE_OPTION).toBe("@cc-candybar-bar-pane");
  });

  test("runsAttached reads a cc-attach launcher at or above the foreground job, below the pane", () => {
    const table = [
      "  10     1 /bin/zsh -l",
      "  20    10 node /home/u/cc-extra/bin/cc-attach --resume x",
      "  30    20 /home/u/.local/share/claude/versions/2.1.299 --resume x",
      "  40    10 claude --verbose",
    ].join("\n");
    expect(runsAttached(table, 20, 10)).toBe(true);
    expect(runsAttached(table, 30, 10)).toBe(true);
    expect(runsAttached(table, 40, 10)).toBe(false);
  });

  test("runsAttached reads a cc-attach launcher that is the pane's own first process", () => {
    const table = [
      "  10     1 node /home/u/cc-extra/bin/cc-attach",
      "  20     1 /bin/zsh -l",
    ].join("\n");
    expect(runsAttached(table, 10, 10)).toBe(true);
    // Nothing above the pane's first process is the pane's.
    expect(runsAttached("  20 10 /bin/zsh\n  10 1 cc-attach", 20, 20)).toBe(false);
  });

  test("the claude CLI runs under the session's directory, never the daemon's", () => {
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/daemon/spawner/.claude";
    try {
      expect(claudeEnv(undefined).CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(claudeEnv("/u/.claude.zai").CLAUDE_CONFIG_DIR).toBe("/u/.claude.zai");
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = was;
    }
  });
});

describe("LaneSetups", () => {
  const owner = (edge: LaneEdge) => {
    const state = new SessionState();
    const logs: string[] = [];
    const deferred: (() => void)[] = [];
    const setups = new LaneSetups({
      edge,
      host: HOST,
      state,
      log: (level, msg) => logs.push(`${level} ${msg}`),
      now: () => instantOf(new Date(0)),
      defer: (run) => void deferred.push(run),
    });
    // Run what the renders deferred, as the daemon's next turn does.
    const settle = () => deferred.splice(0).forEach((run) => run());
    return { setups, state, logs, settle };
  };
  const switches = (on: Partial<LaneSwitches>): LaneSwitches => ({
    band: false,
    statusline: false,
    pane: false,
    ...on,
  });

  test("a session's first render is where it starts: nothing is set up", () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.observe(session(), switches({ pane: true }), 1);
    settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([]);
  });

  // Whatever moved the switch — the toggle, ↺, ↶ undo, a preset, a hand edit
  // — reaches the setup the same way: a render that draws by it.
  test("a switch that moves between renders sets its lane up after the render, and only its lane", () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.observe(session(), switches({}), 1);
    setups.observe(session(), switches({ pane: true }), 2);
    expect(did).toEqual([]);
    settle();
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
    expect(logs).toEqual([
      `info lane: pane on — opened bar pane %9 under %7 (session=${SID})`,
    ]);
    // Renders that draw by the same switches set nothing up again.
    setups.observe(session(), switches({ pane: true }), 3);
    settle();
    expect(did).toHaveLength(1);
  });

  // Another session's save, or a hand edit, moves the switch in every session
  // reading the file; setting each of them up would restart every idle Claude
  // Code on the machine for one session's save.
  test("a switch moved only by the config file sets nothing up; the session's own next move does", () => {
    const { edge, did } = fakeEdge();
    const { setups, settle } = owner(edge);
    setups.observe(session(), switches({}), 4);
    setups.observe(session(), switches({ pane: true }), 4);
    settle();
    expect(did).toEqual([]);
    setups.observe(session(), switches({}), 4);
    setups.observe(session(), switches({ pane: true }), 5);
    settle();
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
  });

  test("a switch turned off brings the lane down", () => {
    const { edge, did } = fakeEdge({ barPanes: () => ["%9"] });
    const { setups, settle } = owner(edge);
    setups.observe(session(), switches({ pane: true }), 1);
    setups.observe(session(), switches({}), 2);
    settle();
    expect(did).toEqual(["close %9"]);
  });

  const held = (text: string): string | null => {
    const expected = new SessionState();
    holdClickError(expected, SID, text, instantOf(new Date(0)));
    return expected.get(SID, "click.error");
  };

  test("a setup refused at once is logged and held on the bar like a click's failure", () => {
    const { edge, did } = fakeEdge();
    const { setups, state, logs, settle } = owner(edge);
    const noTmux = session({ tmux: null });
    setups.observe(noTmux, switches({}), 1);
    setups.observe(noTmux, switches({ pane: true }), 2);
    settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([
      expect.stringMatching(/^warn lane: pane on: .*not running inside tmux/),
    ]);
    expect(state.get(SID, "click.error")).toBe(
      held(logs[0]!.replace(/^warn /, "").replace(` (session=${SID})`, "")),
    );
  });

  test("a restart that fails after the render is logged and held on the bar like a click's failure", async () => {
    // The wait reports its outcome only once the render has returned.
    let gone!: (v: boolean) => void;
    let asked!: () => void;
    const waiting = new Promise<void>((r) => (asked = r));
    const { edge } = fakeEdge({
      exited: () => {
        asked();
        return new Promise((r) => (gone = r));
      },
    });
    const { setups, state, logs, settle } = owner(edge);
    setups.observe(session(), switches({}), 1);
    setups.observe(session(), switches({ statusline: true }), 2);
    settle();
    await waiting;
    expect(logs).toEqual([
      `info lane: statusline on — restarting Claude Code in %7 under the attach launcher (session=${SID})`,
    ]);
    gone(false);
    await new Promise((r) => setImmediate(r));
    expect(logs.at(-1)).toMatch(/^warn lane: statusline on: Claude Code in %7 did not exit/);
    expect(state.get(SID, "click.error")).toBe(
      held(logs.at(-1)!.replace(/^warn /, "").replace(` (session=${SID})`, "")),
    );
  });
});
