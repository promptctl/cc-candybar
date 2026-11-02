// [LAW:behavior-not-structure] A bar pane the lane edge opens on a real tmux
// server names its owner from the moment it exists: a daemon closing during the open
// leaves no pane `pane off` cannot find, and the user's pane keeps focus.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { productionLaneEdge } from "../src/daemon/lane-edge";
import { processLauncher, type Launcher } from "../src/proc/launch";
import type { TmuxHint } from "../src/tmux-hint";

const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;

(HAS_TMUX ? describe : describe.skip)("a bar pane on a real tmux", () => {
  let dir: string;
  let socket: string;
  let hint: TmuxHint;
  // The argv's tail is a bar pane's own: `bar-pane <pane>`.
  const barPane = (): string[] => [
    "/bin/sh",
    "-c",
    "sleep 60",
    "bar-pane",
    hint.pane,
  ];
  const tmux = (...args: string[]): string => {
    const run = spawnSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(`tmux ${args[0]}: ${run.stderr}`);
    return run.stdout;
  };
  const panes = (): string[] =>
    tmux("list-panes", "-a", "-F", "#{pane_id}").trim().split("\n");
  const active = (): string =>
    tmux("display-message", "-p", "-t", "bar", "#{pane_id}").trim();

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ccb-bar-pane-"));
    socket = path.join(dir, "tmux.sock");
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "bar",
      "-x",
      "80",
      "-y",
      "20",
    );
    hint = { socket, pane: panes()[0]!, truecolor: null };
  });

  afterEach(() => {
    // The private server's one session: tmux exits with its last.
    spawnSync("tmux", ["-S", socket, "kill-session", "-t", "bar"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a daemon closing once the open's first launch answers leaves the pane tagged", async () => {
    const closing = new AbortController();
    // Every launch after the first is refused, as a closed daemon's are.
    let launches = 0;
    const launcher: Launcher = {
      ...processLauncher,
      launch: async (opts) => {
        launches += 1;
        const result = await processLauncher.launch({
          ...opts,
          signal: launches > 1 ? AbortSignal.abort() : undefined,
        });
        closing.abort();
        return result;
      },
    };
    const edge = productionLaneEdge(launcher, () => new Set(), closing.signal);

    const opened = await edge.openBarPane(hint, barPane(), {});

    expect(panes()).toContain(opened);
    const tagged = productionLaneEdge(
      processLauncher,
      () => new Set(),
      new AbortController().signal,
    );
    expect(await tagged.barPanes(hint)).toEqual([opened]);
    expect(active()).toBe(hint.pane);
  });

  test("the pane the user is in keeps focus", async () => {
    const theirs = tmux(
      "split-window",
      "-h",
      "-t",
      hint.pane,
      "-P",
      "-F",
      "#{pane_id}",
      "sleep",
      "60",
    ).trim();
    const edge = productionLaneEdge(
      processLauncher,
      () => new Set(),
      new AbortController().signal,
    );

    await edge.openBarPane(hint, barPane(), {});

    expect(active()).toBe(theirs);
  });

  test("a failed split is reported as the split, and tags nothing", async () => {
    // One row has no room for another pane.
    tmux("resize-window", "-t", "bar", "-y", "1");
    const edge = productionLaneEdge(
      processLauncher,
      () => new Set(),
      new AbortController().signal,
    );

    await expect(edge.openBarPane(hint, barPane(), {})).rejects.toThrow(
      /tmux split-window failed/,
    );
    expect(await edge.barPanes(hint)).toEqual([]);
  });
});
