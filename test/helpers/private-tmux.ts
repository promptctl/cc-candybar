// A tmux server of a test's own: a socket in the test's directory, one session
// whose status options a daemon lays out and puts back, and a config that draws
// there. The daemon's status-line layout is only real on a real server.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { ClientHints } from "../../src/daemon/foundations/protocol";

export const HAS_TMUX = spawnSync("tmux", ["-V"]).status === 0;

export interface PrivateTmux {
  readonly socket: string;
  // A config drawing one segment in the tmux status line.
  readonly config: string;
  // What a client in the session's one pane reports.
  readonly hints: ClientHints;
  // The session's own options, as tmux shows them now.
  own(): string;
  // Ends the server: its one session was its last.
  kill(): void;
}

export function privateTmux(dir: string): PrivateTmux {
  const socket = path.join(dir, "tmux.sock");
  const tmux = (...args: string[]): string => {
    const run = spawnSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(`tmux ${args[0]}: ${run.stderr}`);
    return run.stdout;
  };
  const config = path.join(dir, "tmux.json5");
  writeFileSync(
    config,
    `{ globals: { renderer: "tmux" }, segments: { mark: { template: 'a mark' } }, root: { h: ['mark'] } }`,
  );
  tmux(
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "bar",
    "-x",
    "120",
    "-y",
    "40",
  );
  const pane = tmux("list-panes", "-t", "bar", "-F", "#{pane_id}").trim();
  return {
    socket,
    config,
    hints: {
      termCols: 120,
      termRows: 40,
      tmux: { socket, pane, truecolor: null },
    },
    own: () => tmux("show-options", "-t", "bar"),
    kill: () => {
      spawnSync("tmux", ["-S", socket, "kill-session", "-t", "bar"]);
    },
  };
}
