// [LAW:behavior-not-structure] A bar pane the lane edge opens on a real tmux
// server names its owner from the moment it exists: a daemon closing during the open
// leaves no pane `pane off` cannot find, and the user's pane keeps focus.

import { processLauncher } from "./helpers/host";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { productionBarPaneEdge } from "../src/daemon/lane-edge";
import { type Launcher } from "../src/proc/launcher";
import type { TmuxHint } from "../src/tmux-hint";
import { tmuxServer, type TmuxServer } from "./helpers/private-tmux";

describe("a bar pane on a real tmux", () => {
  let dir: string;
  let server: TmuxServer;
  let hint: TmuxHint;
  // The argv's tail is a bar pane's own: `bar-pane <pane>`.
  const barPane = (): string[] => [
    "/bin/sh",
    "-c",
    "sleep 60",
    "bar-pane",
    hint.pane,
  ];
  const panes = (): string[] =>
    server.run("list-panes", "-a", "-F", "#{pane_id}").trim().split("\n");
  const active = (): string =>
    server.run("display-message", "-p", "-t", "bar", "#{pane_id}").trim();

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ccb-bar-pane-"));
    server = tmuxServer(dir, { cols: 80, rows: 20 });
    hint = { socket: server.socket, pane: server.pane, truecolor: null };
  });

  afterEach(() => {
    server.kill();
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
    const edge = productionBarPaneEdge(launcher);

    const opened = await edge.openBarPane(hint, barPane(), {});

    expect(panes()).toContain(opened);
    const tagged = productionBarPaneEdge(processLauncher);
    expect(await tagged.barPanes(hint)).toEqual([opened]);
    expect(active()).toBe(hint.pane);
  });

  test("the pane the user is in keeps focus", async () => {
    const theirs = server.run(
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
    const edge = productionBarPaneEdge(processLauncher);

    await edge.openBarPane(hint, barPane(), {});

    expect(active()).toBe(theirs);
  });

  test("a failed split is reported as the split, and tags nothing", async () => {
    // One row has no room for another pane.
    server.run("resize-window", "-t", "bar", "-y", "1");
    const edge = productionBarPaneEdge(processLauncher);

    await expect(edge.openBarPane(hint, barPane(), {})).rejects.toThrow(
      /tmux split-window failed/,
    );
    expect(await edge.barPanes(hint)).toEqual([]);
  });
});
