// A bar driven the way a user drives one: render it, click what it drew,
// render again — against an isolated daemon its caller says how to start.
// `pnpm bar` (scripts/drive-bar.ts) is its command line;
// test/daemon-boots/worker/drive-bar.test.ts holds it to its promises.
//
// [LAW:effects-at-boundaries] The daemon is the subject and a black box: an
// isolated daemon (its own socket, XDG dirs, Claude config dir, parent
// watchdog — never the developer's daemon or files) is driven only over its
// wire, so a render here is the Frame of what Claude Code would print and a
// click is the request the URL handler sends. Nothing is re-implemented in-process: the
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
// the bar renders as it was. A click the daemon answers TIMEOUT did not run
// its action, so it is sent again, and what became of it is the answer it gets.

import fs from "node:fs";
import path from "node:path";
import { cellLen } from "@promptctl/rich-js";

import { PARENT_PID_ENV } from "../../src/daemon/parent-watchdog";
import { sessionStatePath } from "../../src/daemon/paths";
import { hostOf } from "./host";
import { BAR_SESSION_ID, barHook } from "./hook-data";
import { withStamp } from "./version-stamp.cjs";
import { textOf, type Frame } from "../../src/render/frame";
import { renderFrame, saidOf, sendClick } from "./daemon/requests";
import type { DaemonTarget } from "./daemon/wire";
import {
  prepareIsolatedDaemonEnv,
  startDaemonWithEnv,
  type IsolatedDaemonEnv,
} from "./daemon/isolated";
import type { AcquireSlot } from "./daemon/process";
import { reportedEnvironment } from "./session-env";
import type { ShellEnvironment } from "./shell";
import {
  describeLink as describeWith,
  effectsOf,
  HOST_VERBS,
  linksOf,
  type DrawnLink,
} from "../../src/click/read";
import { isBarLink } from "../../src/click/wire";

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
  /** The environment the daemon runs in, and the session reports its PATH from. */
  readonly shell: ShellEnvironment;
}

/** A click on a URL the last render did not draw: the page is showing an older render. */
export class NotDrawnError extends Error {}

/**
 * What a click did: the render after it, and why it did nothing, if it did
 * nothing — the daemon refused it, or the harness did not send it.
 */
export interface Clicked {
  readonly rendered: Frame;
  readonly refused: string | null;
}

/** The stored session state: each session's keys and values. */
type StoredSessions = Record<string, Record<string, string>>;

/** One Claude Code session's view of the bar: what it renders and clicks. */
export interface BarSession {
  render(): Promise<Frame>;
  /**
   * Click the `nth` (from 1) link of the last render whose visible text is
   * `text`, then render again.
   */
  click(text: string, nth?: number): Promise<Clicked>;
  /** Click the link of the last render that carries `url`, then render again. */
  follow(url: string): Promise<Clicked>;
  /**
   * Click a link an older render drew, as a terminal still showing that render
   * would, then render again.
   */
  stale(link: DrawnLink): Promise<Clicked>;
}

export interface Bar extends BarSession {
  /** The config file the daemon reads and every durable click writes. */
  readonly configPath: string;
  /** Report a new terminal size; every render after it is drawn at that size. */
  resize(size: TerminalSize): void;
  /** Another session on the same daemon and config, under its own id. */
  session(id: string): BarSession;
  /**
   * Stop the daemon and start another over the same state and config, the
   * stored session state first rewritten by `rewrite`, as an older build may
   * have left it.
   */
  restart(rewrite?: (stored: StoredSessions) => StoredSessions): Promise<void>;
  /** The session store as the daemon last kept it: what a restart loads. */
  stored(): StoredSessions;
  stop(): Promise<void>;
}

/** The daemon a bar draws on, and how it goes. */
interface BarDaemon {
  readonly target: DaemonTarget;
  stop(): void | Promise<void>;
}

/** How a bar gets its daemon, from the isolated env it runs in. */
export type StartBarDaemon = (isolated: IsolatedDaemonEnv) => Promise<BarDaemon>;

// A hand-run tool's daemon takes no place under the test suite's ceiling: one
// per run, and it dies with the tool.
const outsideThePool: AcquireSlot = async () => ({ release: () => {} });

/** A real daemon that dies with this process: the one a hand-run tool draws on. */
export const realBarDaemon: StartBarDaemon = async ({ env, sockPath }) => {
  const daemon = await startDaemonWithEnv(
    {
      ...env,
      [PARENT_PID_ENV]: String(process.pid),
      NODE_OPTIONS: withStamp(env.NODE_OPTIONS),
    },
    outsideThePool,
  );
  return {
    target: sockPath,
    stop: async () => {
      await daemon.stop();
    },
  };
};

export { linksOf, type DrawnLink };

/** The effects a click on `link` fires, `verb arg…` each, `;` between. */
export function describeLink(link: DrawnLink): string {
  return describeWith(link, SESSION_ID);
}

export async function startBar(
  opts: BarOptions,
  startDaemon: StartBarDaemon,
): Promise<Bar> {
  const daemonEnv = prepareIsolatedDaemonEnv("ccb-bar", opts.shell);
  // What the bar itself writes, under the daemon's temporary root, so the one
  // removal that takes the daemon's directories takes these too.
  const scratch = path.join(daemonEnv.root, "bar");
  const configPath = path.join(scratch, "config.json5");
  const claudeConfigDir = path.join(scratch, "claude");
  const isolated: IsolatedDaemonEnv = {
    ...daemonEnv,
    env: {
      ...daemonEnv.env,
      // An empty Claude Code config dir, so the daemon reads none of the
      // host's Claude Code settings or transcripts.
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  };
  // [LAW:one-source-of-truth] The environment the bar's client reports: where
  // its tools live, and the same empty Claude Code config dir it reports as
  // `claudeConfigDir`, so the two name one directory.
  const sessionEnv = reportedEnvironment(opts.shell.PATH, claudeConfigDir);
  let daemon: BarDaemon;
  try {
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      opts.config === null ? "{}\n" : fs.readFileSync(opts.config, "utf8"),
    );
    daemon = await startDaemon(isolated);
  } catch (e) {
    daemonEnv.removeTmpDirs();
    throw e;
  }
  let size: TerminalSize = { width: opts.width, rows: opts.rows };
  // [LAW:one-source-of-truth] The file the daemon keeps, named by the daemon's
  // own path, so a read of it cannot look somewhere the daemon never writes
  // and find nothing. Absent is the empty store, as the daemon reads it.
  const storedPath = sessionStatePath(hostOf(isolated.env));
  const stored = (): StoredSessions =>
    fs.existsSync(storedPath)
      ? (JSON.parse(fs.readFileSync(storedPath, "utf8")) as StoredSessions)
      : {};

  const sessionOf = (sessionId: string): BarSession => {
    let last: Pick<Frame, "rows"> = { rows: [] };
    const render = async (): Promise<Frame> => {
      const frame = await renderFrame(
        daemon.target,
        {
          env: sessionEnv,
          hookData: {
            ...barHook(opts.cwd, path.join(scratch, "transcript.jsonl")),
            session_id: sessionId,
          },
          args: ["cc-candybar", "--config", configPath],
          cwd: opts.cwd,
          termCols: size.width,
          termRows: size.rows,
          ssh: opts.ssh,
          tmux: {
            socket: path.join(scratch, "tmux.sock"),
            pane: "%0",
            truecolor: null,
          },
          claudeConfigDir,
        },
        REPLY_BUDGET_MS,
      );
      last = frame;
      return frame;
    };

    const click = async (text: string, nth = 1): Promise<Clicked> => {
      const drawn = linksOf(last);
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
      const hit = linksOf(last).find((l) => l.url === url);
      if (hit === undefined) {
        throw new NotDrawnError(
          `the last render drew no link to ${url}; render again and click what it drew`,
        );
      }
      return send(hit);
    };

    const send = async (hit: DrawnLink): Promise<Clicked> => {
      if (!isBarLink(hit.url)) {
        throw new Error(
          `"${hit.text}" opens ${hit.url}: the terminal's click, not the daemon's`,
        );
      }
      if (effectsOf(hit.url).some(({ verb }) => HOST_VERBS.has(verb))) {
        return {
          refused: `not sent: ${describeWith(hit, sessionId)}`,
          rendered: await render(),
        };
      }
      const answer = await sendClick(daemon.target, hit.url, REPLY_BUDGET_MS);
      return {
        refused: answer.ok ? null : saidOf(answer),
        rendered: await render(),
      };
    };
    return { render, click, follow, stale: send };
  };

  return {
    configPath,
    ...sessionOf(SESSION_ID),
    resize: (next) => {
      size = next;
    },
    session: sessionOf,
    restart: async (rewrite = (stored) => stored) => {
      await daemon.stop();
      fs.writeFileSync(storedPath, JSON.stringify(rewrite(stored())));
      daemon = await startDaemon(isolated);
    },
    stored,
    // A stop that fails has still killed the daemon and seen it exit, so its
    // directories go either way.
    stop: async () => {
      try {
        await daemon.stop();
      } finally {
        daemonEnv.removeTmpDirs();
      }
    },
  };
}

/** `[cells] line` for each line, so a reader sees what fits a width. */
export function printable(frame: Pick<Frame, "rows">): string {
  return textOf(frame)
    .split("\n")
    .map((line) => `[${cellLen(line)}] ${line}`)
    .join("\n");
}
