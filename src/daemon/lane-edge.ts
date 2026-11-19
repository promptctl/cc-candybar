import type { Launcher } from "../proc/launcher.js";
import { runTmuxAsync } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import type { BarPaneEdge } from "./lane-setup.js";

async function tmux(
  launcher: Launcher,
  hint: TmuxHint,
  args: string[],
): Promise<string> {
  const run = await runTmuxAsync(launcher, hint, "lane.tmux", args);
  if (run.kind !== "ok") throw new Error(run.reason);
  return run.stdout;
}

// [LAW:one-source-of-truth] A bar pane names the pane whose bar it draws in
// the command it was started with, `… bar-pane <pane>`: the split that creates
// it records its owner, so no second write can be missed. tmux quotes words
// it stores (`"%0"`), and only the pane id's own characters are relied on.
// [LAW:effects-at-boundaries] Pure over tmux's `list-panes -a` in
// `PANE_STARTS_FORMAT`.
const PANE_STARTS_FORMAT = "#{pane_id} #{pane_start_command}";
const BAR_PANE_START = /(?:^|\s)bar-pane\s+["'\\]*(%\d+)["']*\s*$/;
export function barPanesOf(listPanes: string, pane: string): string[] {
  return listPanes.split("\n").flatMap((line) => {
    const [id, ...start] = line.trim().split(" ");
    return BAR_PANE_START.exec(start.join(" "))?.[1] === pane ? [id!] : [];
  });
}

// [LAW:effects-at-boundaries] The tmux pane’s host adapter.
export function productionBarPaneEdge(launcher: Launcher): BarPaneEdge {
  return {
    barPanes: async (hint) =>
      barPanesOf(
        await tmux(launcher, hint, [
          "list-panes",
          "-a",
          "-F",
          PANE_STARTS_FORMAT,
        ]),
        hint.pane,
      ),
    // Two or more words after the options are run as they are, with no shell
    // between (tmux ≥ 3.0), so no path in `argv` needs quoting for one.
    // [LAW:no-ambient-temporal-coupling] One launch: the split records the
    // pane's owner in its command (`barPanesOf`), so a daemon closing after it
    // leaves no bar pane `pane off` cannot find. `-d` leaves focus untouched.
    openBarPane: async (hint, argv, env) =>
      (
        await tmux(launcher, hint, [
          "split-window",
          "-d",
          "-v",
          "-l",
          "1",
          "-t",
          hint.pane,
          "-P",
          "-F",
          "#{pane_id}",
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          ...argv,
        ])
      ).trim(),
    closePane: async (hint, pane) =>
      void (await tmux(launcher, hint, ["kill-pane", "-t", pane])),
  };
}
