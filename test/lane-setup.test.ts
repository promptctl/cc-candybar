import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { attachCommandLine } from "../src/attach-launcher";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { TmuxHint } from "../src/tmux-hint";
import type { ClaudeInputEdge } from "../src/claude-input/typing";
import { Acts, type HostAct } from "../src/daemon/acts";
import { systemTimekeeper } from "../scripts/lib/system-clock";
import type { EffectId } from "../src/renderer-interface/interface";

const SID = sessionIdOf("1f6e0c2a-0d0e-4a52-9d1b-2b0b0f0e0a11");
const TMUX: TmuxHint = {
  socket: "/tmp/tmux-1/default",
  pane: "%7",
  truecolor: null,
};
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

const READY_SCREEN = ["─".repeat(30), "❯ ", "─".repeat(30)];

describe("tmux pane effects", () => {
  let ids = 0;
  const performer = (
    input: Partial<ClaudeInputEdge> = {},
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
      closing,
      log: (level, msg) => void logs.push(`${level} ${msg}`),
    });
    return { acts, logs };
  };

  test("one pane's slash lines are typed one at a time, each after the last has finished", async () => {
    const typing: string[] = [];
    let typed!: () => void;
    const { acts } = performer({
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
    const {acts}=performer({read:reads,type:typed},()=>closing);
    const opening=acts.inPaneTurn(TMUX,()=>{started();return new Promise<string>(r=>{releaseSplit=r;});});
    await splitStarted;
    const slash = acts.perform({
      kind: "type-slash",
      id: ++ids as EffectId,
      session: SID,
      pane: TMUX,
      line: "/compact" as never,
    });
    const cleanup = expect(acts.inPaneTurn(TMUX,removed)).rejects.toThrow(
      "the daemon closed",
    );
    closing = true;
    releaseSplit("%9");

    await expect(opening).resolves.toBe("%9");
    await expect(slash).resolves.toMatchObject({ kind: "closing" });
    await cleanup;
    expect(reads).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  test("a slash line while a bar pane opens under its pane is typed, after the split", async () => {
    let split!: () => void;
    const {acts}=performer();
    const opening=acts.inPaneTurn(TMUX,()=>new Promise<void>(r=>{split=r;}));
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
