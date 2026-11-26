// A test-owned tmux server with one session and a private socket.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { ClientHints } from "../../src/daemon/foundations/protocol";

export interface TmuxServer {
  readonly socket: string;
  // The session's one pane, until a test splits it.
  readonly pane: string;
  run(...args: string[]): string;
  // Ends the server: its one session was its last.
  kill(): void;
}

// tmux takes its shell from the environment of whoever starts the server, and
// starts a session's pane as that shell's login, so a pane left to its default
// runs the user's own startup files. The config names the shell, and the pane
// runs `cat`, which waits on the pane and does nothing.
const CONFIG = [
  "set -g default-shell /bin/sh",
  'set -g default-command "exec cat"',
  "",
].join("\n");

export function tmuxServer(
  dir: string,
  size: { readonly cols: number; readonly rows: number },
): TmuxServer {
  const socket = path.join(dir, "tmux.sock");
  const run = (...args: string[]): string => {
    const ran = spawnSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
    });
    // [LAW:no-silent-failure] A machine without tmux fails here by name.
    if (ran.error) throw ran.error;
    if (ran.status !== 0) throw new Error(`tmux ${args[0]}: ${ran.stderr}`);
    return ran.stdout;
  };
  const config = path.join(dir, "tmux.conf");
  writeFileSync(config, CONFIG);
  run(
    "-f",
    config,
    "new-session",
    "-d",
    "-s",
    "bar",
    "-x",
    String(size.cols),
    "-y",
    String(size.rows),
  );
  return {
    socket,
    pane: run("list-panes", "-t", "bar", "-F", "#{pane_id}").trim(),
    run,
    kill: () => {
      spawnSync("tmux", ["-S", socket, "kill-session", "-t", "bar"]);
    },
  };
}

export interface PrivateTmux extends TmuxServer {
  // A config from before the tmux status surface was retired.
  readonly config: string;
  // What a client in the session's one pane reports.
  readonly hints: ClientHints;
  // The session's own options, as tmux shows them now.
  own(): string;
}

export function privateTmux(dir: string): PrivateTmux {
  const server = tmuxServer(dir, { cols: 120, rows: 40 });
  const config = path.join(dir, "tmux.json5");
  writeFileSync(
    config,
    `{ globals: { renderer: "tmux" }, segments: { mark: { template: 'a mark' } }, root: { h: ['mark'] } }`,
  );
  return {
    ...server,
    config,
    hints: {
      termCols: 120,
      termRows: 40,
      tmux: { socket: server.socket, pane: server.pane, truecolor: null },
    },
    own: () => server.run("show-options", "-t", "bar"),
  };
}
