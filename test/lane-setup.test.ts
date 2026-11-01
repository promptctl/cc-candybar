// brandon-menus-sjhy.amf — what a lane's toggle starts beyond the daemon's own
// gate, driven through fakes of every effect (src/daemon/lane-setup.ts), and
// the pure readers the production edge folds tmux's and ps's answers with
// (src/daemon/lane-edge.ts).

import { sessionEnv } from "../src/daemon/session-env";
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
  type LaneEdge,
  type LaneHost,
  type LaneOutcome,
  type LaneSession,
  type PaneClaude,
} from "../src/daemon/lane-setup";
import {
  relaunchArgs,
  sessionArgs,
  startPlace,
} from "../src/daemon/claude-relaunch";
import { attachCommandLine } from "../src/attach-launcher";
import {
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
  origin: { projectDir: "/p", cwd: "/p", target: { source: "search" } },
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
    env: ["PATH=/usr/bin", "PWD=/work", "EDITOR=vi"],
    cwd: "/work/.claude/worktrees/feat+tree",
    parent: 4100,
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
    claude: async (args, session) =>
      void did.push(`claude ${args.join(" ")} [${session.claudeConfigDir ?? "-"}]`),
    fileExists: () => true,
    presence: () => "present",
    paneClaude: async () => claude,
    // The shell Claude Code was started from sits in the repository whose
    // worktree it runs in.
    paneDir: async (_hint, shell) => {
      did.push(`dir of ${shell}`);
      return "/work";
    },
    launcherNode: () => ({ kind: "node", file: "/usr/bin/node" }),
    // `claude` on its PATH is the release it runs.
    onPath: () => claude.executable,
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
  preload: "/opt/candybar/dist/attach-preload.cjs",
};

// The line the restart types for the fake edge's Claude Code, on `start`.
const RESTART_LINE = (start = `--resume ${SID}`): string =>
  `cd /work && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions ${start}`;

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

describe("lane C, tmux status line", () => {
  test("on and off run nothing: the daemon draws the status line by the switch", () => {
    const { edge, did } = fakeEdge();
    expect(LANE_SETUP.tmuxStatus.on(session(), HOST, edge)).toEqual({
      kind: "done",
      said: "the daemon draws %7's bar in its status line",
    });
    expect(LANE_SETUP.tmuxStatus.off(session(), HOST, edge).kind).toBe("done");
    expect(did).toEqual([]);
  });

  test("on in a session outside tmux is refused, saying why", () => {
    const { edge } = fakeEdge();
    expect(() => LANE_SETUP.tmuxStatus.on(session({ tmux: null }), HOST, edge)).toThrow(
      /not running inside tmux/,
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
  test("on ends Claude Code, then types one line into its shell that starts it again under the launcher, back in its worktree, on the same session", async () => {
    const { edge, did } = fakeEdge();
    const out = LANE_SETUP.statusline.on(session(), HOST, edge);
    // The click itself does nothing in the pane.
    expect(did).toEqual([]);
    // The line is the restart's report, which LaneSetups logs.
    await expect(finished(out)).resolves.toBe(
      `restarted Claude Code in %7 under the attach launcher with \`${RESTART_LINE()}\`, resuming ${SID}, and its statusline follows lane B`,
    );
    expect(did).toEqual([
      "graph /usr/bin/node /opt/candybar/dist/cc-extra/src/bun-graph.js /u/.local/share/claude/versions/2.1.299",
      // A signal, never `/exit`: `/exit` removes or asks about the worktree.
      "terminate 4242",
      // Its shell's directory, once that shell holds the terminal again.
      "dir of 4100",
      `shell ${RESTART_LINE()}`,
      `followed ${SID} statusline`,
    ]);
  });

  // The launcher starts nothing in place of an attach it could not make, so a
  // restart is confirmed only by the statusline following lane B again.
  test("a restart whose statusline never follows lane B again is a failure naming the line", async () => {
    const { edge } = fakeEdge({ followed: async () => false });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(
      `did not come back attached within ${ATTACH_PATIENCE_MS / 1000} s of \`${RESTART_LINE()}\` — the pane says why`,
    );
  });

  // The preload starts the launcher under the node the line's shell finds,
  // so a node it would refuse ends nothing.
  test("a PATH with no node the launcher can run under leaves Claude Code running", async () => {
    const { edge, did } = fakeEdge({
      launcherNode: () => ({ kind: "refused", why: "no `node` on PATH to run the attach launcher" }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(
      "Claude Code in %7 was left running, under the PATH it was started with: no `node` on PATH to run the attach launcher",
    );
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  // Claude Code's auto-update removes the release a path names; `claude`
  // reruns from history after it.
  test("a release the shell would not find as `claude` is named by its path", async () => {
    const { edge, did } = fakeEdge({ onPath: () => "/usr/local/bin/claude-other" });
    await finished(LANE_SETUP.statusline.on(session(), HOST, edge));
    expect(did).toContain(
      `shell cd /work && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' /u/.local/share/claude/versions/2.1.299 --worktree feat/tree --dangerously-skip-permissions --resume ${SID}`,
    );
  });

  // `--resume` looks a session up under the Claude Code directory it ran
  // with, and a config set on the command it was started by decides whether
  // lane B is on; the rest stays the shell's, and no credential reaches the
  // shell's history.
  test("of Claude Code's environment, what the bar reads off its client rides the line", async () => {
    const { edge: base } = fakeEdge();
    const claude = await base.paneClaude(TMUX);
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        ...claude,
        env: [
          ...claude.env,
          "CLAUDE_CONFIG_DIR=/u/.claude zai",
          "CC_CANDYBAR_CONFIG=/u/lab.json5",
          "ANTHROPIC_API_KEY=sk-secret",
          "CLAUDE_CODE_OAUTH_TOKEN=oauth-secret",
          "CLAUDECODE=1",
        ],
      }),
    });
    await finished(LANE_SETUP.statusline.on(session(), HOST, edge));
    expect(did.join("\n")).not.toContain("secret");
    expect(did).toContain(
      `shell cd /work && CLAUDE_CONFIG_DIR='/u/.claude zai' CC_CANDYBAR_CONFIG=/u/lab.json5 BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions --resume ${SID}`,
    );
  });

  // A relative path among its flags resolves against where Claude Code was
  // started, which is where the line starts it again.
  test("a session started inside its worktree starts there again, with no --worktree", async () => {
    const { edge, did } = fakeEdge({
      paneDir: async () => "/work/.claude/worktrees/feat+tree/sub",
    });
    await finished(LANE_SETUP.statusline.on(session(), HOST, edge));
    expect(did).toContain(
      `shell cd /work/.claude/worktrees/feat+tree/sub && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --dangerously-skip-permissions --resume ${SID}`,
    );
  });

  test("a pane whose directory cannot be read once Claude Code exited types nothing, and names the line", async () => {
    const { edge, did } = fakeEdge({
      paneDir: async () => {
        throw new Error("no such pane");
      },
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(
      `exited, but the directory it was started in could not be read (no such pane), so it was not started again — start it with \`cd /work && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions --resume ${SID}\``,
    );
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  test("a Claude Code that does not exit has no line typed for it", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).rejects.toThrow(/did not exit within/);
    expect(did.at(-1)).toBe("terminate 4242");
  });

  test.each([
    ["attach-preload.cjs", "/opt/candybar/dist/attach-preload.cjs"],
    ["bun-attach.js", "/opt/candybar/dist/cc-extra/src/bun-attach.js"],
  ])("a build with no %s is refused before anything in the pane is touched", (missing, file) => {
    const { edge, did } = fakeEdge({
      fileExists: (f) => !f.endsWith(missing),
    });
    expect(() => LANE_SETUP.statusline.on(session(), HOST, edge)).toThrow(
      `${file} is not there — run \`cc-candybar install\``,
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
    expect(did.slice(-2)).toEqual([
      `shell ${RESTART_LINE(`--session-id ${SID}`)}`,
      `followed ${SID} statusline`,
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
    expect(did.indexOf(`shell ${RESTART_LINE()}`)).toBeGreaterThan(
      did.indexOf("terminate 4242"),
    );
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
    ).rejects.toThrow(`(ELOOP), so it was not started again — start it with \`${RESTART_LINE()}\``);
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  test("a line that cannot be typed once Claude Code exited is named for the user to type", async () => {
    const { edge } = fakeEdge({
      presence: () => "absent",
      typeShellLine: () => {
        throw new Error("server exited");
      },
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session({ tmux: TMUX }, "no"), HOST, edge)),
    ).rejects.toThrow(
      `exited, but the line could not be typed into its pane (server exited), so it was not started again — start it with \`${RESTART_LINE(`--session-id ${SID}`)}\``,
    );
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
    // Refused at the kill, before anything is typed.
    expect(did.some((d) => /^(shell|terminate)/.test(d))).toBe(false);
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
        parent: 4100,
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
        parent: 4100,
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
        parent: 4100,
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

// [LAW:behavior-not-structure] The line is typed into whatever shell the
// pane runs, and kept in its history: every shell installed here runs it.
const SHELLS = ["/bin/sh", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/bash", "/opt/homebrew/bin/fish"]
  .filter((shell) => fs.existsSync(shell));

describe("the line a restart types", () => {
  test.each(SHELLS)("runs under %s: in its directory, with its variables, as `claude` on PATH", (shell) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane line's "));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const record = path.join(dir, "ran");
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\npwd -P > "$RECORD"\nprintf '%s\\n' "$CLAUDE_CONFIG_DIR" "$BUN_OPTIONS" "$@" >> "$RECORD"\n`,
      { mode: 0o755 },
    );
    const start = path.join(dir, "start here");
    fs.mkdirSync(start);
    const line = attachCommandLine("/a dir/attach-preload.cjs", {
      dir: start,
      env: [["CLAUDE_CONFIG_DIR", "/u/.claude $zai"]],
      program: "claude",
      args: ["--model", "it's a b", "--resume", SID],
    });
    const { status, stderr } = spawnSync(shell, ["-c", line], {
      env: { PATH: `${bin}:/usr/bin:/bin`, RECORD: record, HOME: dir },
      encoding: "utf8",
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(fs.readFileSync(record, "utf8").split("\n")).toEqual([
      fs.realpathSync(start),
      "/u/.claude $zai",
      "--preload /a\\ dir/attach-preload.cjs",
      "--model",
      "it's a b",
      "--resume",
      SID,
      "",
    ]);
  });
});

describe("relaunchArgs", () => {
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
    // The worktree is read off the directory the session runs in.
    [["claude", "--worktree", "gone"], []],
    [["claude", "-w", "fix", "--model", "opus"], ["--model", "opus"]],
  ])("%j carries %j", (argv, kept) => {
    expect(relaunchArgs(argv)).toEqual({ kind: "args", args: kept });
  });

  test.each([
    [["claude", "--mystery"], /--mystery/],
    [["claude", "--model"], /--model and no value/],
  ])("%j is refused", (argv, reason) => {
    const out = relaunchArgs(argv);
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(reason);
  });

  // `--resume` of a session with no transcript finds no conversation; a fresh
  // start on the same id keeps the id the session's picks are held under.
  test("a session is resumed, or with no conversation yet started afresh, on the same id", () => {
    expect(sessionArgs({ kind: "resume", sessionId: SID })).toEqual(["--resume", SID]);
    expect(sessionArgs({ kind: "fresh", sessionId: SID })).toEqual(["--session-id", SID]);
  });
});

describe("startPlace", () => {
  // Claude Code makes `--worktree feat/x` at `<repo>/.claude/worktrees/feat+x`
  // and runs there; naming it again from where it was started goes back in —
  // whether the session was started with `--worktree` or entered it later.
  test.each([
    ["/src", "/src", "/src", []],
    ["/src", "/src/.claude/worktrees/tidy-sunset", "/src", ["--worktree", "tidy-sunset"]],
    ["/src", "/src/.claude/worktrees/feat+x.y", "/src", ["--worktree", "feat/x.y"]],
    ["/src/sub", "/src/.claude/worktrees/fix/sub/dir", "/src/sub", ["--worktree", "fix"]],
    ["/", "/.claude/worktrees/top", "/", ["--worktree", "top"]],
    // Started inside the worktree: it starts there again as it is.
    ["/src/.claude/worktrees/fix", "/src/.claude/worktrees/fix", "/src/.claude/worktrees/fix", []],
    ["/src/.claude/worktrees/fix/sub", "/src/.claude/worktrees/fix/other", "/src/.claude/worktrees/fix/sub", []],
    // Started in another worktree — a sibling whose name extends this one's
    // included: `--worktree` from there would make one inside it.
    ["/src/.claude/worktrees/fix2", "/src/.claude/worktrees/fix", "/src", ["--worktree", "fix"]],
    ["/src/.claude/worktrees/a/sub", "/src/.claude/worktrees/b", "/src", ["--worktree", "b"]],
    // A directory named like a worktree holder but holding none is no worktree.
    ["/src", "/src/.claude/worktrees", "/src", []],
    // Where it was started not known: the worktree's repository, else where
    // it runs.
    [null, "/src/.claude/worktrees/fix/sub", "/src", ["--worktree", "fix"]],
    [null, "/src/sub", "/src/sub", []],
  ])("started in %s, running in %s, starts in %s with %j", (startDir, cwd, dir, args) => {
    expect(startPlace(startDir, cwd)).toEqual({ dir, args });
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
    // The session's process environment (src/daemon/session-env.ts) the
    // edge's `claude` spawns with.
    const daemon = { CLAUDE_CONFIG_DIR: "/daemon/spawner/.claude", PATH: "/usr/bin" };
    const facts = { sessionId: "s1", projectDir: "/p" };
    expect(
      sessionEnv(daemon, { ...facts, claudeConfigDir: undefined }).CLAUDE_CONFIG_DIR,
    ).toBeUndefined();
    expect(
      sessionEnv(daemon, { ...facts, claudeConfigDir: "/u/.claude.zai" }).CLAUDE_CONFIG_DIR,
    ).toBe("/u/.claude.zai");
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
    // Run what the clicks and requests deferred, as the daemon's next turn
    // does, and the setups queued behind them.
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
    tmuxStatus: false,
    ...on,
  });

  const OPENED = `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`;

  // Whatever control moved the switch — the toggle, ↺, ↶ undo, a preset, a
  // save — reaches the setup the same way: the click measured before and
  // after its commit (journaled, src/daemon/verbs/index.ts).
  test("a click that moves a switch sets its lane up in the turn after, and only its lane", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.clicked(SID, session(), switches({}), switches({ pane: true }));
    expect(did).toEqual([]);
    await settle();
    expect(did).toEqual([OPENED]);
    expect(logs).toEqual([
      `info lane: pane on — opened bar pane %9 under %7 by=click (session=${SID})`,
    ]);
    // A click that moves no switch sets nothing up.
    setups.clicked(SID, session(), switches({ pane: true }), switches({ pane: true }));
    await settle();
    expect(did).toHaveLength(1);
  });

  // A daemon restarted under a bar the old one drew: the toggle is clicked
  // before this daemon holds a request of the session.
  test("a click before the session's first request owes its setup to that request", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.clicked(SID, null, switches({}), switches({ pane: true }));
    await settle();
    expect(did).toEqual([]);
    setups.noted(session(), switches({ pane: true }));
    await settle();
    expect(did).toEqual([OPENED]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane on — opened bar pane %9 under %7 by=owed (session=${SID})`,
    ]);
    // Owed once: the next request starts nothing.
    setups.noted(session(), switches({ pane: true }));
    await settle();
    expect(did).toHaveLength(1);
  });

  test("a lane toggled on and off again before the session's first request owes nothing", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.clicked(SID, null, switches({}), switches({ pane: true, band: true }));
    setups.clicked(SID, null, switches({ pane: true, band: true }), switches({ band: true }));
    setups.clicked(SID, null, switches({ band: true }), switches({}));
    setups.noted(session(), switches({}));
    await settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed band on,pane on (session=${SID})`,
      `info lane: owed band on (session=${SID})`,
      `info lane: owed nothing (session=${SID})`,
    ]);
  });

  // Another session's save to the file both read, or a hand edit, between the
  // click and the request.
  test("an owed lane whose switch is back where it stood by the first request owes nothing", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.clicked(SID, null, switches({}), switches({ pane: true }));
    setups.noted(session(), switches({}));
    await settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane off — nothing owed: its switch is back where the lane is by=owed (session=${SID})`,
    ]);
  });

  // A request noted for its feed whose draw failed before its arrival settled
  // anything: the session's next click is the first event that can.
  test("a click once the session's request is held settles what earlier clicks owed", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.clicked(SID, null, switches({}), switches({ pane: true }));
    setups.clicked(SID, session(), switches({ pane: true }), switches({}));
    // Nothing is owed after it: a switch moved later by anything but a click
    // sets nothing up.
    setups.noted(session(), switches({ pane: true }));
    await settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane off — nothing owed: its switch is back where the lane is by=click (session=${SID})`,
    ]);
  });

  test("a click that settles an earlier click's owed lane says which lane each started", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle } = owner(edge);
    setups.clicked(SID, null, switches({}), switches({ pane: true }));
    setups.clicked(
      SID,
      session(),
      switches({ pane: true }),
      switches({ pane: true, tmuxStatus: true }),
    );
    await settle();
    expect(did).toEqual([OPENED]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane on — opened bar pane %9 under %7 by=owed (session=${SID})`,
      `info lane: tmuxStatus on — the daemon draws %7's bar in its status line by=click (session=${SID})`,
    ]);
  });

  test("owed setups are kept for 1024 sessions; the oldest is dropped, and said", async () => {
    const { edge } = fakeEdge();
    const { setups, logs } = owner(edge);
    for (let i = 0; i <= 1024; i++)
      setups.clicked(`s${i}`, null, switches({}), switches({ pane: true }));
    expect(logs.filter((l) => l.startsWith("warn"))).toEqual([
      `warn lane: owed dropped sid="s0" lanes=pane`,
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
    setups.clicked(SID, session(), switches({}), switches({ statusline: true }));
    setups.clicked(SID, session(), switches({ statusline: true }), switches({}));
    setups.clicked(SID, session(), switches({}), switches({ statusline: true }));
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
    setups.clicked(SID, session(), switches({ pane: true }), switches({}));
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
    setups.clicked(SID, session({ tmux: null }), switches({}), switches({ pane: true }));
    await settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([
      expect.stringMatching(/^warn lane: pane on: .*not running inside tmux/),
    ]);
    expect(state.get(SID, "click.error")).toBe(
      held(logs[0]!.replace(/^warn /, "").replace(` by=click (session=${SID})`, "")),
    );
  });

  test("a restart that fails after the click is logged and held on the bar like a click's failure", async () => {
    // The wait reports its outcome only once the click has returned.
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
    setups.clicked(SID, session(), switches({}), switches({ statusline: true }));
    await settle();
    await waiting;
    expect(logs).toEqual([
      `info lane: statusline on — restarting Claude Code in %7 under the attach launcher by=click (session=${SID})`,
    ]);
    gone(false);
    await new Promise((r) => setImmediate(r));
    expect(logs.at(-1)).toMatch(/^warn lane: statusline on: Claude Code in %7 did not exit/);
    expect(state.get(SID, "click.error")).toBe(
      held(logs.at(-1)!.replace(/^warn /, "").replace(` by=click (session=${SID})`, "")),
    );
  });
});
