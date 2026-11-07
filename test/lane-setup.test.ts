import { MAIN_NAME } from "../src/daemon/home";
import { homeEnv } from "../src/daemon/paths";
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
  ATTACH_PATIENCE_MS,
  EXIT_PATIENCE_MS,
  LANE_SETUP,
  LaneSetups,
  laneRun,
  type LaneEdge,
  type LaneRun,
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
  barPanesOf,
} from "../src/daemon/lane-edge";
import { draftShown, turnRunning } from "../src/claude-input/prompt-screen";
import { BadVerbArgs, DaemonClosing } from "../src/daemon/verb-error";
import { JournalTurns } from "../src/daemon/journal-turns";
import { performInOrder } from "../src/daemon/apply";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import { lastClickError } from "../src/daemon/click-error";
import type { VerbContext } from "../src/daemon/verbs";
import type { StartToken } from "../src/daemon/process-fingerprint";
import {
  effectsUrl,
  VERB_COPY,
  VERB_SET_STATE,
  VERB_SLASH,
} from "../src/click/wire";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/foundations/session-keys";
import { program, readsStdin, runsFor } from "../src/proc/spawner-fake";
import { systemTimekeeper, type Timekeeper } from "../src/time";
import { heldClock } from "./helpers/held-clock";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { applyClick, clickUrl, recordRender, testVerbContext, effectLink } from "./helpers/click";
import { fakeLauncher, turns } from "./helpers/fake-launcher";
import type { LaneSetupEffect } from "../src/daemon/lane-setup";
import { failed, type EffectOutcome } from "../src/daemon/effect-outcome";
import { LANES, type Lane, type LaneSwitches } from "../src/config/lanes";
import type { TmuxHint } from "../src/tmux-hint";
import { CLAUDE_START } from "./helpers/claude-record";

const SID = "1f6e0c2a-0d0e-4a52-9d1b-2b0b0f0e0a11";
// The bundled bar, whose settings menu declares every lane's switch.
const BAR = parseAndValidate(
  "<test>",
  "{}",
  new Set(listResolvablePaletteNames()),
  DEFAULT_DSL_CONFIG,
);

const TMUX: TmuxHint = { socket: "/tmp/tmux-1/default", pane: "%7", truecolor: null };
const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];
// The session a `/clear` in %7 starts: the same Claude Code process, which
// now holds another session.
const CLEARED = "9a1d3c4e-7b2f-4e0a-8c6d-5e4f3a2b1c00";

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

// A setup's run over `s` with nothing else in its pane: each pane step runs at
// once, on `s`.
const run = (s: LaneSession): LaneRun =>
  laneRun(
    () => ({ kind: "known", session: s }),
    (_tmux, work) => work(),
    () => {},
  );

// Every effect recorded, in the order it ran.
function fakeEdge(over: Partial<LaneEdge> = {}): { edge: LaneEdge; did: string[] } {
  const did: string[] = [];
  const claude: PaneClaude = {
    pid: 4242,
    startTime: CLAUDE_START,
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
      did.push(`open under ${hint.pane}: ${argv.join(" ")} ${JSON.stringify(env)}`);
      return "%9";
    },
    closePane: async (_hint, pane) => void did.push(`close ${pane}`),
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
    // Claude Code's record of its process, under the default configuration
    // directory its environment leaves it, holds the session under test; a
    // record asked of anything else is not there.
    heldSession: ({ pid, startTime, configDir }) =>
      pid === claude.pid && startTime === claude.startTime && configDir === undefined
        ? { kind: "holds", sessionId: SID }
        : { kind: "unread", why: `no record of ${pid} under ${configDir ?? "the default"}` },
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
  home: {
    kind: "main",
    name: MAIN_NAME,
    runtime: "/tmp/cc-candybar-1",
    roots: { state: "/s", cache: "/c", config: "/g" },
    legacySocket: null,
  },
  preload: "/opt/candybar/dist/attach-preload.cjs",
};

// The line the restart types for the fake edge's Claude Code, on `start`.
const RESTART_LINE = (start = `--resume ${SID}`): string =>
  `cd /work && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions ${start}`;

describe("lane C, pane", () => {
  test("on opens a bar pane under the session's pane, following this daemon", async () => {
    const { edge, did } = fakeEdge();
    const out = await LANE_SETUP.pane.on(run(session()), HOST, edge);
    expect(out).toEqual({ kind: "done", said: "opened bar pane %9 under %7" });
    expect(did).toEqual([
      `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 ${JSON.stringify(homeEnv(HOST.home))}`,
    ]);
  });

  test("on with a bar pane already open opens no second one", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9"] });
    expect(await LANE_SETUP.pane.on(run(session()), HOST, edge)).toEqual({
      kind: "done",
      said: "bar pane %9 already draws %7's bar",
    });
    expect(did).toEqual([]);
  });

  test("off in a session with no tmux pane has nothing to close, and says so", async () => {
    const { edge, did } = fakeEdge();
    expect(await LANE_SETUP.pane.off(run(session({ tmux: null })), HOST, edge)).toEqual({
      kind: "done",
      said: expect.stringMatching(/^no bar pane to close: .*not running inside tmux/),
    });
    expect(did).toEqual([]);
  });

  test("off closes every bar pane drawing the session's bar", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9", "%11"] });
    await LANE_SETUP.pane.off(run(session()), HOST, edge);
    expect(did).toEqual(["close %9", "close %11"]);
  });

  test.each([
    [undefined, "predates this daemon"],
    [null, "not running inside tmux"],
  ])("a session with tmux hint %p is refused, saying why", async (tmux, why) => {
    const { edge } = fakeEdge();
    await expect(LANE_SETUP.pane.on(run(session({ tmux })), HOST, edge)).rejects.toThrow(
      new RegExp(why),
    );
  });
});

describe("lane C, tmux status line", () => {
  test("on and off run nothing: the daemon draws the status line by the switch", async () => {
    const { edge, did } = fakeEdge();
    expect(await LANE_SETUP.tmuxStatus.on(run(session()), HOST, edge)).toEqual({
      kind: "done",
      said: "the daemon draws %7's bar in its status line",
    });
    expect((await LANE_SETUP.tmuxStatus.off(run(session()), HOST, edge)).kind).toBe("done");
    expect(did).toEqual([]);
  });

  test("on in a session outside tmux is refused, saying why", async () => {
    const { edge } = fakeEdge();
    await expect(LANE_SETUP.tmuxStatus.on(run(session({ tmux: null })), HOST, edge)).rejects.toThrow(
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
    const out = await LANE_SETUP.band.on(
      run(session({ tmux: TMUX, claudeConfigDir: "/home/u/.claude" })),
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
    await expect(LANE_SETUP.band.on(run(session()), HOST, edge)).rejects.toThrow(BadVerbArgs);
    expect(did).toEqual([]);
  });

  test("an unbuilt native client is refused in the click, naming the build", async () => {
    const { bundle } = checkout();
    const { edge, did } = fakeEdge({ fileExists: () => false });
    await expect(LANE_SETUP.band.on(run(session()), { ...HOST, bundle }, edge)).rejects.toThrow(
      /just install-rust/,
    );
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
      finished(await LANE_SETUP.band.on(run(session()), { ...HOST, bundle }, edge)),
    ).rejects.toThrow(/installed, but \/reload-plugins was not typed: .*copy mode/);
  });
});

describe("lane B, statusline", () => {
  test("on ends Claude Code, then types one line into its shell that starts it again under the launcher, back in its worktree, on the same session", async () => {
    const { edge, did } = fakeEdge();
    const out = await LANE_SETUP.statusline.on(run(session()), HOST, edge);
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(
      "Claude Code in %7 was left running, under the PATH it was started with: no `node` on PATH to run the attach launcher",
    );
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  // Claude Code's auto-update removes the release a path names; `claude`
  // reruns from history after it.
  test("a release the shell would not find as `claude` is named by its path", async () => {
    const { edge, did } = fakeEdge({ onPath: () => "/usr/local/bin/claude-other" });
    await finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge));
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
      // Its record is under the directory it was started with.
      heldSession: ({ pid, configDir }) =>
        pid === claude.pid && configDir === "/u/.claude zai"
          ? { kind: "holds", sessionId: SID }
          : { kind: "unread", why: `no record of ${pid} under ${configDir ?? "the default"}` },
    });
    await finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge));
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
    await finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge));
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(
      `exited, but the directory it was started in could not be read (no such pane), so it was not started again — start it with \`cd /work && BUN_OPTIONS='--preload /opt/candybar/dist/attach-preload.cjs' claude --worktree feat/tree --dangerously-skip-permissions --resume ${SID}\``,
    );
    expect(did.some((d) => d.startsWith("shell"))).toBe(false);
  });

  test("a Claude Code that does not exit has no line typed for it", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(/did not exit within/);
    expect(did.at(-1)).toBe("terminate 4242");
  });

  test.each([
    ["attach-preload.cjs", "/opt/candybar/dist/attach-preload.cjs"],
    ["bun-attach.js", "/opt/candybar/dist/cc-extra/src/bun-attach.js"],
  ])("a build with no %s is refused before anything in the pane is touched", async (missing, file) => {
    const { edge, did } = fakeEdge({
      fileExists: (f) => !f.endsWith(missing),
    });
    await expect(LANE_SETUP.statusline.on(run(session()), HOST, edge)).rejects.toThrow(
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
      finished(await LANE_SETUP.statusline.on(run(session({ tmux: TMUX }, "no")), HOST, edge)),
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
      finished(await LANE_SETUP.statusline.on(run(session({ tmux: TMUX }, "no")), HOST, edge)),
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
        finished(await LANE_SETUP.statusline.on(run(session({ tmux: TMUX }, answered)), HOST, edge)),
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(`(ELOOP), so it was not started again — start it with \`${RESTART_LINE()}\``);
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
      finished(await LANE_SETUP.statusline.on(run(session({ tmux: TMUX }, "no")), HOST, edge)),
    ).rejects.toThrow(
      `exited, but the line could not be typed into its pane (server exited), so it was not started again — start it with \`${RESTART_LINE(`--session-id ${SID}`)}\``,
    );
  });

  test("a Claude Code that does not exit is not started again, and the wait says why", async () => {
    const { edge, did } = fakeEdge({ exited: async () => false });
    await expect(
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
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
      claudeInput: { read: async () => snapshot, type: async () => ({ kind: "typed" }) },
    });
    await expect(
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(reason);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  // A later process the kernel handed the read one's pid is not it either.
  test.each([
    ["another pid", { pid: 5151 }],
    ["the same pid, started later", { startTime: "Sat Nov  7 09:30:00 2026" as StartToken }],
  ])("a Claude Code the pane no longer shows by the time of the kill (%s) is not killed", async (_case, later) => {
    const { edge: base } = fakeEdge();
    const first = await base.paneClaude(TMUX);
    let reads = 0;
    const { edge, did } = fakeEdge({
      paneClaude: async () => (reads++ === 0 ? first : { ...first, ...later }),
    });
    await expect(
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
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

  // A `/clear` keeps the pid, so only the process's own record of its session
  // tells the restart the session has left it.
  test("a process that holds another session by the kill is not killed, and the refusal names that session", async () => {
    let holds = SID;
    const read: unknown[] = [];
    const claude = await fakeEdge().edge.paneClaude(TMUX);
    const { edge, did } = fakeEdge({
      // Started with its own configuration directory.
      paneClaude: async () => ({ ...claude, env: [...claude.env, "CLAUDE_CONFIG_DIR=/u/.claude.zai"] }),
      // The screen read is the restart's last wait before the kill; the
      // pane's `/clear` lands during it.
      claudeInput: {
        read: async () => {
          holds = CLEARED;
          return { inMode: false, screen: READY_SCREEN };
        },
        type: async () => ({ kind: "typed" }),
      },
      heldSession: ({ pid, configDir }) => {
        read.push([pid, configDir]);
        return { kind: "holds", sessionId: holds };
      },
    });
    await expect(
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(
      `Claude Code in %7 now runs session ${CLEARED}, not ${SID}, so it was not restarted under the attach launcher`,
    );
    // The record is the process's, under the configuration directory its
    // own environment names.
    expect(read).toEqual([[4242, "/u/.claude.zai"]]);
    expect(did.filter((d) => d.startsWith("terminate") || d.startsWith("shell"))).toEqual([]);
  });

  test("a process whose session record cannot be read is not killed, and the refusal says why", async () => {
    const { edge, did } = fakeEdge({
      heldSession: () => ({ kind: "unread", why: "it keeps no session record at /u/.claude/sessions/4242.json" }),
    });
    await expect(
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(
      "Claude Code in %7 was left running: it keeps no session record at /u/.claude/sessions/4242.json, so which session it runs is unknown",
    );
    expect(did.filter((d) => d.startsWith("terminate") || d.startsWith("shell"))).toEqual([]);
  });

  test("a Claude Code already under the attach launcher is left running", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        startTime: CLAUDE_START,
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).resolves.toContain("already runs under the attach launcher");
    expect(did).toEqual([]);
  });

  test("a Claude Code that is its pane's first process is refused: nothing would restart it", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        startTime: CLAUDE_START,
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
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
  ])("the module graph reader's output %j refuses with %p", async (stdout, reason) => {
    expect(refusalOf(stdout)).toBe(reason);
  });

  test("a flag cc-candybar cannot carry refuses the restart before Claude Code is ended", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        startTime: CLAUDE_START,
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
      finished(await LANE_SETUP.statusline.on(run(session()), HOST, edge)),
    ).rejects.toThrow(/--brand-new-flag/);
    expect(did.some((d) => d.startsWith("terminate"))).toBe(false);
  });

  test("a session with no tmux pane is refused in the click", async () => {
    const { edge } = fakeEdge();
    await expect(LANE_SETUP.statusline.on(run(session({ tmux: null })), HOST, edge)).rejects.toThrow(/not running inside tmux/);
  });

  test("off stops nothing", async () => {
    const { edge, did } = fakeEdge();
    expect((await LANE_SETUP.statusline.off(run(session()), HOST, edge)).kind).toBe("done");
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
  ])("started in %s, running in %s, starts in %s with %j", async (startDir, cwd, dir, args) => {
    expect(startPlace(startDir, cwd)).toEqual({ dir, args });
  });
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
    expect(runsAttached("  20 10 /bin/zsh\n  10 1 cc-attach", 20, 20)).toBe(false);
  });

  test("the claude CLI runs under the session's directory, never the daemon's", async () => {
    // The session's process environment (src/daemon/session-env.ts) the
    // edge's `claude` spawns with.
    const facts = { sessionId: "s1", projectDir: "/p" };
    // Unset in the overlay, so the daemon's own (whichever shell spawned it)
    // is removed from what the child inherits.
    expect(sessionEnv({ ...facts, claudeConfigDir: undefined })).toHaveProperty(
      "CLAUDE_CONFIG_DIR",
      undefined,
    );
    expect(
      sessionEnv({ ...facts, claudeConfigDir: "/u/.claude.zai" }).CLAUDE_CONFIG_DIR,
    ).toBe("/u/.claude.zai");
  });
});

describe("LaneSetups", () => {
  const owner = (edge: LaneEdge, host: LaneHost = HOST) => {
    const logs: string[] = [];
    // The session's latest request, as each click or request below reports
    // it: none until the first.
    let latest: LaneSession | null = null;
    // [LAW:effects-at-boundaries] What the clicks and requests settle is
    // effects; the performer runs them after the event's turn, each lane's
    // one at a time in the order described, and each pane step in its pane's
    // order (src/daemon/journal-turns.ts `performing`), and each outcome is
    // what Apply lands.
    const turns = new JournalTurns();
    const owner = new LaneSetups({
      edge,
      host,
      log: (level, msg) => logs.push(`${level} ${msg}`),
      latest: () => latest,
      paneOrder: (tmux, work) => turns.performing({ kind: "pane", tmux }, work),
    });
    // Each event's setups, as its turn described them.
    const described: (readonly LaneSetupEffect[])[] = [];
    const outcomes: EffectOutcome[] = [];
    // What the performer caught: a setup that threw (src/daemon/apply.ts).
    const refusals: unknown[] = [];
    const performing: Promise<void>[] = [];
    const setups = {
      clicked: (
        sid: string,
        session: LaneSession | null,
        before: LaneSwitches,
        after: LaneSwitches,
      ) => {
        latest = session ?? latest;
        described.push(owner.clicked(sid, before, after));
      },
      noted: (session: LaneSession, switches: LaneSwitches) => {
        latest = session;
        described.push(owner.noted(session.sessionId, switches));
      },
    };
    // Hand what each event described to the performer's order, as its turn
    // does once it is over (src/daemon/apply.ts), and let the setups queued
    // behind them run.
    const settle = async (): Promise<void> => {
      for (const effects of described.splice(0)) {
        performing.push(
          performInOrder(turns, { verb: "lane", session: SID }, effects, (effect) =>
            owner.setup(effect).then(
              (outcome) => void outcomes.push(outcome),
              (e: unknown) => void refusals.push(e),
            ),
          ),
        );
      }
      await new Promise((r) => setImmediate(r));
    };
    const close = (): void => owner.close();
    // A request of the session arrived since: its latest, as a setup reads it.
    const report = (session: LaneSession): void => void (latest = session);
    // The daemon stopped holding the session's request since.
    const evict = (): void => void (latest = null);
    return { setups, logs, settle, outcomes, refusals, performing, close, report, evict, turns };
  };
  const switches = (on: Partial<LaneSwitches>): LaneSwitches => ({
    band: false,
    statusline: false,
    pane: false,
    tmuxStatus: false,
    ...on,
  });

  test("a setup still queued when the daemon closes is refused as the close, and runs nothing", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => [] });
    const { setups, settle, outcomes, refusals, close } = owner(edge);
    setups.clicked(SID, session(), switches({}), switches({ pane: true }));
    close();
    await settle();
    expect(did).toEqual([]);
    expect(outcomes).toEqual([]);
    expect(refusals).toEqual([expect.any(DaemonClosing)]);
  });

  const OPENED = `open under %7: /usr/bin/node /opt/candybar/dist/index.mjs bar-pane %7 ${JSON.stringify(homeEnv(HOST.home))}`;

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
  test("one lane's setups run one at a time, each after the last has finished", async () => {
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

  // The band's `claude` CLI calls run while the session's request moves to
  // another pane: the reload is typed where the session is when it is reached.
  test("a setup's pane step acts on the session as its latest request reports it then, not as at the click", async () => {
    const { bundle } = checkout();
    let installed!: () => void;
    const typed: string[] = [];
    const { edge } = fakeEdge({
      claude: (args) =>
        args[1] === "install" ? new Promise<void>((r) => (installed = r)) : Promise.resolve(),
      claudeInput: {
        read: async () => ({ inMode: false, screen: READY_SCREEN }),
        type: async (hint, line) => {
          typed.push(`${line} into ${hint.pane}`);
          return { kind: "typed" };
        },
      },
    });
    const { setups, settle, report, performing, outcomes } = owner(edge, { ...HOST, bundle });
    setups.clicked(SID, session(), switches({}), switches({ band: true }));
    await settle();
    report(session({ tmux: { ...TMUX, pane: "%8" } }));
    installed();
    await Promise.all(performing);
    expect(typed).toEqual(["/reload-plugins into %8"]);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "ok" })]);
  });

  // Lines typed for other clicks hold both panes when the reload is reached;
  // the session's next request moves it from %7 to %8 meanwhile.
  test("a pane step whose session moved to another pane while it waited lets the first pane go, then types in the second in its order", async () => {
    const { bundle } = checkout();
    const ran: string[] = [];
    const { edge } = fakeEdge({
      claudeInput: {
        read: async () => ({ inMode: false, screen: READY_SCREEN }),
        type: async (hint, line) => {
          ran.push(`${line} into ${hint.pane}`);
          return { kind: "typed" };
        },
      },
    });
    const { setups, logs, settle, report, performing, outcomes, turns } = owner(edge, { ...HOST, bundle });
    const MOVED_TO: TmuxHint = { ...TMUX, pane: "%8" };
    const parked = (tmux: TmuxHint, line: string) => {
      let release!: () => void;
      const done = turns.performing({ kind: "pane", tmux }, async () => {
        await new Promise<void>((r) => (release = r));
        ran.push(line);
      });
      return { release: () => release(), done };
    };
    const in7 = parked(TMUX, "line in %7");
    const in8 = parked(MOVED_TO, "line in %8");
    setups.clicked(SID, session(), switches({}), switches({ band: true }));
    await settle();
    // Placed behind the reload's step in %7's order.
    const after7 = turns.performing({ kind: "pane", tmux: TMUX }, async () => void ran.push("after in %7"));
    report(session({ tmux: MOVED_TO }));
    in7.release();
    await after7;
    // The step let %7 go while %8 is still held, and typed nothing yet.
    expect(ran).toEqual(["line in %7", "after in %7"]);
    in8.release();
    await in8.done;
    await Promise.all(performing);
    expect(ran).toEqual(["line in %7", "after in %7", "line in %8", "/reload-plugins into %8"]);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "ok" })]);
    expect(logs).toContainEqual(expect.stringMatching(/band on — the session moved from %7 to %8 while its step waited for the pane/));
  });

  test("a band install whose session this daemon stopped holding before the reload says the mod is installed and what to type", async () => {
    const { bundle } = checkout();
    let installed!: () => void;
    const { edge, did } = fakeEdge({
      claude: (args) =>
        args[1] === "install" ? new Promise<void>((r) => (installed = r)) : Promise.resolve(),
    });
    const { setups, settle, evict, performing, outcomes } = owner(edge, { ...HOST, bundle });
    setups.clicked(SID, session(), switches({}), switches({ band: true }));
    await settle();
    evict();
    installed();
    await Promise.all(performing);
    expect(did.filter((d) => d.startsWith("type"))).toEqual([]);
    expect(outcomes).toEqual([
      failed(
        `lane: band on: the band mod is installed, but /reload-plugins was not typed: this daemon no longer holds a request of session ${SID} — or type /reload-plugins yourself`,
      ),
    ]);
  });

  // A split resizes the session's pane, which a restart's reads would see.
  test("a bar pane opens in the order of the session's pane, after what was placed there before it", async () => {
    const { edge, did } = fakeEdge();
    const { setups, settle, performing, turns } = owner(edge);
    let release!: () => void;
    const parked = turns.performing({ kind: "pane", tmux: TMUX }, async () => {
      await new Promise<void>((r) => (release = r));
      did.push("line in %7");
    });
    setups.clicked(SID, session(), switches({}), switches({ pane: true }));
    await settle();
    expect(did).toEqual([]);
    release();
    await parked;
    await Promise.all(performing);
    expect(did).toEqual(["line in %7", expect.stringMatching(/^open under %7: /)]);
  });

  test("a pane step still queued when the daemon closes types nothing, and the setup fails as the close", async () => {
    const { bundle } = checkout();
    let installed!: () => void;
    const { edge, did } = fakeEdge({
      claude: (args) =>
        args[1] === "install" ? new Promise<void>((r) => (installed = r)) : Promise.resolve(),
    });
    const { setups, settle, close, performing, outcomes } = owner(edge, { ...HOST, bundle });
    setups.clicked(SID, session(), switches({}), switches({ band: true }));
    await settle();
    close();
    installed();
    await Promise.all(performing);
    expect(did.filter((d) => d.startsWith("type"))).toEqual([]);
    expect(outcomes).toEqual([failed(expect.stringMatching(/the daemon closed: lane setup refused/))]);
  });

  // A session this daemon no longer knows may still have a bar pane open.
  test("a bar pane close whose session this daemon stopped holding while it waited for the pane fails, and closes nothing", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9"] });
    const { setups, settle, evict, performing, outcomes, turns } = owner(edge);
    let release!: () => void;
    const parked = turns.performing({ kind: "pane", tmux: TMUX }, () => new Promise<void>((r) => (release = r)));
    setups.clicked(SID, session(), switches({ pane: true }), switches({}));
    await settle();
    evict();
    release();
    await parked;
    await Promise.all(performing);
    expect(did).toEqual([]);
    expect(outcomes).toEqual([failed(`lane: pane off: this daemon no longer holds a request of session ${SID}`)]);
  });

  // The pane's order is held when the toggle is clicked, and a `/clear` there
  // gives its process another session before the restart takes the pane.
  test("a restart whose process moved on to another session while it waited for the pane resumes nothing over it", async () => {
    let holds = SID;
    const { edge, did } = fakeEdge({ heldSession: () => ({ kind: "holds", sessionId: holds }) });
    const { setups, settle, performing, outcomes, turns } = owner(edge);
    let release!: () => void;
    const parked = turns.performing({ kind: "pane", tmux: TMUX }, () => new Promise<void>((r) => (release = r)));
    setups.clicked(SID, session(), switches({}), switches({ statusline: true }));
    await settle();
    holds = CLEARED;
    release();
    await parked;
    await Promise.all(performing);
    expect(did.filter((d) => d.startsWith("terminate") || d.startsWith("shell"))).toEqual([]);
    expect(outcomes).toEqual([
      failed(expect.stringMatching(new RegExp(`^lane: statusline on: Claude Code in %7 now runs session ${CLEARED}, not `))),
    ]);
  });

  test("a switch turned off brings the lane down", async () => {
    const { edge, did } = fakeEdge({ barPanes: async () => ["%9"] });
    const { setups, settle } = owner(edge);
    setups.clicked(SID, session(), switches({ pane: true }), switches({}));
    await settle();
    expect(did).toEqual(["close %9"]);
  });

  // What the failure's outcome says, as the log line said it without where.
  const said = (line: string): string =>
    line.replace(/^warn /, "").replace(` by=click (session=${SID})`, "");

  // [LAW:single-enforcer] Through Apply, as the daemon runs a toggle: the
  // click's turn settles the setup as an effect, the performer runs it after
  // the turn, and the effect-done arm is the one writer of its failure.
  test("a toggle's setup is performed after its click's turn, and its failure reaches the bar as its effect-done", async () => {
    const { edge, did } = fakeEdge();
    const sessionState = new SessionState(SINGLE_RUN);
    recordRender(sessionState, SID);
    const lines: string[] = [];
    const base = testVerbContext(sessionState, undefined, BAR);
    const owner = new LaneSetups({
      edge,
      host: HOST,
      log: () => {},
      // The session as its latest request reported it: outside tmux, where a
      // pane lane has nowhere to open.
      latest: () => session({ tmux: null }),
      paneOrder: (tmux, work) =>
        base.journalTurns.performing({ kind: "pane", tmux }, work),
    });
    const ctx: VerbContext = {
      ...base,
      log: (level, msg) => lines.push(`${level} ${msg}`),
      lanes: {
        ...base.lanes,
        clicked: (sid, before, after) => owner.clicked(sid, before, after),
        setup: (effect) => owner.setup(effect),
      },
    };
    await clickUrl(
      effectsUrl(MAIN_NAME, [
        {
          verb: VERB_SET_STATE,
          args: [SID, LANES.pane.switch.setting, String(LANES.pane.switch.on)],
        },
      ]),
      ctx,
    );
    expect(did).toEqual([]);
    expect(lastClickError(sessionState, SID)?.text).toMatch(
      /^lane: pane on: .*not running inside tmux/,
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^warn apply kind=effect-done verb=\S+ sid=\S+ effect=lane-setup:pane-on outcome=failed /,
      ),
    );
  });

  // [LAW:no-ambient-temporal-coupling] Through Apply, as the daemon runs it, on
  // one JournalTurns: a setup holds its lane's order, and the pane's only for
  // the steps that type into it, so the session's other clicks wait on none
  // of its other steps.
  const applyRig = (edge: LaneEdge, host: LaneHost = HOST, clock: Timekeeper = systemTimekeeper) => {
    const sessionState = new SessionState(SINGLE_RUN);
    recordRender(sessionState, SID);
    sessionState.set(SID, SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux: TMUX }));
    const { launcher, spawner, started } = fakeLauncher(clock);
    const base = testVerbContext(sessionState, undefined, BAR);
    const lines: string[] = [];
    const owner = new LaneSetups({
      edge,
      host,
      log: () => {},
      latest: () => session(),
      paneOrder: (tmux, work) =>
        base.journalTurns.performing({ kind: "pane", tmux }, work),
    });
    const ctx: VerbContext = {
      ...base,
      launcher,
      log: (_level, msg) => lines.push(msg),
      claudeInput: edge.claudeInput,
      lanes: {
        ...base.lanes,
        clicked: (sid, before, after) => owner.clicked(sid, before, after),
        setup: (effect) => owner.setup(effect),
      },
    };
    const setState = (lane: Lane, on = true) => ({
      verb: VERB_SET_STATE as typeof VERB_SET_STATE,
      args: [SID, LANES[lane].switch.setting, String(on ? LANES[lane].switch.on : false)],
    });
    const toggle = (lane: Lane, on = true) =>
      applyClick(effectsUrl(MAIN_NAME, [setState(lane, on)]), ctx);
    // The lane setups that reported, in the order they did.
    const reported = () =>
      lines.flatMap((l) => /kind=effect-done .*effect=lane-setup:(\S+)/.exec(l)?.[1] ?? []);
    return { ctx, spawner, started, toggle, setState, reported };
  };

  test("a copy clicked during a band install is performed before the install ends", async () => {
    const { bundle } = checkout();
    let installed!: () => void;
    const { edge, did } = fakeEdge({
      claude: (args) => {
        did.push(`claude ${args.join(" ")}`);
        return args[1] === "install" ? new Promise<void>((r) => (installed = r)) : Promise.resolve();
      },
    });
    const r = applyRig(edge, { ...HOST, bundle });
    r.spawner.program(program("/usr/bin/pbcopy"), readsStdin("until-end"));
    const band = await r.toggle("band");
    await turns();
    expect(did.at(-1)).toBe(`claude plugin install ${BAND_PLUGIN}`);
    const copy = await applyClick(
      effectLink(VERB_COPY, SID, "hello"),
      r.ctx,
    );
    await copy.performed;
    expect(r.started().map((s) => s.stdin)).toEqual(["hello"]);
    expect(did.filter((d) => d.startsWith("type"))).toEqual([]);
    installed();
    await band.performed;
    expect(did.at(-1)).toBe("type /reload-plugins");
  });

  test("a slash clicked during a restart is typed after it, into the Claude Code it started again", async () => {
    let exit!: (gone: boolean) => void;
    const { edge, did } = fakeEdge({ exited: () => new Promise((r) => (exit = r)) });
    const r = applyRig(edge);
    const restart = await r.toggle("statusline");
    await turns();
    expect(did.at(-1)).toBe("terminate 4242");
    const slash = await applyClick(
      effectsUrl(MAIN_NAME, [{ verb: VERB_SLASH, args: [SID, "/compact"] }]),
      r.ctx,
    );
    await turns();
    expect(did.at(-1)).toBe("terminate 4242");
    exit(true);
    await Promise.all([restart.performed, slash.performed]);
    expect(did.slice(-3)).toEqual([
      `shell ${RESTART_LINE()}`,
      `followed ${SID} statusline`,
      "type /compact",
    ]);
  });

  // A click that moves two lanes, the first slow to set up, and a click on
  // the second lane while it waits: each place is taken as its click commits.
  test("a lane ends where the last click left it, though the first click's setup of it waited behind another", async () => {
    const { bundle } = checkout();
    let installed!: () => void;
    const { edge } = fakeEdge({
      claude: (args) =>
        args[1] === "install" ? new Promise<void>((r) => (installed = r)) : Promise.resolve(),
    });
    const r = applyRig(edge, { ...HOST, bundle });
    const both = await applyClick(
      effectsUrl(MAIN_NAME, [r.setState("band"), r.setState("statusline")]),
      r.ctx,
    );
    const back = await r.toggle("statusline", false);
    await turns();
    expect(r.reported()).toEqual([]);
    installed();
    await Promise.all([both.performed, back.performed]);
    expect(r.reported()).toEqual(["band-on", "statusline-on", "statusline-off"]);
  });

  test("lines typed into a pane keep their clicks' order, though the first waits behind its click's copy", async () => {
    const clock = heldClock(new Date("2026-11-06T12:00:00Z"));
    const { edge, did } = fakeEdge();
    const r = applyRig(edge, HOST, clock);
    r.spawner.program(program("/usr/bin/pbcopy"), runsFor(50, { ...readsStdin("until-end"), runsFor: 50 }));
    const first = await applyClick(
      effectsUrl(MAIN_NAME, [
        { verb: VERB_COPY, args: [SID, "hello"] },
        { verb: VERB_SLASH, args: [SID, "/compact"] },
      ]),
      r.ctx,
    );
    const second = await applyClick(
      effectsUrl(MAIN_NAME, [{ verb: VERB_SLASH, args: [SID, "/model"] }]),
      r.ctx,
    );
    await turns();
    expect(did).toEqual([]);
    clock.advance(50);
    await Promise.all([first.performed, second.performed]);
    expect(did).toEqual(["type /compact", "type /model"]);
  });

  test("a setup refused at once is logged, and its outcome is the failure", async () => {
    const { edge, did } = fakeEdge();
    const { setups, logs, settle, outcomes } = owner(edge);
    setups.clicked(SID, session({ tmux: null }), switches({}), switches({ pane: true }));
    await settle();
    expect(did).toEqual([]);
    expect(logs).toEqual([
      expect.stringMatching(/^warn lane: pane on: .*not running inside tmux/),
    ]);
    expect(outcomes).toEqual([failed(said(logs[0]!))]);
  });

  test("a restart that fails after the click is logged, and the setup's outcome is the failure", async () => {
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
    const { setups, logs, settle, outcomes, performing } = owner(edge);
    setups.clicked(SID, session(), switches({}), switches({ statusline: true }));
    await settle();
    await waiting;
    expect(logs).toEqual([
      `info lane: statusline on — restarting Claude Code in %7 under the attach launcher by=click (session=${SID})`,
    ]);
    // Underway: the setup's outcome waits for the restart's end.
    expect(outcomes).toEqual([]);
    gone(false);
    await Promise.all(performing);
    expect(logs.at(-1)).toMatch(/^warn lane: statusline on: Claude Code in %7 did not exit/);
    expect(outcomes).toEqual([failed(said(logs.at(-1)!))]);
  });
});
