import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  paneOn,
  paneOff,
  type BarPaneEdge,
  type BarPaneHost,
} from "../src/daemon/lane-setup";
import { barPanesOf } from "../src/daemon/lane-edge";
import { attachCommandLine } from "../src/attach-launcher";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { TmuxHint } from "../src/tmux-hint";
import type { ClaudeInputEdge } from "../src/claude-input/typing";
import { DesktopActs } from "../src/daemon/desktop-acts";
import { Acts, type HostAct } from "../src/daemon/acts";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import type { EffectId } from "../src/renderer-interface/interface";

const SID = sessionIdOf("1f6e0c2a-0d0e-4a52-9d1b-2b0b0f0e0a11");
const TMUX: TmuxHint = {
  socket: "/tmp/tmux-1/default",
  pane: "%7",
  truecolor: null,
};
const HOST: BarPaneHost = {
  bundle: "/opt/candybar/dist/index.mjs",
  node: ["/usr/bin/node"],
  socket: "/tmp/cc-candybar-1/socket",
};

function fakeEdge(overrides: Partial<BarPaneEdge> = {}) {
  const did: string[] = [];
  const edge: BarPaneEdge = {
    barPanes: async () => [],
    openBarPane: async (hint, argv, env) => {
      did.push(
        `open under ${hint.pane}: ${argv.join(" ")} ${JSON.stringify(env)}`,
      );
      return "%9";
    },
    closePane: async (_hint, pane) => void did.push(`close ${pane}`),
    ...overrides,
  };
  return { edge, did };
}

describe("the tmux bar pane", () => {
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

const SHELLS = [
  "/bin/sh",
  "/opt/homebrew/bin/zsh",
  "/opt/homebrew/bin/bash",
  "/opt/homebrew/bin/fish",
].filter((shell) => fs.existsSync(shell));

describe("the manual attached statusline command", () => {
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
});

const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];

describe("tmux pane effects", () => {
  let ids = 0;
  const performer = (
    edge: BarPaneEdge,
    input: Partial<ClaudeInputEdge> = {},
    host = HOST,
    closing = () => false,
  ) => {
    const logs: string[] = [];
    const missing = async (): Promise<never> => {
      throw new Error("not in this test");
    };
    const acts = new Acts({
      detach: systemTimekeeper.detach,
      programsFor: () => ({
        launch: missing,
        claudeInput: {
          read: async () => ({ inMode: false, screen: READY_SCREEN }),
          type: async () => ({ kind: "typed" }),
          ...input,
        },
      }),
      run: missing,
      desktop: new DesktopActs(),
      barPane: { edge, host },
      closing,
      log: (level, msg) => void logs.push(`${level} ${msg}`),
    });
    return { acts, logs };
  };

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

  test("only the pane act in progress reaches tmux when shutdown begins", async () => {
    let closing = false;
    const reads = jest.fn(async () => ({
      inMode: false,
      screen: READY_SCREEN,
    }));
    const typed = jest.fn(async () => ({ kind: "typed" }) as const);
    const removed = jest.fn(async () => {});
    let releaseSplit!: (pane: string) => void;
    let started!: () => void;
    const splitStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { edge } = fakeEdge({
      openBarPane: () => {
        started();
        return new Promise((resolve) => {
          releaseSplit = resolve;
        });
      },
      closePane: removed,
    });
    const { acts } = performer(
      edge,
      { read: reads, type: typed },
      HOST,
      () => closing,
    );

    const opening = acts.setBarPane(TMUX, true);
    await splitStarted;
    const slash = acts.perform({
      kind: "type-slash",
      id: ++ids as EffectId,
      session: SID,
      pane: TMUX,
      line: "/compact" as never,
    });
    const cleanup = expect(acts.setBarPane(TMUX, false)).rejects.toThrow(
      "the daemon closed",
    );
    closing = true;
    releaseSplit("%9");

    await expect(opening).resolves.toBe("opened bar pane %9 under %7");
    await expect(slash).resolves.toMatchObject({ kind: "closing" });
    await cleanup;
    expect(reads).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  test("a slash line while a bar pane opens under its pane is typed, after the split", async () => {
    let split!: () => void;
    const { edge } = fakeEdge({
      openBarPane: () => new Promise((r) => (split = () => r("%9"))),
    });
    const { acts } = performer(edge);
    const opening = acts.setBarPane(TMUX, true);
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
});
