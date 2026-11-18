// What a lane's toggle starts beyond the daemon's own gate: the act the
// renderer asks for it (src/renderer/lane-acts.ts), and the setup the host
// performs for that act (src/daemon/acts.ts, src/daemon/lane-setup.ts), driven
// through fakes of every effect, and the pure readers the production edge
// folds tmux's and ps's answers with (src/daemon/lane-edge.ts).

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  BAND_PLUGIN,
  ATTACH_PATIENCE_MS,
  EXIT_PATIENCE_MS,
  bandOn,
  paneOn,
  paneOff,
  restartClaude,
  type LaneAt,
  type LaneEdge,
  type LaneHost,
  type PaneClaude,
} from "../src/daemon/lane-setup";
import { LaneActs } from "../src/renderer/lane-acts";
import { Acts, type ActDeps, type HostAct } from "../src/daemon/acts";
import type {
  Act,
  ActRequest,
  Effect,
  EffectId,
} from "../src/renderer-interface/interface";
import type { CheckedRenderRequest } from "../src/renderer-interface/request-context";
import type { Answered } from "../src/daemon/foundations/sighting-roles";
import {
  relaunchArgs,
  sessionArgs,
  startPlace,
} from "../src/daemon/claude-relaunch";
import { attachCommandLine } from "../src/attach-launcher";
import { refusalOf, runsAttached, barPanesOf } from "../src/daemon/lane-edge";
import { draftShown, turnRunning } from "../src/claude-input/prompt-screen";
import {
  tmuxPaneOf,
  typeInPane,
  type ClaudeInputEdge,
  type SessionPane,
} from "../src/claude-input/typing";
import { BadVerbArgs } from "../src/daemon/foundations/verb-error";
import type { LaneSwitches } from "../src/config/lanes";
import type { TmuxHint } from "../src/tmux-hint";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("1f6e0c2a-0d0e-4a52-9d1b-2b0b0f0e0a11");
const TMUX: TmuxHint = {
  socket: "/tmp/tmux-1/default",
  pane: "%7",
  truecolor: null,
};
const IN_PANE: SessionPane = { kind: "pane", hint: TMUX };
const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];

// A checkout: `src/` beside `dist/`, the native client built.
function checkout(): { root: string; bundle: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-checkout-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "dist"));
  return { root, bundle: path.join(root, "dist", "index.mjs") };
}

const TRANSCRIPT = "/u/.claude/projects/-p/session.jsonl";

// The session as a lane act carries it.
const session = (
  answered: Answered = "yes",
  claudeConfigDir: string | null = null,
): LaneAt => ({
  sessionId: SID,
  projectDir: "/p",
  claudeConfigDir,
  transcript: TRANSCRIPT,
  answered,
});

// Every effect recorded, in the order it ran.
// The pane world a lane acts in, and the pane's Claude Code input: a ready
// prompt, with every line typed into it recorded.
function fakeEdge(
  over: Partial<LaneEdge> = {},
  inputOver: Partial<ClaudeInputEdge> = {},
): {
  edge: LaneEdge;
  did: string[];
  input: ClaudeInputEdge;
} {
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
  const input: ClaudeInputEdge = {
    read: async () => ({ inMode: false, screen: READY_SCREEN }),
    type: async (_hint, line) => {
      did.push(`type ${line}`);
      return { kind: "typed" };
    },
    ...inputOver,
  };
  const edge: LaneEdge = {
    barPanes: async () => [],
    openBarPane: async (hint, argv, env) => {
      did.push(
        `open under ${hint.pane}: ${argv.join(" ")} ${JSON.stringify(env)}`,
      );
      return "%9";
    },
    closePane: async (_hint, pane) => void did.push(`close ${pane}`),
    claude: async (args, session) =>
      void did.push(
        `claude ${args.join(" ")} [${session}]`,
      ),
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
    typeShellLine: async (_hint, line) => void did.push(`shell ${line}`),
    followed: async (sessionId, lane) => {
      did.push(`followed ${sessionId} ${lane}`);
      return true;
    },
    ...over,
  };
  return { edge, did, input };
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
  test("on opens a bar pane under the session's pane, following this daemon", async () => {
    const { edge, did } = fakeEdge();
    expect(await paneOn(TMUX, HOST, edge)).toBe("opened bar pane %9 under %7");
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
  });

  test("on with a bar pane already open opens no second one", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9"] });
    expect(await paneOn(TMUX, HOST, edge)).toBe(
      "bar pane %9 already draws %7's bar",
    );
    expect(did).toEqual([]);
  });

  test("off closes every bar pane drawing the session's bar", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9", "%11"] });
    expect(await paneOff(TMUX, edge)).toBe("closed bar pane %9, %11");
    expect(did).toEqual(["close %9", "close %11"]);
  });
});

describe("lane A, band", () => {
  test("on installs the band mod from the checkout's marketplace, then reloads plugins, off the click", async () => {
    const { root, bundle } = checkout();
    const { edge, did, input } = fakeEdge();
    await expect(
      bandOn(session("yes", "/home/u/.claude"), IN_PANE, typeInPane(input), { ...HOST, bundle }, edge),
    ).resolves.toContain(
      `installed ${BAND_PLUGIN} from ${root}`,
    );
    expect(did).toEqual([
      `claude plugin marketplace add ${root} [${SID}]`,
      `claude plugin install ${BAND_PLUGIN} [${SID}]`,
      "type /reload-plugins",
    ]);
  });

  test("outside tmux the mod still installs, and the session is told to type /reload-plugins itself", async () => {
    const { root, bundle } = checkout();
    const { edge, did, input } = fakeEdge();
    await expect(
      bandOn(session(), tmuxPaneOf(null), typeInPane(input), { ...HOST, bundle }, edge),
    ).rejects.toThrow(
      /installed, but \/reload-plugins was not typed: .*not running inside tmux.*type \/reload-plugins yourself/,
    );
    expect(did).toEqual([
      `claude plugin marketplace add ${root} [${SID}]`,
      `claude plugin install ${BAND_PLUGIN} [${SID}]`,
    ]);
  });

  test("a daemon not run from a checkout is refused before anything is installed", async () => {
    const { edge, did, input } = fakeEdge();
    await expect(bandOn(session(), IN_PANE, typeInPane(input), HOST, edge)).rejects.toThrow(
      BadVerbArgs,
    );
    expect(did).toEqual([]);
  });

  test("an unbuilt native client is refused, naming the build", async () => {
    const { bundle } = checkout();
    const { edge, did, input } = fakeEdge({ fileExists: () => false });
    await expect(
      bandOn(session(), IN_PANE, typeInPane(input), { ...HOST, bundle }, edge),
    ).rejects.toThrow(/just install-rust/);
    expect(did).toEqual([]);
  });

  test("a prompt that is not ready leaves the mod installed and says so", async () => {
    const { bundle } = checkout();
    const { edge, input } = fakeEdge({}, {
      read: async () => ({ inMode: true, screen: READY_SCREEN }),
      type: async () => ({ kind: "typed" }),
    });
    await expect(
      bandOn(session(), IN_PANE, typeInPane(input), { ...HOST, bundle }, edge),
    ).rejects.toThrow(
      /installed, but \/reload-plugins was not typed: .*copy mode/,
    );
  });
});

describe("lane B, statusline", () => {
  test("on ends Claude Code, then types one line into its shell that starts it again under the launcher, back in its worktree, on the same session", async () => {
    const { edge, did, input } = fakeEdge();
    // The line is the restart's report, which the act line says.
    await expect(restartClaude(session(), TMUX, input.read, HOST, edge)).resolves.toBe(
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
    const { edge, input } = fakeEdge({ followed: async () => false });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(
      `did not come back attached within ${ATTACH_PATIENCE_MS / 1000} s of \`${RESTART_LINE()}\` — the pane says why`,
    );
  });

  // The preload starts the launcher under the node the line's shell finds,
  // so a node it would refuse ends nothing.
  test("a PATH with no node the launcher can run under leaves Claude Code running", async () => {
    const { edge, did, input } = fakeEdge({
      launcherNode: () => ({
        kind: "refused",
        why: "no `node` on PATH to run the attach launcher",
      }),
    });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(
      "Claude Code in %7 was left running, under the PATH it was started with: no `node` on PATH to run the attach launcher",
    );
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  // Claude Code's auto-update removes the release a path names; `claude`
  // reruns from history after it.
  test("a release the shell would not find as `claude` is named by its path", async () => {
    const { edge, did, input } = fakeEdge({
      onPath: () => "/usr/local/bin/claude-other",
    });
    await restartClaude(session(), TMUX, input.read, HOST, edge);
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
    const { edge, did, input } = fakeEdge({
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
    await restartClaude(session(), TMUX, input.read, HOST, edge);
    expect(did.join("\n")).not.toContain("secret");
    expect(did).toContain(
      `shell cd /work && CLAUDE_CONFIG_DIR='/u/.claude zai' CC_CANDYBAR_CONFIG=/u/lab.json5 BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions --resume ${SID}`,
    );
  });

  // A relative path among its flags resolves against where Claude Code was
  // started, which is where the line starts it again.
  test("a session started inside its worktree starts there again, with no --worktree", async () => {
    const { edge, did, input } = fakeEdge({
      paneDir: async () => "/work/.claude/worktrees/feat+tree/sub",
    });
    await restartClaude(session(), TMUX, input.read, HOST, edge);
    expect(did).toContain(
      `shell cd /work/.claude/worktrees/feat+tree/sub && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --dangerously-skip-permissions --resume ${SID}`,
    );
  });

  test("a pane whose directory cannot be read once Claude Code exited types nothing, and names the line", async () => {
    const { edge, did, input } = fakeEdge({
      paneDir: async () => {
        throw new Error("no such pane");
      },
    });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(
      `exited, but the directory it was started in could not be read (no such pane), so it was not started again — start it with \`cd /work && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions --resume ${SID}\``,
    );
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  test("a Claude Code that does not exit has no line typed for it", async () => {
    const { edge, did, input } = fakeEdge({ exited: async () => false });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(/did not exit within/);
    expect(did.at(-1)).toBe("terminate 4242");
  });

  test.each([
    ["attach-preload.cjs", "/opt/candybar/dist/attach-preload.cjs"],
    ["bun-attach.js", "/opt/candybar/dist/cc-extra/src/bun-attach.js"],
  ])(
    "a build with no %s is refused before anything in the pane is touched",
    async (missing, file) => {
      const { edge, did, input } = fakeEdge({
        fileExists: (f) => !f.endsWith(missing),
      });
      await expect(
        restartClaude(session(), TMUX, input.read, HOST, edge),
      ).rejects.toThrow(`${file} is not there — run \`cc-candybar install\``);
      expect(did).toEqual([]);
    },
  );

  // Claude Code writes a session's transcript with its first message, and
  // `--resume` of one with none finds no conversation: such a session starts
  // afresh under its own id (`--session-id`), so lane B's wait for its
  // subscriber, which names that id, is answered by the restart.
  test("a session with no conversation yet starts afresh on the same id, and its statusline follows lane B", async () => {
    const { edge, did, input } = fakeEdge({ presence: () => "absent" });
    await expect(
      restartClaude(session("no"), TMUX, input.read, HOST, edge),
    ).resolves.toContain(
      `starting ${SID} afresh, since it had no conversation yet`,
    );
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
    const { edge, did, input } = fakeEdge({
      presence: () => (written ? "present" : "absent"),
      terminate: (pid) => {
        did.push(`terminate ${pid}`);
        written = true;
      },
    });
    await expect(
      restartClaude(session("no"), TMUX, input.read, HOST, edge),
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
      const { edge, did, input } = fakeEdge({ presence: () => "absent" });
      await expect(
        restartClaude(session(answered), TMUX, input.read, HOST, edge),
      ).rejects.toThrow(reason);
      expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
    },
  );

  // A stat that fails for another reason than absence says nothing of the
  // conversation: before the kill, Claude Code is left running; after it,
  // nothing is started on a guess.
  test("a transcript stat could not see past is refused before the kill", async () => {
    const { edge, did, input } = fakeEdge({
      presence: (file) => ({ path: file, error: "EACCES" }),
    });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(
      /was left running: whether session .* could not be seen \(EACCES\)/,
    );
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  test("a transcript stat could not see past once Claude Code exited starts nothing", async () => {
    let ended = false;
    const { edge, did, input } = fakeEdge({
      presence: (file) => (ended ? { path: file, error: "ELOOP" } : "present"),
      terminate: () => {
        ended = true;
      },
    });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(
      `(ELOOP), so it was not started again — start it with \`${RESTART_LINE()}\``,
    );
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  test("a line that cannot be typed once Claude Code exited is named for the user to type", async () => {
    const { edge, input } = fakeEdge({
      presence: () => "absent",
      typeShellLine: async () => {
        throw new Error("server exited");
      },
    });
    await expect(
      restartClaude(session("no"), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(
      `exited, but the line could not be typed into its pane (server exited), so it was not started again — start it with \`${RESTART_LINE(`--session-id ${SID}`)}\``,
    );
  });

  test("a Claude Code that does not exit is not started again, and the wait says why", async () => {
    const { edge, did, input } = fakeEdge({ exited: async () => false });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(`did not exit within ${EXIT_PATIENCE_MS / 1000} s`);
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  // The screen of a session mid-turn, as tmux captured it (2.1.289): ending
  // Claude Code here would end the turn. The screen is judged at the kill, so
  // a turn started during the module-graph read is seen.
  test("a Claude Code in the middle of a turn is refused before Claude Code is ended", async () => {
    const { edge, did, input } = fakeEdge({}, {
      read: async () => ({
        inMode: false,
        screen: [
          "✽ Processing… (26s · ↓ 2.0k tokens · thought for 15s)",
          ...READY_SCREEN,
        ],
      }),
      type: async () => ({ kind: "typed" }),
    });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(/in the middle of a turn/);
    // Refused at the kill, before anything is typed.
    expect(did.some((d) => /^(shell|terminate)/.test(d))).toBe(false);
  });

  // A stash and a pending dialog die with the process; copy mode is a screen
  // nothing can be read past.
  test.each([
    ["copy mode", { inMode: true, screen: READY_SCREEN }, /copy mode/],
    [
      "a held stash",
      { inMode: false, screen: ["  › stashed", ...READY_SCREEN] },
      /stashed prompt/,
    ],
    [
      "a dialog",
      { inMode: false, screen: ["Allow this tool call?", "  ❯ 1. Yes"] },
      /not at its prompt/,
    ],
  ])(
    "a pane showing %s is refused before Claude Code is ended",
    async (_what, snapshot, reason) => {
      const { edge, did, input } = fakeEdge({}, {
        read: async () => snapshot,
        type: async () => ({ kind: "typed" }),
      });
      await expect(
        restartClaude(session(), TMUX, input.read, HOST, edge),
      ).rejects.toThrow(reason);
      expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
    },
  );

  test("a Claude Code the pane no longer shows by the time of the kill is not killed", async () => {
    const { edge: base } = fakeEdge();
    const first = await base.paneClaude(TMUX);
    let reads = 0;
    const { edge, did, input } = fakeEdge({
      paneClaude: async () => (reads++ === 0 ? first : { ...first, pid: 5151 }),
    });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(/no longer the process the restart read \(pid 4242\)/);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  test.each([
    ["❯ ", false],
    ["❯\u00a0", false],
    ["❯ half a thought", true],
  ])("draftShown with the prompt row %j is %p", async (row, draft) => {
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
  ])("turnRunning(%j) is %p", async (line, running) => {
    expect(turnRunning({ inMode: false, screen: [line] })).toBe(running);
  });

  test("a Claude Code already under the attach launcher is left running", async () => {
    const { edge, did, input } = fakeEdge({
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
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).resolves.toContain("already runs under the attach launcher");
    expect(did).toEqual([]);
  });

  test("a Claude Code that is its pane's first process is refused: nothing would restart it", async () => {
    const { edge, did, input } = fakeEdge({
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
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(/first process of pane %7/);
    expect(did).toEqual([]);
  });

  // An npm install runs `node …/cli.js`: no module graph for the launcher to
  // run, so exiting it would leave the pane at its shell.
  test("a Claude Code the launcher cannot start is refused before Claude Code is ended", async () => {
    const { edge, did, input } = fakeEdge({
      moduleGraph: async () => ({
        ok: false,
        reason: "no-bun-module-graph-trailer",
      }),
    });
    await expect(
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(
      /runs \/u\/\.local\/share\/claude\/versions\/2\.1\.299, which the attach launcher cannot start \(no-bun-module-graph-trailer\) — .*native Claude Code install .*left running/,
    );
    expect(did).toEqual([]);
  });

  test.each([
    [
      '{"ok":false,"reason":"no-bun-module-graph-trailer"}\n',
      "no-bun-module-graph-trailer",
    ],
    [
      '{"ok":false,"reason":"binary-unreadable","detail":"EACCES"}',
      "binary-unreadable: EACCES",
    ],
    ["", null],
    ["Error: Cannot find module", null],
    ['{"ok":true}', null],
  ])(
    "the module graph reader's output %j refuses with %p",
    async (stdout, reason) => {
      expect(refusalOf(stdout)).toBe(reason);
    },
  );

  test("a flag cc-candybar cannot carry refuses the restart before Claude Code is ended", async () => {
    const { edge, did, input } = fakeEdge({
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
      restartClaude(session(), TMUX, input.read, HOST, edge),
    ).rejects.toThrow(/--brand-new-flag/);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });
});

// [LAW:behavior-not-structure] The line is typed into whatever shell the
// pane runs, and kept in its history: every shell installed here runs it.
const SHELLS = [
  "/bin/sh",
  "/opt/homebrew/bin/zsh",
  "/opt/homebrew/bin/bash",
  "/opt/homebrew/bin/fish",
].filter((shell) => fs.existsSync(shell));

describe("the line a restart types", () => {
  test.each(SHELLS)(
    "runs under %s: in its directory, with its variables, as `claude` on PATH",
    (shell) => {
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
    },
  );
});

describe("relaunchArgs", () => {
  test.each([
    [["claude"], []],
    [
      ["claude", "--dangerously-skip-permissions"],
      ["--dangerously-skip-permissions"],
    ],
    [["claude", "--resume", "old-id", "--verbose"], ["--verbose"]],
    [["claude", "-r", "--verbose"], ["--verbose"]],
    [["claude", "-c", "--session-id", "u", "--fork-session"], []],
    [
      ["claude", "--add-dir", "a", "b", "--model=opus"],
      ["--add-dir", "a", "b", "--model=opus"],
    ],
    [
      ["claude", "fix the bug", "--effort", "high"],
      ["--effort", "high"],
    ],
    [["claude", "--", "--not-a-flag"], []],
    [
      ["claude", "--append-system-prompt", "-be terse"],
      ["--append-system-prompt", "-be terse"],
    ],
    // The worktree is read off the directory the session runs in.
    [["claude", "--worktree", "gone"], []],
    [
      ["claude", "-w", "fix", "--model", "opus"],
      ["--model", "opus"],
    ],
  ])("%j carries %j", async (argv, kept) => {
    expect(relaunchArgs(argv)).toEqual({ kind: "args", args: kept });
  });

  test.each([
    [["claude", "--mystery"], /--mystery/],
    [["claude", "--model"], /--model and no value/],
  ])("%j is refused", async (argv, reason) => {
    const out = relaunchArgs(argv);
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(reason);
  });

  // `--resume` of a session with no transcript finds no conversation; a fresh
  // start on the same id keeps the id the session's picks are held under.
  test("a session is resumed, or with no conversation yet started afresh, on the same id", async () => {
    expect(sessionArgs({ kind: "resume", sessionId: SID })).toEqual([
      "--resume",
      SID,
    ]);
    expect(sessionArgs({ kind: "fresh", sessionId: SID })).toEqual([
      "--session-id",
      SID,
    ]);
  });
});

describe("startPlace", () => {
  // Claude Code makes `--worktree feat/x` at `<repo>/.claude/worktrees/feat+x`
  // and runs there; naming it again from where it was started goes back in —
  // whether the session was started with `--worktree` or entered it later.
  test.each([
    ["/src", "/src", "/src", []],
    [
      "/src",
      "/src/.claude/worktrees/tidy-sunset",
      "/src",
      ["--worktree", "tidy-sunset"],
    ],
    [
      "/src",
      "/src/.claude/worktrees/feat+x.y",
      "/src",
      ["--worktree", "feat/x.y"],
    ],
    [
      "/src/sub",
      "/src/.claude/worktrees/fix/sub/dir",
      "/src/sub",
      ["--worktree", "fix"],
    ],
    ["/", "/.claude/worktrees/top", "/", ["--worktree", "top"]],
    // Started inside the worktree: it starts there again as it is.
    [
      "/src/.claude/worktrees/fix",
      "/src/.claude/worktrees/fix",
      "/src/.claude/worktrees/fix",
      [],
    ],
    [
      "/src/.claude/worktrees/fix/sub",
      "/src/.claude/worktrees/fix/other",
      "/src/.claude/worktrees/fix/sub",
      [],
    ],
    // Started in another worktree — a sibling whose name extends this one's
    // included: `--worktree` from there would make one inside it.
    [
      "/src/.claude/worktrees/fix2",
      "/src/.claude/worktrees/fix",
      "/src",
      ["--worktree", "fix"],
    ],
    [
      "/src/.claude/worktrees/a/sub",
      "/src/.claude/worktrees/b",
      "/src",
      ["--worktree", "b"],
    ],
    // A directory named like a worktree holder but holding none is no worktree.
    ["/src", "/src/.claude/worktrees", "/src", []],
    // Where it was started not known: the worktree's repository, else where
    // it runs.
    [null, "/src/.claude/worktrees/fix/sub", "/src", ["--worktree", "fix"]],
    [null, "/src/sub", "/src/sub", []],
  ])(
    "started in %s, running in %s, starts in %s with %j",
    async (startDir, cwd, dir, args) => {
      expect(startPlace(startDir, cwd)).toEqual({ dir, args });
    },
  );
});

describe("the production edge's readers", () => {
  test("barPanesOf names the panes started to draw the session's pane's bar", async () => {
    const listPanes = [
      "%1 ",
      '%9 /usr/bin/node /x/cli.js bar-pane "%7"',
      "%10 node cli.js bar-pane %8",
      "%11 node cli.js bar-pane %7",
      "%12 node cli.js bar-pane \\%7",
      "%13 vim notes",
      "%14 node cli.js bar-pane %70",
    ].join("\n");
    expect(barPanesOf(listPanes, "%7")).toEqual(["%9", "%11", "%12"]);
  });

  test("runsAttached reads a cc-attach launcher at or above the foreground job, below the pane", async () => {
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

  test("runsAttached reads a cc-attach launcher that is the pane's own first process", async () => {
    const table = [
      "  10     1 node /home/u/cc-extra/bin/cc-attach",
      "  20     1 /bin/zsh -l",
    ].join("\n");
    expect(runsAttached(table, 10, 10)).toBe(true);
    // Nothing above the pane's first process is the pane's.
    expect(runsAttached("  20 10 /bin/zsh\n  10 1 cc-attach", 20, 20)).toBe(
      false,
    );
  });
});

// A request of the session, as the renderer holds it: its pane, and what a
// lane act carries of it.
const requestIn = (
  tmux: TmuxHint | null | undefined,
): CheckedRenderRequest =>
  ({
    hookData: {
      session_id: SID,
      transcript_path: TRANSCRIPT,
      context_window: { current_usage: { input_tokens: 1 } },
    },
    hints: { tmux },
    requested: { projectDir: "/p" },
  }) as unknown as CheckedRenderRequest;

const switches = (on: Partial<LaneSwitches>): LaneSwitches => ({
  band: false,
  statusline: false,
  pane: false,
  tmuxStatus: false,
  ...on,
});

// [LAW:verifiable-goals] What a lane switch asks of the host: the act its
// setup takes, once, when the session's own click moved it, or owed to the
// session's next click or request when there was no pane to act in.
describe("the acts a lane switch asks", () => {
  const owner = () => {
    const logs: string[] = [];
    const refused: string[] = [];
    let minted = 0;
    const acts = new LaneActs({
      ask: (effects, act) =>
        void effects.push({ ...act, id: ++minted as EffectId }),
      refused: (session, reason) => void refused.push(`${session}: ${reason}`),
      log: (level, msg) => void logs.push(`${level} ${msg}`),
    });
    const effects: Effect[] = [];
    // The acts asked since the last look, without their ids.
    const asked = (): ActRequest[] =>
      effects.splice(0).map(({ id: _, ...act }) => act as ActRequest);
    return { acts, logs, refused, effects, asked };
  };

  const PANE_ON: ActRequest = {
    kind: "surface",
    surface: "pane",
    on: true,
    session: SID,
    pane: TMUX,
  };

  // Whatever control moved the switch — the toggle, ↺, ↶ undo, a preset, a
  // save — reaches the setup the same way: the click measured before and
  // after its commit (journaled, src/renderer/verbs/index.ts).
  test("a click that moves a switch asks its lane's act in its own turn, and only its lane's", () => {
    const { acts, logs, effects, asked } = owner();
    acts.clicked(SID, requestIn(TMUX), switches({}), switches({ pane: true }), effects);
    expect(asked()).toEqual([PANE_ON]);
    expect(logs).toEqual([
      `info lane: pane on — asked by=click (session=${SID})`,
    ]);
    // A click that moves no switch asks nothing.
    acts.clicked(
      SID,
      requestIn(TMUX),
      switches({ pane: true }),
      switches({ pane: true }),
      effects,
    );
    expect(asked()).toEqual([]);
  });

  test.each([
    [
      "band",
      {
        kind: "surface",
        surface: "band",
        on: true,
        session: SID,
        pane: IN_PANE,
        at: {
          projectDir: "/p",
          claudeConfigDir: null,
          transcript: TRANSCRIPT,
          answered: "yes",
        },
      },
    ],
    [
      "statusline",
      {
        kind: "restart-claude",
        session: SID,
        pane: TMUX,
        at: {
          projectDir: "/p",
          claudeConfigDir: null,
          transcript: TRANSCRIPT,
          answered: "yes",
        },
      },
    ],
  ] as const)("%s on asks its act, carrying the session as the request reported it", (lane, act) => {
    const { acts, effects, asked } = owner();
    acts.clicked(SID, requestIn(TMUX), switches({}), switches({ [lane]: true }), effects);
    expect(asked()).toEqual([act]);
  });

  test("pane off asks the bar panes closed", () => {
    const { acts, effects, asked } = owner();
    acts.clicked(SID, requestIn(TMUX), switches({ pane: true }), switches({}), effects);
    expect(asked()).toEqual([{ ...PANE_ON, on: false }]);
  });

  test.each(["band", "statusline", "tmuxStatus"] as const)(
    "%s off asks nothing, and says why",
    (lane) => {
      const { acts, logs, effects, asked } = owner();
      acts.clicked(SID, requestIn(TMUX), switches({ [lane]: true }), switches({}), effects);
      expect(asked()).toEqual([]);
      expect(logs).toEqual([
        expect.stringMatching(new RegExp(`^info lane: ${lane} off — nothing to stop: `)),
      ]);
    },
  );

  test("the tmux status line asks no act: its row is the host's, by the renderer's declaration", () => {
    const { acts, logs, effects, asked } = owner();
    acts.clicked(SID, requestIn(TMUX), switches({}), switches({ tmuxStatus: true }), effects);
    expect(asked()).toEqual([]);
    expect(logs).toEqual([
      `info lane: tmuxStatus on — the daemon draws %7's bar in its status line by=click (session=${SID})`,
    ]);
  });

  test("pane off in a session with no tmux pane has nothing to close, and says so", () => {
    const { acts, logs, refused, effects, asked } = owner();
    acts.clicked(SID, requestIn(null), switches({ pane: true }), switches({}), effects);
    expect(asked()).toEqual([]);
    expect(refused).toEqual([]);
    expect(logs).toEqual([
      expect.stringMatching(/^info lane: pane off — no bar pane to close: .*not running inside tmux/),
    ]);
  });

  test.each([
    ["statusline", undefined, "predates this daemon"],
    ["statusline", null, "not running inside tmux"],
    ["pane", null, "not running inside tmux"],
    ["tmuxStatus", null, "not running inside tmux"],
  ] as const)(
    "%s on in a session whose tmux hint is %p is refused on its bar, saying why, and asks nothing",
    (lane, tmux, why) => {
      const { acts, logs, refused, effects, asked } = owner();
      acts.clicked(SID, requestIn(tmux), switches({}), switches({ [lane]: true }), effects);
      expect(asked()).toEqual([]);
      expect(refused).toEqual([
        expect.stringMatching(new RegExp(`^${SID}: lane: ${lane} on: .*${why}`)),
      ]);
      expect(logs).toEqual([
        expect.stringMatching(new RegExp(`^warn lane: ${lane} on: .*${why}.* by=click`)),
      ]);
    },
  );

  test("band on outside tmux still asks its install, carrying why the session has no pane", () => {
    const { acts, refused, effects, asked } = owner();
    acts.clicked(SID, requestIn(null), switches({}), switches({ band: true }), effects);
    expect(refused).toEqual([]);
    expect(asked()).toEqual([
      expect.objectContaining({
        kind: "surface",
        surface: "band",
        pane: tmuxPaneOf(null),
      }),
    ]);
  });

  // A daemon restarted under a bar the old one drew: the toggle is clicked
  // before this renderer holds a request of the session.
  test("a click before the session's first request owes its act to that request", () => {
    const { acts, logs, effects, asked } = owner();
    acts.clicked(SID, null, switches({}), switches({ pane: true }), effects);
    expect(asked()).toEqual([]);
    acts.noted(requestIn(TMUX), switches({ pane: true }), effects);
    expect(asked()).toEqual([PANE_ON]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane on — asked by=owed (session=${SID})`,
    ]);
    // Owed once: the next request asks nothing.
    acts.noted(requestIn(TMUX), switches({ pane: true }), effects);
    expect(asked()).toEqual([]);
  });

  test("a lane toggled on and off again before the session's first request owes nothing", () => {
    const { acts, logs, effects, asked } = owner();
    acts.clicked(SID, null, switches({}), switches({ pane: true, band: true }), effects);
    acts.clicked(
      SID,
      null,
      switches({ pane: true, band: true }),
      switches({ band: true }),
      effects,
    );
    acts.clicked(SID, null, switches({ band: true }), switches({}), effects);
    acts.noted(requestIn(TMUX), switches({}), effects);
    expect(asked()).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed band on,pane on (session=${SID})`,
      `info lane: owed band on (session=${SID})`,
      `info lane: owed nothing (session=${SID})`,
    ]);
  });

  // Another session's save to the file both read, or a hand edit, between the
  // click and the request.
  test("an owed lane whose switch is back where it stood by the first request owes nothing", () => {
    const { acts, logs, effects, asked } = owner();
    acts.clicked(SID, null, switches({}), switches({ pane: true }), effects);
    acts.noted(requestIn(TMUX), switches({}), effects);
    expect(asked()).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane off — nothing owed: its switch is back where the lane is by=owed (session=${SID})`,
    ]);
  });

  // A request whose draw failed before its arrival settled anything: the
  // session's next click is the first event that can.
  test("a click once the session's request is held settles what earlier clicks owed", () => {
    const { acts, logs, effects, asked } = owner();
    acts.clicked(SID, null, switches({}), switches({ pane: true }), effects);
    acts.clicked(SID, requestIn(TMUX), switches({ pane: true }), switches({}), effects);
    // Nothing is owed after it: a switch moved later by anything but a click
    // asks nothing.
    acts.noted(requestIn(TMUX), switches({ pane: true }), effects);
    expect(asked()).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane off — nothing owed: its switch is back where the lane is by=click (session=${SID})`,
    ]);
  });

  test("a click that settles an earlier click's owed lane says which lane each asked", () => {
    const { acts, logs, effects, asked } = owner();
    acts.clicked(SID, null, switches({}), switches({ pane: true }), effects);
    acts.clicked(
      SID,
      requestIn(TMUX),
      switches({ pane: true }),
      switches({ pane: true, tmuxStatus: true }),
      effects,
    );
    expect(asked()).toEqual([PANE_ON]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane on — asked by=owed (session=${SID})`,
      `info lane: tmuxStatus on — the daemon draws %7's bar in its status line by=click (session=${SID})`,
    ]);
  });

  test("owed setups are kept for 1024 sessions; the oldest is dropped, and said", () => {
    const { acts, logs, effects } = owner();
    for (let i = 0; i <= 1024; i++)
      acts.clicked(sessionIdOf(`s${i}`), null, switches({}), switches({ pane: true }), effects);
    expect(logs.filter((l) => l.startsWith("warn"))).toEqual([
      `warn lane: owed dropped sid="s0" lanes=pane`,
    ]);
  });
});

// [LAW:verifiable-goals] The host's performer of the acts a lane switch asks:
// one setup of a pane at a time, a slash line kept out of a pane a setup
// holds, and how each ended handed back as its outcome.
describe("the host performing lane acts", () => {
  let ids = 0;
  const restart = (): HostAct => ({
    kind: "restart-claude",
    id: ++ids as EffectId,
    session: SID,
    pane: TMUX,
    at: session(),
  });
  const performer = (
    edge: LaneEdge,
    input: Partial<ClaudeInputEdge> = {},
    host = HOST,
  ) => {
    const logs: string[] = [];
    const missing = async (): Promise<never> => {
      throw new Error("not in this test");
    };
    const acts = new Acts({
      launch: missing,
      claudeInput: {
        read: async () => ({ inMode: false, screen: READY_SCREEN }),
        type: async () => ({ kind: "typed" }),
        ...input,
      },
      run: missing,
      applyUpdate: missing,
      lanes: { edge, host },
      closing: () => false,
      log: (level, msg) => void logs.push(`${level} ${msg}`),
    });
    return { acts, logs };
  };

  // Toggled on, off and on again inside one restart: a second restart of the
  // pane would type into the first.
  test("one pane's setups run one at a time, each after the last has finished", async () => {
    let exit!: (gone: boolean) => void;
    const { edge, did } = fakeEdge({
      exited: () => new Promise((r) => (exit = r)),
    });
    const { acts } = performer(edge);
    const first = acts.perform(restart());
    const second = acts.perform(restart());
    await new Promise((r) => setImmediate(r));
    // The first restart waits for Claude Code to exit; nothing else has run.
    expect(did.filter((d) => d.startsWith("terminate"))).toEqual([
      "terminate 4242",
    ]);
    exit(true);
    await first;
    await new Promise((r) => setImmediate(r));
    expect(did.filter((d) => d.startsWith("terminate"))).toEqual([
      "terminate 4242",
      "terminate 4242",
    ]);
    exit(true);
    await second;
  });

  test("a slash line for a session a restart holds is refused at once, saying why, and typed nowhere", async () => {
    let exit!: (gone: boolean) => void;
    const { edge } = fakeEdge({
      exited: () => new Promise((r) => (exit = r)),
    });
    const { acts } = performer(edge);
    const restarting = acts.perform(restart());
    await new Promise((r) => setImmediate(r));
    expect(
      await acts.perform({
        kind: "type-slash",
        id: ++ids as EffectId,
        session: SID,
        pane: TMUX,
        line: "/compact" as never,
      }),
    ).toEqual({
      kind: "refused",
      reason: "/compact: a restart holds pane %7 — click again once it has finished",
    });
    exit(true);
    await restarting;
  });

  // Two quick slash clicks: each reads the pane before it types, so the
  // second must read it only once the first has typed.
  test("one pane's slash lines are typed one at a time, each after the last has finished", async () => {
    const typing: string[] = [];
    let typed!: () => void;
    const { acts } = performer(fakeEdge().edge, {
      type: async (_pane, line) => {
        typing.push(`start ${line}`);
        await new Promise<void>((r) => (typed = r));
        typing.push(`end ${line}`);
        return { kind: "typed" };
      },
    });
    const slash = (line: string): HostAct => ({
      kind: "type-slash",
      id: ++ids as EffectId,
      session: SID,
      pane: TMUX,
      line: line as never,
    });
    const first = acts.perform(slash("/compact"));
    const second = acts.perform(slash("/clear"));
    await new Promise((r) => setImmediate(r));
    expect(typing).toEqual(["start /compact"]);
    typed();
    await first;
    await new Promise((r) => setImmediate(r));
    expect(typing).toEqual(["start /compact", "end /compact", "start /clear"]);
    typed();
    expect(await second).toEqual({ kind: "ok" });
  });

  // A click that types a slash and switches the statusline lane on: the
  // restart its landing asks must not exit Claude Code under the line.
  test("a restart asked while a slash line is typing waits for it to finish", async () => {
    const order: string[] = [];
    let typed!: () => void;
    const base = fakeEdge().edge;
    const edge: LaneEdge = {
      ...base,
      paneClaude: async (tmux) => {
        order.push("restart reads the pane");
        return base.paneClaude(tmux);
      },
    };
    const { acts } = performer(edge, {
      type: async () => {
        order.push("slash starts");
        await new Promise<void>((r) => (typed = r));
        order.push("slash typed");
        return { kind: "typed" };
      },
    });
    const slash = acts.perform({
      kind: "type-slash",
      id: ++ids as EffectId,
      session: SID,
      pane: TMUX,
      line: "/compact" as never,
    });
    const restarting = acts.perform(restart());
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["slash starts"]);
    typed();
    await slash;
    await restarting;
    expect(order.slice(0, 3)).toEqual([
      "slash starts",
      "slash typed",
      "restart reads the pane",
    ]);
  });

  // One click switches band and statusline on: the band asks first.
  test("a session's band install ends, its reload typed, before a restart it asked after begins", async () => {
    const order: string[] = [];
    let installed!: () => void;
    const base = fakeEdge().edge;
    const edge: LaneEdge = {
      ...base,
      claude: async (args) => {
        if (args.includes("install")) {
          order.push("install starts");
          await new Promise<void>((r) => (installed = r));
        }
      },
      paneClaude: async (tmux) => {
        order.push("restart reads the pane");
        return base.paneClaude(tmux);
      },
    };
    const { bundle } = checkout();
    const { acts } = performer(
      edge,
      {
        type: async () => {
          order.push("reload typed");
          return { kind: "typed" };
        },
      },
      { ...HOST, bundle },
    );
    const band = acts.perform({
      kind: "surface",
      surface: "band",
      on: true,
      id: ++ids as EffectId,
      session: SID,
      pane: IN_PANE,
      at: session(),
    });
    const restarting = acts.perform(restart());
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["install starts"]);
    installed();
    await band;
    await restarting;
    expect(order.slice(0, 3)).toEqual([
      "install starts",
      "reload typed",
      "restart reads the pane",
    ]);
  });

  // Splitting a bar pane types nothing into Claude Code's prompt.
  test("a slash line while a bar pane opens under its pane is typed, after the split", async () => {
    let split!: () => void;
    const { edge } = fakeEdge({
      openBarPane: () =>
        new Promise((r) => (split = () => r("%9"))),
    });
    const { acts } = performer(edge);
    const opening = acts.perform({
      kind: "surface",
      surface: "pane",
      on: true,
      id: ++ids as EffectId,
      session: SID,
      pane: TMUX,
    });
    await new Promise((r) => setImmediate(r));
    const slash = acts.perform({
      kind: "type-slash",
      id: ++ids as EffectId,
      session: SID,
      pane: TMUX,
      line: "/compact" as never,
    });
    split();
    await opening;
    expect(await slash).toEqual({ kind: "ok" });
  });

  test("a restart that fails after its click is a failed outcome naming the lane, on its act line", async () => {
    const { edge } = fakeEdge({ exited: async () => false });
    const { acts, logs } = performer(edge);
    const outcome = await acts.perform(restart());
    expect(outcome).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/^lane: statusline on: Claude Code in %7 did not exit/),
    });
    expect(logs).toEqual([
      expect.stringMatching(
        new RegExp(`^warn act kind=restart-claude sid=${SID} id=\\d+ outcome=failed — lane: statusline on: Claude Code in %7 did not exit`),
      ),
    ]);
  });

  // [LAW:verifiable-goals] The input a restart judges the pane by is read
  // through the one claude-input edge Acts holds, the one its slash lines are
  // typed through.
  test("a restart reads the pane's prompt through the claude-input edge Acts is given", async () => {
    const { edge, did } = fakeEdge();
    const read: string[] = [];
    const { acts } = performer(edge, {
      read: async (hint) => {
        read.push(hint.pane);
        return {
          inMode: false,
          screen: ["✽ Processing… (26s · ↓ 2.0k tokens)", ...READY_SCREEN],
        };
      },
    });
    expect(await acts.perform(restart())).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/in the middle of a turn/),
    });
    expect(read).toEqual([TMUX.pane]);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  test("a setup refused before it touches the pane is a refused outcome the user can act on", async () => {
    const { edge, did } = fakeEdge({ fileExists: () => false });
    const { acts } = performer(edge);
    expect(await acts.perform(restart())).toEqual({
      kind: "refused",
      reason: expect.stringMatching(/^lane: statusline on: .* is not there — run `cc-candybar install`/),
    });
    expect(did).toEqual([]);
  });
});
