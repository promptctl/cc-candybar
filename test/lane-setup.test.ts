// brandon-menus-sjhy.amf — what a lane's toggle starts beyond the daemon's own
// gate: the effects the renderer asks for (src/renderer/lane-surfaces.ts), the
// host's setups driven through fakes of every effect (src/daemon/lane-setup.ts),
// and the pure readers the production edge folds tmux's and ps's answers with
// (src/daemon/lane-edge.ts).

import { sessionEnv } from "../src/daemon/foundations/session-env";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  BAND_PLUGIN,
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
import { LaneSurfaces } from "../src/renderer/lane-surfaces";
import { Acts } from "../src/renderer/acts";
import type { Effect, EffectId } from "../src/renderer-interface/interface";
import {
  relaunchArgs,
  sessionArgs,
  startPlace,
} from "../src/daemon/claude-relaunch";
import { attachCommandLine } from "../src/attach-launcher";
import { refusalOf, runsAttached, barPanesOf } from "../src/daemon/lane-edge";
import { draftShown, turnRunning } from "../src/claude-input/prompt-screen";
import { BadVerbArgs } from "../src/daemon/foundations/verb-error";
import { SessionState } from "../src/renderer/session-state";
import { instantOf } from "../src/utils/instant";
import type { Lane, LaneSwitches } from "../src/config/lanes";
import type { TmuxHint } from "../src/tmux-hint";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const SID = sessionIdOf("1f6e0c2a-0d0e-4a52-9d1b-2b0b0f0e0a11");
const TMUX: TmuxHint = {
  socket: "/tmp/tmux-1/default",
  pane: "%7",
  truecolor: null,
};
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
function fakeEdge(over: Partial<LaneEdge> = {}): {
  edge: LaneEdge;
  did: string[];
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
  const edge: LaneEdge = {
    claudeInput: {
      read: async () => ({ inMode: false, screen: READY_SCREEN }),
      type: async (_hint, line) => {
        did.push(`type ${line}`);
        return { kind: "typed" };
      },
    },
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
        `claude ${args.join(" ")} [${session.claudeConfigDir ?? "-"}]`,
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
  test("on opens a bar pane under the session's pane, following this daemon", async () => {
    const { edge, did } = fakeEdge();
    const out = await LANE_SETUP.pane.on(session(), HOST, edge);
    expect(out).toEqual({ kind: "done", said: "opened bar pane %9 under %7" });
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`,
    ]);
  });

  test("on with a bar pane already open opens no second one", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9"] });
    expect(await LANE_SETUP.pane.on(session(), HOST, edge)).toEqual({
      kind: "done",
      said: "bar pane %9 already draws %7's bar",
    });
    expect(did).toEqual([]);
  });

  test("off in a session with no tmux pane has nothing to close, and says so", async () => {
    const { edge, did } = fakeEdge();
    expect(
      await LANE_SETUP.pane.off(session({ tmux: null }), HOST, edge),
    ).toEqual({
      kind: "done",
      said: expect.stringMatching(
        /^no bar pane to close: .*not running inside tmux/,
      ),
    });
    expect(did).toEqual([]);
  });

  test("off closes every bar pane drawing the session's bar", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9", "%11"] });
    await LANE_SETUP.pane.off(session(), HOST, edge);
    expect(did).toEqual(["close %9", "close %11"]);
  });

  test.each([
    [undefined, "predates this daemon"],
    [null, "not running inside tmux"],
  ])(
    "a session with tmux hint %p is refused, saying why",
    async (tmux, why) => {
      const { edge } = fakeEdge();
      await expect(
        LANE_SETUP.pane.on(session({ tmux }), HOST, edge),
      ).rejects.toThrow(new RegExp(why));
    },
  );
});

// The part of a setup that outlives its click.
function finished(out: LaneOutcome): Promise<string> {
  if (out.kind !== "underway")
    throw new Error(`expected underway: ${out.said}`);
  return out.finished;
}

describe("lane A, band", () => {
  test("on installs the band mod from the checkout's marketplace, then reloads plugins, off the click", async () => {
    const { root, bundle } = checkout();
    const { edge, did } = fakeEdge();
    const out = await LANE_SETUP.band.on(
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

  test("a daemon not run from a checkout is refused in the click, before anything is installed", async () => {
    const { edge, did } = fakeEdge();
    await expect(LANE_SETUP.band.on(session(), HOST, edge)).rejects.toThrow(
      BadVerbArgs,
    );
    expect(did).toEqual([]);
  });

  test("an unbuilt native client is refused in the click, naming the build", async () => {
    const { bundle } = checkout();
    const { edge, did } = fakeEdge({ fileExists: () => false });
    await expect(
      LANE_SETUP.band.on(session(), { ...HOST, bundle }, edge),
    ).rejects.toThrow(/just install-rust/);
    expect(did).toEqual([]);
  });

  test("a prompt that is not ready leaves the mod installed and says so", async () => {
    const { bundle } = checkout();
    const { edge } = fakeEdge({
      claudeInput: {
        read: async () => ({ inMode: true, screen: READY_SCREEN }),
        type: async () => ({ kind: "typed" }),
      },
    });
    await expect(
      finished(await LANE_SETUP.band.on(session(), { ...HOST, bundle }, edge)),
    ).rejects.toThrow(
      /installed, but \/reload-plugins was not typed: .*copy mode/,
    );
  });
});

describe("lane B, statusline", () => {
  test("on ends Claude Code, then types one line into its shell that starts it again under the launcher, back in its worktree, on the same session", async () => {
    const { edge, did } = fakeEdge();
    const out = await LANE_SETUP.restart(session(), HOST, edge);
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(
      `did not come back attached within ${ATTACH_PATIENCE_MS / 1000} s of \`${RESTART_LINE()}\` — the pane says why`,
    );
  });

  // The preload starts the launcher under the node the line's shell finds,
  // so a node it would refuse ends nothing.
  test("a PATH with no node the launcher can run under leaves Claude Code running", async () => {
    const { edge, did } = fakeEdge({
      launcherNode: () => ({
        kind: "refused",
        why: "no `node` on PATH to run the attach launcher",
      }),
    });
    await expect(
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(
      "Claude Code in %7 was left running, under the PATH it was started with: no `node` on PATH to run the attach launcher",
    );
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  // Claude Code's auto-update removes the release a path names; `claude`
  // reruns from history after it.
  test("a release the shell would not find as `claude` is named by its path", async () => {
    const { edge, did } = fakeEdge({
      onPath: () => "/usr/local/bin/claude-other",
    });
    await finished(await LANE_SETUP.restart(session(), HOST, edge));
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
    await finished(await LANE_SETUP.restart(session(), HOST, edge));
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
    await finished(await LANE_SETUP.restart(session(), HOST, edge));
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(
      `exited, but the directory it was started in could not be read (no such pane), so it was not started again — start it with \`cd /work && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions --resume ${SID}\``,
    );
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  test("a Claude Code that does not exit has no line typed for it", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(/did not exit within/);
    expect(did.at(-1)).toBe("terminate 4242");
  });

  test.each([
    ["attach-preload.cjs", "/opt/candybar/dist/attach-preload.cjs"],
    ["bun-attach.js", "/opt/candybar/dist/cc-extra/src/bun-attach.js"],
  ])(
    "a build with no %s is refused before anything in the pane is touched",
    async (missing, file) => {
      const { edge, did } = fakeEdge({
        fileExists: (f) => !f.endsWith(missing),
      });
      await expect(
        LANE_SETUP.restart(session(), HOST, edge),
      ).rejects.toThrow(`${file} is not there — run \`cc-candybar install\``);
      expect(did).toEqual([]);
    },
  );

  // Claude Code writes a session's transcript with its first message, and
  // `--resume` of one with none finds no conversation: such a session starts
  // afresh under its own id (`--session-id`), so lane B's wait for its
  // subscriber, which names that id, is answered by the restart.
  test("a session with no conversation yet starts afresh on the same id, and its statusline follows lane B", async () => {
    const { edge, did } = fakeEdge({ presence: () => "absent" });
    await expect(
      finished(
        await LANE_SETUP.restart(
          session({ tmux: TMUX }, "no"),
          HOST,
          edge,
        ),
      ),
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
    const { edge, did } = fakeEdge({
      presence: () => (written ? "present" : "absent"),
      terminate: (pid) => {
        did.push(`terminate ${pid}`);
        written = true;
      },
    });
    await expect(
      finished(
        await LANE_SETUP.restart(
          session({ tmux: TMUX }, "no"),
          HOST,
          edge,
        ),
      ),
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
        finished(
          await LANE_SETUP.restart(
            session({ tmux: TMUX }, answered),
            HOST,
            edge,
          ),
        ),
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(
      /was left running: whether session .* could not be seen \(EACCES\)/,
    );
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(
      `(ELOOP), so it was not started again — start it with \`${RESTART_LINE()}\``,
    );
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  test("a line that cannot be typed once Claude Code exited is named for the user to type", async () => {
    const { edge } = fakeEdge({
      presence: () => "absent",
      typeShellLine: async () => {
        throw new Error("server exited");
      },
    });
    await expect(
      finished(
        await LANE_SETUP.restart(
          session({ tmux: TMUX }, "no"),
          HOST,
          edge,
        ),
      ),
    ).rejects.toThrow(
      `exited, but the line could not be typed into its pane (server exited), so it was not started again — start it with \`${RESTART_LINE(`--session-id ${SID}`)}\``,
    );
  });

  test("a Claude Code that does not exit is not started again, and the wait says why", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(`did not exit within ${EXIT_PATIENCE_MS / 1000} s`);
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  // The screen of a session mid-turn, as tmux captured it (2.1.289): ending
  // Claude Code here would end the turn. The screen is judged at the kill, so
  // a turn started during the module-graph read is seen.
  test("a Claude Code in the middle of a turn is refused before Claude Code is ended", async () => {
    const { edge, did } = fakeEdge({
      claudeInput: {
        read: async () => ({
          inMode: false,
          screen: [
            "✽ Processing… (26s · ↓ 2.0k tokens · thought for 15s)",
            ...READY_SCREEN,
          ],
        }),
        type: async () => ({ kind: "typed" }),
      },
    });
    await expect(
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
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
      const { edge, did } = fakeEdge({
        claudeInput: {
          read: async () => snapshot,
          type: async () => ({ kind: "typed" }),
        },
      });
      await expect(
        finished(await LANE_SETUP.restart(session(), HOST, edge)),
      ).rejects.toThrow(reason);
      expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
    },
  );

  test("a Claude Code the pane no longer shows by the time of the kill is not killed", async () => {
    const { edge: base } = fakeEdge();
    const first = await base.paneClaude(TMUX);
    let reads = 0;
    const { edge, did } = fakeEdge({
      paneClaude: async () => (reads++ === 0 ? first : { ...first, pid: 5151 }),
    });
    await expect(
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
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
      finished(await LANE_SETUP.restart(session(), HOST, edge)),
    ).rejects.toThrow(/--brand-new-flag/);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  test("a session with no tmux pane is refused in the click", async () => {
    const { edge } = fakeEdge();
    await expect(
      LANE_SETUP.restart(session({ tmux: null }), HOST, edge),
    ).rejects.toThrow(/not running inside tmux/);
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

  test("the claude CLI runs under the session's directory, never the daemon's", async () => {
    // The session's process environment (src/daemon/foundations/session-env.ts) the
    // edge's `claude` spawns with.
    const facts = { sessionId: sessionIdOf("s1"), projectDir: "/p" };
    // Unset in the overlay, so the daemon's own (whichever shell spawned it)
    // is removed from what the child inherits.
    expect(sessionEnv({ ...facts, claudeConfigDir: undefined })).toHaveProperty(
      "CLAUDE_CONFIG_DIR",
      null,
    );
    expect(
      sessionEnv({ ...facts, claudeConfigDir: "/u/.claude.zai" })
        .CLAUDE_CONFIG_DIR,
    ).toBe("/u/.claude.zai");
  });
});

const switches = (on: Partial<LaneSwitches>): LaneSwitches => ({
  band: false,
  statusline: false,
  pane: false,
  tmuxStatus: false,
  ...on,
});

describe("LaneSurfaces", () => {
  // The renderer's lanes over its own acts: what each click and request asks
  // of the host, as the effects its turn returns.
  const lanes = () => {
    const logs: string[] = [];
    let minted = 0;
    const surfaces = new LaneSurfaces({
      acts: new Acts({
        mint: () => ++minted as EffectId,
        sessionState: new SessionState(),
        now: () => instantOf(new Date(0)),
      }),
      log: (level, msg) => logs.push(`${level} ${msg}`),
    });
    const asked = (effects: Effect[]): string[] =>
      effects.map((e) =>
        e.kind === "surface"
          ? `${e.surface} ${e.on ? "on" : "off"}`
          : e.kind,
      );
    const clicked = (
      held: boolean,
      before: Partial<LaneSwitches>,
      after: Partial<LaneSwitches>,
    ): string[] => {
      const effects: Effect[] = [];
      surfaces.clicked(SID, held, switches(before), switches(after), effects);
      return asked(effects);
    };
    const noted = (now: Partial<LaneSwitches>): string[] => {
      const effects: Effect[] = [];
      surfaces.noted(SID, switches(now), effects);
      return asked(effects);
    };
    return { surfaces, logs, clicked, noted };
  };

  // Whatever control moved the switch — the toggle, ↺, ↶ undo, a preset, a
  // save — reaches the setup the same way: the click measured before and
  // after its commit (journaled, src/renderer/verbs/index.ts).
  test("a click that moves a switch asks for its lane, and only its lane", () => {
    const { logs, clicked } = lanes();
    expect(clicked(true, {}, { pane: true })).toEqual(["pane on"]);
    expect(logs).toEqual([`info lane: pane on by=click (session=${SID})`]);
    // A click that moves no switch asks for nothing.
    expect(clicked(true, { pane: true }, { pane: true })).toEqual([]);
  });

  test.each([
    ["band", { band: true }, ["band on"], ["band off"]],
    ["pane", { pane: true }, ["pane on"], ["pane off"]],
    ["tmuxStatus", { tmuxStatus: true }, ["tmux-status on"], ["tmux-status off"]],
    // Off stops nothing: the attached statusline draws its command's output.
    ["statusline", { statusline: true }, ["restart-claude"], []],
  ])("%s on and off ask for what the lane takes", (_lane, on, up, down) => {
    const { clicked } = lanes();
    expect(clicked(true, {}, on)).toEqual(up);
    expect(clicked(true, on, {})).toEqual(down);
  });

  // A daemon restarted under a bar the old one drew: the toggle is clicked
  // before this daemon holds a request of the session.
  test("a click before the session's first request owes its setup to that request", () => {
    const { logs, clicked, noted } = lanes();
    expect(clicked(false, {}, { pane: true })).toEqual([]);
    expect(noted({ pane: true })).toEqual(["pane on"]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane on by=owed (session=${SID})`,
    ]);
    // Owed once: the next request asks for nothing.
    expect(noted({ pane: true })).toEqual([]);
  });

  test("a lane toggled on and off again before the session's first request owes nothing", () => {
    const { logs, clicked, noted } = lanes();
    clicked(false, {}, { pane: true, band: true });
    clicked(false, { pane: true, band: true }, { band: true });
    clicked(false, { band: true }, {});
    expect(noted({})).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed band on,pane on (session=${SID})`,
      `info lane: owed band on (session=${SID})`,
      `info lane: owed nothing (session=${SID})`,
    ]);
  });

  // Another session's save to the file both read, or a hand edit, between the
  // click and the request.
  test("an owed lane whose switch is back where it stood by the first request owes nothing", () => {
    const { logs, clicked, noted } = lanes();
    clicked(false, {}, { pane: true });
    expect(noted({})).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane off — nothing owed: its switch is back where the lane is by=owed (session=${SID})`,
    ]);
  });

  // A request noted for its feed whose draw failed before its arrival settled
  // anything: the session's next click is the first event that can.
  test("a click once the session's request is held settles what earlier clicks owed", () => {
    const { logs, clicked, noted } = lanes();
    clicked(false, {}, { pane: true });
    expect(clicked(true, { pane: true }, {})).toEqual([]);
    // Nothing is owed after it: a switch moved later by anything but a click
    // sets nothing up.
    expect(noted({ pane: true })).toEqual([]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane off — nothing owed: its switch is back where the lane is by=click (session=${SID})`,
    ]);
  });

  test("a click that settles an earlier click's owed lane says which lane each started", () => {
    const { logs, clicked } = lanes();
    clicked(false, {}, { pane: true });
    expect(
      clicked(true, { pane: true }, { pane: true, tmuxStatus: true }),
    ).toEqual(["pane on", "tmux-status on"]);
    expect(logs).toEqual([
      `info lane: owed pane on (session=${SID})`,
      `info lane: pane on by=owed (session=${SID})`,
      `info lane: tmuxStatus on by=click (session=${SID})`,
    ]);
  });

  // The row's feed ends once its lane is off, so a request holds it while the
  // switch is on, and holding it again is no change.
  test("a request whose tmux switch is on holds the row, once", () => {
    const { clicked, noted } = lanes();
    expect(noted({ tmuxStatus: true })).toEqual(["tmux-status on"]);
    expect(noted({})).toEqual([]);
    clicked(false, {}, { tmuxStatus: true });
    expect(noted({ tmuxStatus: true })).toEqual(["tmux-status on"]);
  });

  test("owed setups are kept for 1024 sessions; the oldest is dropped, and said", () => {
    const { surfaces, logs } = lanes();
    for (let i = 0; i <= 1024; i++)
      surfaces.clicked(
        sessionIdOf(`s${i}`),
        false,
        switches({}),
        switches({ pane: true }),
        [],
      );
    expect(logs.filter((l) => l.startsWith("warn"))).toEqual([
      `warn lane: owed dropped sid="s0" lanes=pane`,
    ]);
  });
});

describe("LaneSetups", () => {
  const owner = (edge: LaneEdge) => {
    const logs: string[] = [];
    const setups = new LaneSetups({
      edge,
      host: HOST,
      log: (level, msg) => logs.push(`${level} ${msg}`),
    });
    return { setups, logs };
  };

  const OPENED = `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 {"CC_CANDYBAR_SOCKET":"/tmp/cc-candybar-1/socket"}`;
  const PANE_ON = { kind: "surface", surface: "pane", on: true } as const;

  test("a surface set up is logged and answered ok", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs } = owner(edge);
    expect(await setups.start(session(), PANE_ON)).toEqual({ kind: "ok" });
    expect(did).toEqual([OPENED]);
    expect(logs).toEqual([
      `info lane: pane on — opened bar pane %9 under %7 (session=${SID})`,
    ]);
  });

  test("a surface turned off brings it down", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9"] });
    const { setups } = owner(edge);
    await setups.start(session(), { ...PANE_ON, on: false });
    expect(did).toEqual(["close %9"]);
  });

  // Toggled on, off and on again inside one restart: a second restart of the
  // pane would type into the first.
  test("one session's setups run one at a time, each after the last has finished", async () => {
    let exit!: (gone: boolean) => void;
    const { edge, did } = fakeEdge({
      exited: () => new Promise((r) => (exit = r)),
    });
    const { setups } = owner(edge);
    const first = setups.start(session(), { kind: "restart" });
    const second = setups.start(session(), { kind: "restart" });
    await new Promise((r) => setImmediate(r));
    // The first restart waits for Claude Code to exit; nothing else has run.
    expect(did.filter((d) => d.startsWith("terminate"))).toEqual([
      "terminate 4242",
    ]);
    exit(true);
    await first;
    await new Promise((r) => setImmediate(r));
    // The second restart starts only after the first ended.
    expect(did.filter((d) => d.startsWith("terminate"))).toEqual([
      "terminate 4242",
      "terminate 4242",
    ]);
    exit(true);
    await second;
  });

  test("a setup refused at once is logged and answered refused, saying why", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs } = owner(edge);
    expect(await setups.start(session({ tmux: null }), PANE_ON)).toEqual({
      kind: "refused",
      reason: expect.stringMatching(/not running inside tmux/),
    });
    expect(did).toEqual([]);
    expect(logs).toEqual([
      expect.stringMatching(/^warn lane: pane on: .*not running inside tmux/),
    ]);
  });

  test("a restart that fails after it started is logged and answered failed, once it ends", async () => {
    let gone!: (v: boolean) => void;
    let asked!: () => void;
    const waiting = new Promise<void>((r) => (asked = r));
    const { edge } = fakeEdge({
      exited: () => {
        asked();
        return new Promise((r) => (gone = r));
      },
    });
    const { setups, logs } = owner(edge);
    let ended: unknown = null;
    const restart = setups
      .start(session(), { kind: "restart" })
      .then((o) => (ended = o));
    await waiting;
    await new Promise((r) => setImmediate(r));
    expect(logs).toEqual([
      `info lane: restart-claude — restarting Claude Code in %7 under the attach launcher (session=${SID})`,
    ]);
    expect(ended).toBeNull();
    gone(false);
    await restart;
    expect(ended).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/^Claude Code in %7 did not exit/),
    });
    expect(logs.at(-1)).toMatch(
      /^warn lane: restart-claude: Claude Code in %7 did not exit/,
    );
  });
});
