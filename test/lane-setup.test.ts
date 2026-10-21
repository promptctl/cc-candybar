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
import { relaunchOf, sessionArgs } from "../src/daemon/claude-relaunch";
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

const session = (
  hints: LaneSession["hints"] = { tmux: TMUX },
  answered: LaneSession["answered"] = "yes",
): LaneSession => ({
  sessionId: SID,
  hints,
  origin: { projectDir: "/p", cwd: "/p", configFile: null },
  transcript: "/u/.claude/projects/-p/session.jsonl",
  answered,
});

// Every effect recorded, in the order it ran.
function fakeEdge(over: Partial<LaneEdge> = {}): { edge: LaneEdge; did: string[] } {
  const did: string[] = [];
  const claude: PaneClaude = {
    pid: 4242,
    executable: "/u/.local/share/claude/versions/2.1.299",
    argv: ["claude", "--dangerously-skip-permissions", "--worktree"],
    env: ["PATH=/usr/bin", "PWD=/work", "CC_CANDYBAR_CONFIG=/u/alt config.json5"],
    cwd: "/work/.claude/worktrees/feat+tree",
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
    presence: () => "present",
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
    terminate: (pid) => void did.push(`terminate ${pid}`),
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
  test("on ends Claude Code, then starts the binary it ran again under the launcher beside the bundle, back in its worktree, on the same session", async () => {
    const { edge, did } = fakeEdge();
    const out = LANE_SETUP.statusline.on(session(), HOST, edge);
    // The click itself does nothing in the pane.
    expect(did).toEqual([]);
    await expect(finished(out)).resolves.toContain("its statusline follows lane B");
    expect(did).toEqual([
      "graph /usr/bin/node /opt/candybar/dist/cc-extra/src/bun-graph.js /u/.local/share/claude/versions/2.1.299",
      // A signal, never `/exit`: `/exit` removes or asks about the worktree.
      "terminate 4242",
      `script /run/relaunch-${SID}.sh:\n${relaunchScript(
        "/work",
        [
          "/usr/bin/node",
          "/opt/candybar/dist/cc-extra/src/bun-attach.js",
          "/u/.local/share/claude/versions/2.1.299",
          "--worktree",
          "feat/tree",
          "--dangerously-skip-permissions",
          "--resume",
          SID,
        ],
        ["PATH=/usr/bin", "PWD=/work", "CC_CANDYBAR_CONFIG=/u/alt config.json5"],
      )}`,
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

  test("a Claude Code that does not exit has no script written for it", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/did not exit within/);
    expect(did.at(-1)).toBe("terminate 4242");
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

  // Claude Code writes a session's transcript with its first message, and
  // `--resume` of one with none finds no conversation: such a session starts
  // afresh under its own id (`--session-id`), so lane B's wait for its
  // subscriber, which names that id, is answered by the restart.
  test("a session with no conversation yet starts afresh on the same id, and its statusline follows lane B", async () => {
    const { edge, did } = fakeEdge({ presence: () => "absent" });
    await expect(
      finished(LANE_SETUP.statusline.on(session({ tmux: TMUX }, "no"), HOST, edge)),
    ).resolves.toContain(`starting ${SID} afresh, since it had no conversation yet`);
    const script = did.find((d) => d.startsWith("script "))!;
    expect(script).toContain(`--session-id ${SID}`);
    expect(script).not.toContain("--resume");
    expect(did.slice(-3)).toEqual([
      `shell sh /run/relaunch-${SID}.sh`,
      `followed ${SID} statusline`,
      `remove /run/relaunch-${SID}.sh`,
    ]);
  });

  // A first message sent up to the kill writes the transcript; the session is
  // then resumed, never started afresh on an id Claude Code would refuse as
  // in use. Nothing writes it once Claude Code has exited.
  test("whether a session has a conversation is read once Claude Code has exited", async () => {
    let written = false;
    const { edge, did } = fakeEdge({
      presence: () => (written ? "present" : "absent"),
      terminate: (pid) => {
        did.push(`terminate ${pid}`);
        written = true;
      },
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session({ tmux: TMUX }, "no"), HOST, edge)),
    ).resolves.toContain(`resuming ${SID}`);
    const script = did.findIndex((d) => d.startsWith("script "));
    expect(did[script]).toContain(`--resume ${SID}`);
    expect(script).toBeGreaterThan(did.indexOf("terminate 4242"));
  });

  // Claude Code answered in the session, so it has a conversation, but keeps
  // no transcript of it (persistence off): a fresh start would throw it away.
  test.each([
    ["yes", /has a conversation but no transcript to resume it from/],
    ["unknown", /does not say whether session .* has a conversation/],
  ] as const)(
    "a session answered %j with no transcript is left running",
    async (answered, reason) => {
      const { edge, did } = fakeEdge({ presence: () => "absent" });
      await expect(
        finished(LANE_SETUP.statusline.on(session({ tmux: TMUX }, answered), HOST, edge)),
      ).rejects.toThrow(reason);
      expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
    },
  );

  // A stat that fails for another reason than absence says nothing of the
  // conversation: before the kill, Claude Code is left running; after it,
  // nothing is started on a guess.
  test("a transcript stat could not see past is refused before the kill", async () => {
    const { edge, did } = fakeEdge({
      presence: (file) => ({ path: file, error: "EACCES" }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/was left running: whether session .* could not be seen \(EACCES\)/);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  test("a transcript stat could not see past once Claude Code exited starts nothing", async () => {
    let ended = false;
    const { edge, did } = fakeEdge({
      presence: (file) => (ended ? { path: file, error: "ELOOP" } : "present"),
      terminate: () => {
        ended = true;
      },
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(new RegExp(`exited, but .* \\(ELOOP\\).*claude --resume ${SID}`));
    expect(did.some((d) => d.startsWith("script ") || d.startsWith("shell"))).toBe(false);
  });

  test("a Claude Code that does not exit is not started again, and the wait says why", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(`did not exit within ${EXIT_PATIENCE_MS / 1000} s`);
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  // The screen of a session mid-turn, as tmux captured it (2.1.289): ending
  // Claude Code here would end the turn. The screen is judged at the kill, so
  // a turn started during the module-graph read is seen.
  test("a Claude Code in the middle of a turn is refused before Claude Code is ended", async () => {
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
    // Refused at the kill, before any script is written.
    expect(did.some((d) => /^(script|terminate)/.test(d))).toBe(false);
  });

  // A stash and a pending dialog die with the process; copy mode is a screen
  // nothing can be read past.
  test.each([
    ["copy mode", { inMode: true, screen: READY_SCREEN }, /copy mode/],
    ["a held stash", { inMode: false, screen: ["  › stashed", ...READY_SCREEN] }, /stashed prompt/],
    ["a dialog", { inMode: false, screen: ["Allow this tool call?", "  ❯ 1. Yes"] }, /not at its prompt/],
  ])("a pane showing %s is refused before Claude Code is ended", async (_what, snapshot, reason) => {
    const { edge, did } = fakeEdge({
      claudeInput: { read: () => snapshot, type: () => ({ kind: "typed" }) },
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(reason);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  test("a Claude Code the pane no longer shows by the time of the kill is not killed", async () => {
    const { edge: base } = fakeEdge();
    const first = await base.paneClaude(TMUX);
    let reads = 0;
    const { edge, did } = fakeEdge({
      paneClaude: async () => (reads++ === 0 ? first : { ...first, pid: 5151 }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/no longer the process the restart read \(pid 4242\)/);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
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
        env: [],
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
        env: [],
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
  test("a Claude Code the launcher cannot start is refused before Claude Code is ended", async () => {
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

  test("a flag cc-candybar cannot carry refuses the restart before Claude Code is ended", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        executable: "/bin/claude",
        argv: ["claude", "--brand-new-flag", "x"],
        env: [],
        cwd: "/",
        fromShell: true,
        attached: false,
      }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/--brand-new-flag/);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
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
  test("runs its argv, every word quoted where the shell would read it otherwise, under the environment Claude Code was started with", () => {
    const script = relaunchScript(
      "/it's/here",
      ["/usr/bin/node", "/opt/l.js", "/bin/claude", "--model", "a b"],
      ["CC_CANDYBAR_CONFIG=/u/alt config.json5", "BASH_FUNC_f%%=() {  :\n}", "EMPTY="],
    );
    expect(script.split("\n")).toEqual([
      `cd -- '/it'\\''s/here' || exit 1`,
      "unset CLAUDE_CONFIG_DIR",
      "export CC_CANDYBAR_CONFIG='/u/alt config.json5'",
      "export EMPTY=''",
      "exec /usr/bin/node /opt/l.js /bin/claude --model 'a b'",
      "",
    ]);
  });

  test("runs under sh, in Claude Code's directory, under Claude Code's own Claude Code directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane script "));
    const record = path.join(dir, "ran");
    const launcher = path.join(dir, "launcher");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\npwd > '${record}'\necho "$CLAUDE_CONFIG_DIR" >> '${record}'\necho "$CC_CANDYBAR_CONFIG" >> '${record}'\nprintf '%s\\n' "$@" >> '${record}'\n`,
      { mode: 0o755 },
    );
    const self = path.join(dir, "r.sh");
    fs.writeFileSync(
      self,
      relaunchScript(
        dir,
        [launcher, "/bin/claude", "--model", "a b", "--resume", SID],
        ["CLAUDE_CONFIG_DIR=/u/.claude.zai", "CC_CANDYBAR_CONFIG=/u/alt.json5"],
      ),
    );
    const { status, stderr } = spawnSync("/bin/sh", [self], {
      // The pane's shell may export a directory of its own; Claude Code's
      // wins. And nothing is looked up on its PATH.
      env: { PATH: "/nonexistent", CLAUDE_CONFIG_DIR: "/u/.claude" },
      encoding: "utf8",
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(fs.readFileSync(record, "utf8").split("\n")).toEqual([
      dir,
      "/u/.claude.zai",
      "/u/alt.json5",
      "/bin/claude",
      "--model",
      "a b",
      "--resume",
      SID,
      "",
    ]);
  });
});

describe("relaunchOf", () => {
  const started = (argv: string[], cwd = "/src") => ({ argv, cwd });

  test.each([
    [["claude"], []],
    [["claude", "--dangerously-skip-permissions"], ["--dangerously-skip-permissions"]],
    [["claude", "--resume", "old-id", "--verbose"], ["--verbose"]],
    [["claude", "-r", "--verbose"], ["--verbose"]],
    [["claude", "-c", "--session-id", "u", "--fork-session"], []],
    [["claude", "--add-dir", "a", "b", "--model=opus"], ["--add-dir", "a", "b", "--model=opus"]],
    [["claude", "fix the bug", "--effort", "high"], ["--effort", "high"]],
    [["claude", "--", "--not-a-flag"], []],
    [["claude", "--append-system-prompt", "-be terse"], ["--append-system-prompt", "-be terse"]],
    // A session started in a worktree that has left it runs, and restarts,
    // outside it.
    [["claude", "--worktree", "gone"], []],
  ])("%j starts again where it runs as %j and the session", (argv, kept) => {
    expect(relaunchOf(started(argv))).toEqual({
      kind: "relaunch",
      dir: "/src",
      args: kept,
    });
  });

  // Claude Code makes `--worktree feat/x` at `<repo>/.claude/worktrees/feat+x`
  // and runs there; naming it again, from its repository, goes back in —
  // whether the session was started with `--worktree` or entered it later.
  test.each([
    [["claude", "--worktree"], "/src/.claude/worktrees/tidy-sunset", "/src", "tidy-sunset"],
    [["claude", "--worktree", "feat/x.y", "--model", "opus"], "/src/.claude/worktrees/feat+x.y", "/src", "feat/x.y"],
    [["claude", "-w", "fix"], "/src/.claude/worktrees/fix", "/src", "fix"],
    [["claude", "--worktree=fix"], "/src/.claude/worktrees/fix", "/src", "fix"],
    [["claude", "--model", "opus"], "/other/.claude/worktrees/entered", "/other", "entered"],
    [["claude"], "/src/.claude/worktrees/fix/sub/dir", "/src", "fix"],
    [["claude"], "/.claude/worktrees/top", "/", "top"],
  ])("%j, running in %s, starts again from %s in worktree %j", (argv, cwd, dir, name) => {
    expect(relaunchOf(started(argv, cwd))).toEqual({
      kind: "relaunch",
      dir,
      args: [
        "--worktree",
        name,
        ...(argv.includes("--model") ? ["--model", "opus"] : []),
      ],
    });
  });

  // `--resume` of a session with no transcript finds no conversation; a fresh
  // start on the same id keeps the id the session's picks are held under.
  test("a session is resumed, or with no conversation yet started afresh, on the same id", () => {
    expect(sessionArgs({ kind: "resume", sessionId: SID })).toEqual(["--resume", SID]);
    expect(sessionArgs({ kind: "fresh", sessionId: SID })).toEqual(["--session-id", SID]);
  });

  test("a directory named like a worktree holder but holding none is no worktree", () => {
    expect(relaunchOf(started(["claude"], "/src/.claude/worktrees"))).toEqual({
      kind: "relaunch",
      dir: "/src/.claude/worktrees",
      args: [],
    });
  });

  test.each([
    [started(["claude", "--mystery"]), /--mystery/],
    [started(["claude", "--model"]), /--model and no value/],
  ])("%j is refused", (claude, reason) => {
    const out = relaunchOf(claude);
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
    // Run what the renders deferred, as the daemon's next turn does, and the
    // setups queued behind them.
    const settle = async (): Promise<void> => {
      deferred.splice(0).forEach((run) => run());
      await new Promise((r) => setImmediate(r));
    };
    return { setups, state, logs, settle };
  };
  const switches = (on: Partial<LaneSwitches>): LaneSwitches => ({
    band: false,
    statusline: false,
    pane: false,
    ...on,
  });

  test("a session's first render is where it starts: nothing is set up", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.observe(session(), switches({ pane: true }), 0);
    await settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([]);
  });

  // Whatever moved the switch — the toggle, ↺, ↶ undo, a preset, a hand edit
  // — reaches the setup the same way: a render that draws by it.
  test("a switch that moves between renders sets its lane up after the render, and only its lane", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.observe(session(), switches({}), 1);
    setups.observe(session(), switches({ pane: true }), 2);
    expect(did).toEqual([]);
    await settle();
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
    expect(logs).toEqual([
      `info lane: pane on — opened bar pane %9 under %7 (session=${SID})`,
    ]);
    // Renders that draw by the same switches set nothing up again.
    setups.observe(session(), switches({ pane: true }), 3);
    await settle();
    expect(did).toHaveLength(1);
  });

  // Another session's save, or a hand edit, moves the switch in every session
  // reading the file; setting each of them up would restart every idle Claude
  // Code on the machine for one session's save.
  test("a switch moved only by the config file sets nothing up; the session's own next move does", async () => {
    const { edge, did } = fakeEdge();
    const { setups, settle } = owner(edge);
    setups.observe(session(), switches({}), 4);
    setups.observe(session(), switches({ pane: true }), 4);
    await settle();
    expect(did).toEqual([]);
    setups.observe(session(), switches({}), 4);
    setups.observe(session(), switches({ pane: true }), 5);
    await settle();
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
  });

  // A daemon restarted under a bar the old one drew: the toggle is clicked
  // before this daemon has rendered the session.
  test("a session first seen after it moved a setting here sets up the lanes switched on", async () => {
    const { edge, did } = fakeEdge();
    const { setups, settle } = owner(edge);
    setups.observe(session(), switches({ pane: true }), 3);
    await settle();
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
  });

  // Toggled on, off and on again inside one restart: a second restart of the
  // pane would type into the first.
  test("one session's setups run one at a time, each after the last has finished", async () => {
    let exit!: (gone: boolean) => void;
    const { edge, did } = fakeEdge({
      exited: () => new Promise((r) => (exit = r)),
    });
    const { setups, settle } = owner(edge);
    setups.observe(session(), switches({}), 0);
    setups.observe(session(), switches({ statusline: true }), 1);
    setups.observe(session(), switches({}), 2);
    setups.observe(session(), switches({ statusline: true }), 3);
    await settle();
    // The first restart waits for Claude Code to exit; nothing else has run.
    expect(did.filter((d) => d.startsWith("terminate"))).toEqual(["terminate 4242"]);
    exit(true);
    await new Promise((r) => setTimeout(r, 20));
    // Off, then on: the second restart starts only after the first ended.
    expect(did.filter((d) => d.startsWith("terminate"))).toEqual(["terminate 4242", "terminate 4242"]);
  });

  test("a switch turned off brings the lane down", async () => {
    const { edge, did } = fakeEdge({ barPanes: () => ["%9"] });
    const { setups, settle } = owner(edge);
    setups.observe(session(), switches({ pane: true }), 1);
    setups.observe(session(), switches({}), 2);
    await settle();
    expect(did).toEqual(["close %9"]);
  });

  const held = (text: string): string | null => {
    const expected = new SessionState();
    holdClickError(expected, SID, text, instantOf(new Date(0)));
    return expected.get(SID, "click.error");
  };

  test("a setup refused at once is logged and held on the bar like a click's failure", async () => {
    const { edge, did } = fakeEdge();
    const { setups, state, logs, settle } = owner(edge);
    const noTmux = session({ tmux: null });
    setups.observe(noTmux, switches({}), 1);
    setups.observe(noTmux, switches({ pane: true }), 2);
    await settle();
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
    await settle();
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
