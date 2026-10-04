// A bar driven the way a user drives one: render it, click what it drew,
// render again — against an isolated real daemon. `pnpm bar`
// (scripts/drive-bar.ts) is its command line; test/drive-bar.test.ts holds it
// to its promises.
//
// [LAW:effects-at-boundaries] The daemon is the subject and a black box: an
// isolated real daemon (its own socket, XDG dirs, Claude config dir, parent
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
// which shows it in the red strip exactly as a user would see it. A slash
// command is refused by the daemon itself, since this session records no
// Claude Code pane. A click whose verb acts on the developer's machine (the
// clipboard, VS Code, a rebuild of this checkout) is never sent: it comes back
// as not sent, naming its effects, and the bar renders as it was. A click the
// daemon answers TIMEOUT stops the run: it may or may not have landed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cellLen } from "@promptctl/rich-js";

import { PARENT_PID_ENV } from "../../src/daemon/parent-watchdog";
import {
  URL_SCHEME,
  VERB_APPLY_UPDATE,
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
} from "../../src/click/wire";
import type { ClaudeHookData } from "../../src/utils/claude";
import { withStamp } from "../../scripts/version-stamp.cjs";
import { renderRequest, sendClick } from "./daemon-e2e";
import { prepareIsolatedDaemonEnv, spawnDaemonWithEnv } from "./spawn-isolated-daemon";
import { links, stripAnsi } from "./ansi";
import { effectsOf } from "./click";

const SESSION_ID = "bar0a1b2-c3d4-4e5f-8a7b-8c9d0e1f2a3b";
const REPLY_BUDGET_MS = 10_000;
// The verbs whose handler acts outside the daemon on this machine: pbcopy,
// `open -a "Visual Studio Code"`, `pnpm build` in the checkout.
const MACHINE_VERBS: ReadonlySet<string> = new Set([
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
  VERB_APPLY_UPDATE,
]);

/** The terminal the client reports: columns, and rows (which cap the diagnostic strip). */
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

/** One link the bar drew: its visible text and every effect a click on it fires. */
export interface DrawnLink {
  readonly text: string;
  readonly url: string;
}

/**
 * What a click did: the render after it, and why it did nothing, if it did
 * nothing — the daemon refused it, or the harness did not send it.
 */
/** A click on a URL the last render did not draw: the page is showing an older render. */
export class NotDrawnError extends Error {}

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
  stop(): void;
}

// The Status hook Claude Code sends, with every field the bundled bar reads
// set, so each of its segments draws: context, cost, both rate-limit windows.
function hookData(cwd: string, transcriptPath: string): ClaudeHookData {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    hook_event_name: "Status",
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
    cwd,
    version: "2.1.0",
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
    cost: {
      total_cost_usd: 0.39,
      total_duration_ms: 930_000,
      total_api_duration_ms: 410_000,
      total_lines_added: 512,
      total_lines_removed: 88,
    },
    context_window: {
      total_input_tokens: 48_000,
      total_output_tokens: 487,
      context_window_size: 200_000,
      used_percentage: 24,
      remaining_percentage: 76,
      current_usage: {
        input_tokens: 2_000,
        output_tokens: 487,
        cache_creation_input_tokens: 6_000,
        cache_read_input_tokens: 40_000,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 63, resets_at: nowSec + 2 * 3600 },
      seven_day: { used_percentage: 21, resets_at: nowSec + 5 * 86400 },
    },
  };
}

/** Every link `rendered` draws, by visible text. */
export function drawnLinks(rendered: string): DrawnLink[] {
  return links(rendered).map((l) => ({
    text: stripAnsi(l.text).trim(),
    url: l.url,
  }));
}

// A link outside the cc-candybar scheme (a repo page, a PR) is the
// terminal's to open; the daemon never sees a click on it.
const isBarLink = (url: string): boolean =>
  url.startsWith(`${URL_SCHEME}://`);

/** The effects a click on `link` fires, `verb arg…` each, `;` between. */
export function describeLink(link: DrawnLink): string {
  if (!isBarLink(link.url)) return `opens ${link.url}`;
  return effectsOf(link.url)
    .map(({ verb, args }) =>
      [verb, ...args.map((a) => (a === SESSION_ID ? "<session>" : a))].join(" "),
    )
    .join(" ; ");
}

export async function startBar(opts: BarOptions): Promise<Bar> {
  const daemonEnv = prepareIsolatedDaemonEnv("ccb-bar");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bar-"));
  const removeDirs = (): void => {
    daemonEnv.removeTmpDirs();
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  const configPath = path.join(scratch, "config.json5");
  const claudeConfigDir = path.join(scratch, "claude");
  let daemon: Awaited<ReturnType<typeof spawnDaemonWithEnv>>;
  try {
    fs.writeFileSync(
      configPath,
      opts.config === null ? "{}\n" : fs.readFileSync(opts.config, "utf8"),
    );
    fs.mkdirSync(claudeConfigDir);
    daemon = await spawnDaemonWithEnv({
      ...daemonEnv.env,
      // The daemon dies with this process, however this process ends.
      [PARENT_PID_ENV]: String(process.pid),
      // No update notice reaches the network: the registry is a closed port.
      CC_CANDYBAR_REGISTRY_URL: "http://127.0.0.1:1",
      // An empty Claude Code config dir, so the daemon wears no host memento.
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      NODE_OPTIONS: withStamp(process.env.NODE_OPTIONS),
    });
  } catch (e) {
    removeDirs();
    throw e;
  }
  const sockPath = daemonEnv.sockPath;
  let last = "";
  let size: TerminalSize = { width: opts.width, rows: opts.rows };

  const render = async (): Promise<string> =>
    (last = await renderRequest(
      sockPath,
      {
        hookData: hookData(opts.cwd, path.join(scratch, "transcript.jsonl")),
        args: ["cc-candybar", "--config", configPath],
        cwd: opts.cwd,
        termCols: size.width,
        termRows: size.rows,
        ssh: opts.ssh,
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
    if (effectsOf(hit.url).some(({ verb }) => MACHINE_VERBS.has(verb))) {
      return { refused: `not sent: ${describeLink(hit)}`, rendered: await render() };
    }
    const resp = await sendClick(sockPath, hit.url, REPLY_BUDGET_MS);
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
    stop: () => {
      daemon.killTree();
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

