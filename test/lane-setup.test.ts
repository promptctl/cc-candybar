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
import { runsAttached, taggedBarPanes } from "../src/daemon/lane-edge";
import { turnRunning } from "../src/claude-input/prompt-screen";
import { BadVerbArgs } from "../src/daemon/verb-error";
import { SessionState } from "../src/daemon/session-state";
import { holdClickError } from "../src/daemon/click-error";
import { instantOf } from "../src/utils/instant";
import type { Lane, LaneSwitches } from "../src/config/lanes";
import type { TmuxHint } from "../src/tmux-hint";
import { SESSION_CLIENT_HINTS_KEY, VERBS } from "../src/daemon/verbs";
import { VERB_LANE } from "../src/click/wire";
import { recordRender, testVerbContext } from "./helpers/click";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";

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
});

// Every effect recorded, in the order it ran.
function fakeEdge(over: Partial<LaneEdge> = {}): { edge: LaneEdge; did: string[] } {
  const did: string[] = [];
  const claude: PaneClaude = {
    pid: 4242,
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
      did.push(`script ${file}:\n${text(file)}`);
      return file;
    },
    exited: async () => true,
    typeShellLine: (_hint, line) => void did.push(`shell ${line}`),
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
  test("on exits Claude Code, then starts it again under cc-attach on the same session", async () => {
    const { edge, did } = fakeEdge();
    const out = LANE_SETUP.statusline.on(session(), HOST, edge);
    // The click itself does nothing in the pane.
    expect(did).toEqual([]);
    await expect(finished(out)).resolves.toContain("under cc-attach");
    expect(did).toEqual([
      `script /run/relaunch-${SID}.sh:\n${relaunchScript(
        `/run/relaunch-${SID}.sh`,
        "/work/tree",
        ["--dangerously-skip-permissions", "--resume", SID],
      )}`,
      "type /exit",
      `shell sh /run/relaunch-${SID}.sh`,
    ]);
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

  test.each([
    ["✽ Processing… (26s · ↓ 2.0k tokens · thought for 15s)", true],
    ["✻ Cogitating… (1m 4s · esc to interrupt)", true],
    ["  ⏺ I'll look at the file… (it is long)", false],
    ["❯ ", false],
  ])("turnRunning(%j) is %p", (line, running) => {
    expect(turnRunning({ inMode: false, screen: [line] })).toBe(running);
  });

  test("a Claude Code already under cc-attach is left running", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
        argv: ["cc-attach"],
        cwd: "/",
        fromShell: true,
        attached: true,
      }),
    });
    await expect(
      finished(LANE_SETUP.statusline.on(session(), HOST, edge)),
    ).resolves.toContain("already runs under cc-attach");
    expect(did).toEqual([]);
  });

  test("a Claude Code that is its pane's first process is refused: nothing would restart it", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
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

  test("a flag cc-candybar cannot carry refuses the restart before /exit is typed", async () => {
    const { edge, did } = fakeEdge({
      paneClaude: async () => ({
        pid: 1,
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
  test("resumes under cc-attach where it is on PATH, else in stock Claude Code, quoting every word", () => {
    const script = relaunchScript("/run/r.sh", "/it's/here", ["--model", "a b"]);
    expect(script.split("\n")).toEqual([
      "rm -f -- '/run/r.sh'",
      `cd -- '/it'\\''s/here' || exit 1`,
      "if command -v cc-attach >/dev/null 2>&1; then exec cc-attach '--model' 'a b'; fi",
      expect.stringMatching(/^echo '.*cc-attach on PATH.*' >&2$/),
      "exec claude '--model' 'a b'",
      "",
    ]);
  });

  test("runs under sh: the session resumes in stock Claude Code when cc-attach is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-script-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const record = path.join(dir, "ran");
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\npwd > ${record}\nprintf '%s\\n' "$@" >> ${record}\n`,
      { mode: 0o755 },
    );
    const self = path.join(dir, "r.sh");
    fs.writeFileSync(self, relaunchScript(self, dir, ["--model", "a b", "--resume", SID]));
    const { status, stderr } = spawnSync(
      "/bin/sh",
      [self],
      { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" },
    );
    expect(status).toBe(0);
    expect(stderr).toContain("cc-attach on PATH");
    expect(fs.readFileSync(record, "utf8").split("\n")).toEqual([
      dir,
      "--model",
      "a b",
      "--resume",
      SID,
      "",
    ]);
    expect(fs.existsSync(self)).toBe(false);
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
});

describe("LaneSetups", () => {
  const owner = (edge: LaneEdge, switches: LaneSwitches) => {
    const state = new SessionState();
    const logs: string[] = [];
    const setups = new LaneSetups({
      edge,
      host: HOST,
      switches: () => switches,
      state,
      log: (level, msg) => logs.push(`${level} ${msg}`),
      now: () => instantOf(new Date(0)),
    });
    return { setups, state, logs };
  };
  const ON: LaneSwitches = { band: true, statusline: true, pane: true };
  const OFF: LaneSwitches = { band: false, statusline: false, pane: false };

  test.each<[Lane, LaneSwitches, string]>([
    ["pane", ON, "lane: pane on — opened bar pane %9 under %7"],
    ["pane", OFF, "lane: pane off — no bar pane draws %7's bar"],
  ])("%s with the switch read as set logs what it did", (lane, switches, line) => {
    const { setups, logs } = owner(fakeEdge().edge, switches);
    setups.sync(session(), lane);
    expect(logs).toEqual([`info ${line} (session=${SID})`]);
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
    const { setups, state, logs } = owner(edge, ON);
    setups.sync(session(), "statusline");
    await waiting;
    expect(logs).toEqual([
      `info lane: statusline on — restarting Claude Code in %7 under cc-attach (session=${SID})`,
    ]);
    gone(false);
    await new Promise((r) => setImmediate(r));
    expect(logs.at(-1)).toMatch(/^warn lane: Claude Code in %7 did not exit/);
    const expected = new SessionState();
    holdClickError(
      expected,
      SID,
      logs.at(-1)!.replace(/^warn /, "").replace(` (session=${SID})`, ""),
      instantOf(new Date(0)),
    );
    expect(state.get(SID, "click.error")).toBe(expected.get(SID, "click.error"));
  });
});

describe("the lane verb", () => {
  const ctxWith = (synced: [string, Lane][]) => {
    const state = new SessionState();
    recordRender(state, SID);
    state.set(SID, SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux: TMUX }));
    return {
      ...testVerbContext(state),
      lanes: {
        sync: (s: LaneSession, lane: Lane) => {
          synced.push([s.sessionId, lane]);
          return "";
        },
      },
    };
  };

  test("hands the session, its recorded client and its render origin to the setup", () => {
    const synced: [string, Lane][] = [];
    VERBS.get(VERB_LANE)!(`${SID}/pane`, ctxWith(synced) as never);
    expect(synced).toEqual([[SID, "pane"]]);
  });

  test("a lane it does not know is refused, naming the lanes", () => {
    const synced: [string, Lane][] = [];
    expect(() =>
      VERBS.get(VERB_LANE)!(`${SID}/warp`, ctxWith(synced) as never),
    ).toThrow(/expected one of band, statusline, pane/);
    expect(synced).toEqual([]);
  });
});

describe("the lane action at load", () => {
  const ALLOWED = new Set(listResolvablePaletteNames());
  const load = (action: unknown) =>
    parseAndValidate(
      "<user>",
      JSON.stringify({ actions: { a: action } }),
      ALLOWED,
      DEFAULT_DSL_CONFIG,
    );

  test("names a lane", () => {
    expect(load({ lane: "band" }).actions.a).toEqual({ lane: "band" });
  });

  test.each([
    [{ lane: "warp" }, 'lane must be one of "band", "statusline", "pane"'],
    [{ lane: "pane", to: "on" }, 'Unknown key "to" on a lane action'],
  ])("%j is refused", (action, message) => {
    expect(() => load(action)).toThrow(message);
  });
});
