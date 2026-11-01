// A bar driven the way a user drives one: render it, click what it drew,
// render again — against an isolated daemon, a real one unless a test hands in
// another start. `pnpm bar` (scripts/drive-bar.ts) is its command line;
// test/drive-bar.test.ts holds it to its promises.
//
// [LAW:effects-at-boundaries] The daemon is the subject and a black box: an
// isolated daemon (its own socket, XDG dirs, Claude config dir, parent
// watchdog — never the developer's daemon or files) is driven only over its
// wire, so a render here is the bytes Claude Code would print and a click is
// the request the URL handler sends. Nothing is re-implemented in-process: the
// daemon's own render request composes the payload (unsaved counts, history,
// navigation), and its own verb table runs the click, validators included.
//
// [LAW:one-source-of-truth] The config the daemon reads is one file this
// harness owns, `--config`'s copy or `{}` (the bundled default with nothing
// over it), passed as the client's `--config`: the first rung of the search,
// and the file every save, reset and layout click writes.
//
// [LAW:no-silent-failure] A click on text the bar did not draw stops the run,
// naming what it did draw. A click the daemon refuses is a fact about the bar,
// not a failure of the harness: the refusal is returned beside the next render,
// which counts it with the indicator beside the door, as a user would see it. A slash
// command is refused by the daemon itself: the session reports a tmux pane (so
// the bar draws its slash controls, as it does for a session inside tmux) on a
// socket in the harness's scratch dir, where no tmux server listens. A click
// whose verb acts on the developer's machine
// (src/click/read HOST_VERBS: the clipboard, VS Code, a rebuild of this
// checkout) is never sent: it comes back as not sent, naming its effects, and
// the bar renders as it was. A click the
// daemon answers TIMEOUT stops the run: it may or may not have landed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cellLen } from "@promptctl/rich-js";

import { PARENT_PID_ENV } from "../../src/daemon/parent-watchdog";
import { BAR_SESSION_ID, hookData } from "../../scripts/lib/hook-data";
import { withStamp } from "../../scripts/version-stamp.cjs";
import { renderRequest, sendClick } from "./daemon-e2e";
import type { DaemonTarget } from "./daemon-wire";
import { prepareIsolatedDaemonEnv, spawnDaemonWithEnv } from "./spawn-isolated-daemon";
import {
  describeLink as describeWith,
  drawnLinks,
  effectsOf,
  HOST_VERBS,
  isBarLink,
  stripAnsi,
  type DrawnLink,
} from "../../src/click/read";

const SESSION_ID = BAR_SESSION_ID;
const REPLY_BUDGET_MS = 10_000;
/** The terminal the client reports: columns, and rows. */
export interface TerminalSize {
  readonly width: number;
  readonly rows: number;
}

export interface BarOptions extends TerminalSize {
  /** A config file to start from; the daemon reads and writes a copy. */
  readonly config: string | null;
  /** The session's working directory: git and the directory segment read it. */
  readonly cwd: string;
  /** Whether the client reports an ssh session (the host segment shows over ssh). */
  readonly ssh: boolean;
}

/** A click on a URL the last render did not draw: the page is showing an older render. */
export class NotDrawnError extends Error {}

/**
 * What a click did: the render after it, and why it did nothing, if it did
 * nothing — the daemon refused it, or the harness did not send it.
 */
export interface Clicked {
  readonly rendered: string;
  readonly refused: string | null;
}

export interface Bar {
  /** The config file the daemon reads and every durable click writes. */
  readonly configPath: string;
  render(): Promise<string>;
  /** Report a new terminal size; every render after it is drawn at that size. */
  resize(size: TerminalSize): void;
  /**
   * Click the `nth` (from 1) link of the last render whose visible text is
   * `text`, then render again.
   */
  click(text: string, nth?: number): Promise<Clicked>;
  /** Click the link of the last render that carries `url`, then render again. */
  follow(url: string): Promise<Clicked>;
  stop(): Promise<void>;
}

/** The daemon a bar draws on, and how it goes. */
export interface BarDaemon {
  readonly target: DaemonTarget;
  stop(): void | Promise<void>;
}

/** How a bar gets its daemon, from the env that isolates it. */
export type StartBarDaemon = (env: NodeJS.ProcessEnv) => Promise<BarDaemon>;

/** What `pnpm bar` runs: a real daemon that dies with this process. */
const spawnedBarDaemon: StartBarDaemon = async (env) => {
  const daemon = await spawnDaemonWithEnv({
    ...env,
    [PARENT_PID_ENV]: String(process.pid),
    NODE_OPTIONS: withStamp(process.env.NODE_OPTIONS),
  });
  return { target: env.CC_CANDYBAR_SOCKET!, stop: () => daemon.killTree() };
};

export { hookData };

export { drawnLinks, type DrawnLink };

/** The effects a click on `link` fires, `verb arg…` each, `;` between. */
export function describeLink(link: DrawnLink): string {
  return describeWith(link, SESSION_ID);
}

export async function startBar(
  opts: BarOptions,
  startDaemon: StartBarDaemon = spawnedBarDaemon,
): Promise<Bar> {
  const daemonEnv = prepareIsolatedDaemonEnv("ccb-bar");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bar-"));
  const removeDirs = (): void => {
    daemonEnv.removeTmpDirs();
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  const configPath = path.join(scratch, "config.json5");
  const claudeConfigDir = path.join(scratch, "claude");
  let daemon: BarDaemon;
  try {
    fs.writeFileSync(
      configPath,
      opts.config === null ? "{}\n" : fs.readFileSync(opts.config, "utf8"),
    );
    fs.mkdirSync(claudeConfigDir);
    daemon = await startDaemon({
      ...daemonEnv.env,
      // No update notice reaches the network: the registry is a closed port.
      CC_CANDYBAR_REGISTRY_URL: "http://127.0.0.1:1",
      // An empty Claude Code config dir, so the daemon reads none of the host's
      // Claude Code settings or transcripts.
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    });
  } catch (e) {
    removeDirs();
    throw e;
  }
  let last = "";
  let size: TerminalSize = { width: opts.width, rows: opts.rows };

  const render = async (): Promise<string> =>
    (last = await renderRequest(
      daemon.target,
      {
        hookData: hookData(opts.cwd, path.join(scratch, "transcript.jsonl")),
        args: ["cc-candybar", "--config", configPath],
        cwd: opts.cwd,
        termCols: size.width,
        termRows: size.rows,
        ssh: opts.ssh,
        tmux: { socket: path.join(scratch, "tmux.sock"), pane: "%0", truecolor: null },
        claudeConfigDir,
      },
      REPLY_BUDGET_MS,
    ));

  const click = async (text: string, nth = 1): Promise<Clicked> => {
    const drawn = drawnLinks(last);
    const hit = drawn.filter((l) => l.text === text)[nth - 1];
    if (hit === undefined) {
      throw new Error(
        `the bar drew no link "${text}" #${nth}; it drew: ` +
          drawn.map((l) => JSON.stringify(l.text)).join(" "),
      );
    }
    return send(hit);
  };

  // A URL is followed only if the last render drew it: a page showing an older
  // render would otherwise click what the bar no longer offers.
  const follow = async (url: string): Promise<Clicked> => {
    const hit = drawnLinks(last).find((l) => l.url === url);
    if (hit === undefined) {
      throw new NotDrawnError(`the last render drew no link to ${url}; render again and click what it drew`);
    }
    return send(hit);
  };

  const send = async (hit: DrawnLink): Promise<Clicked> => {
    if (!isBarLink(hit.url)) {
      throw new Error(`"${hit.text}" opens ${hit.url}: the terminal's click, not the daemon's`);
    }
    if (effectsOf(hit.url).some(({ verb }) => HOST_VERBS.has(verb))) {
      return { refused: `not sent: ${describeLink(hit)}`, rendered: await render() };
    }
    const resp = await sendClick(daemon.target, hit.url, REPLY_BUDGET_MS);
    if (!resp.ok && resp.code === "TIMEOUT") {
      throw new Error(`"${hit.text}" timed out: whether it landed is unknown (${resp.error})`);
    }
    return {
      refused: resp.ok ? null : `${resp.error} (${resp.code})`,
      rendered: await render(),
    };
  };

  return {
    configPath,
    render,
    resize: (next) => {
      size = next;
    },
    click,
    follow,
    stop: async () => {
      await daemon.stop();
      removeDirs();
    },
  };
}

/** `[cells] line` for each line, so a reader sees what fits a width. */
export function printable(rendered: string): string {
  return stripAnsi(rendered)
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `[${cellLen(line)}] ${line}`)
    .join("\n");
}

