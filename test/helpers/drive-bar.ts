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
// which shows it in the red strip exactly as a user would see it. A click whose
// verb reaches the outside world (a slash command typed into a Claude Code
// pane, an update) is refused here as it would be for a session with no pane.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cellLen } from "@promptctl/rich-js";

import { PROTOCOL_VERSION, type Response } from "../../src/daemon/protocol";
import { PARENT_PID_ENV } from "../../src/daemon/parent-watchdog";
import { parseHandlerUrl } from "../../src/install/index";
import { URL_SCHEME } from "../../src/click/wire";
import type { ClaudeHookData } from "../../src/utils/claude";
import { withStamp } from "../../scripts/version-stamp.cjs";
import { sendDaemonRequest } from "./daemon-wire";
import { prepareIsolatedDaemonEnv, spawnDaemonWithEnv } from "./spawn-isolated-daemon";
import { links, stripAnsi } from "./ansi";
import { effectsOf } from "./click";

const SESSION_ID = "bar0a1b2-c3d4-4e5f-8a7b-8c9d0e1f2a3b";
const REPLY_BUDGET_MS = 10_000;
// A render over the daemon's per-request budget answers TIMEOUT, which the
// real client treats as transient: it prints nothing and the next statusline
// tick asks again. A cold first render (a git spawn, a config compile) can
// take that long on a loaded machine, so the harness asks again too, a bounded
// number of times, exactly as test/helpers/daemon-e2e.ts's render does.
const TIMEOUT_RETRY_BUDGET = 5;

export interface BarOptions {
  /** Terminal columns the client reports. */
  readonly width: number;
  /** Terminal rows the client reports (caps the diagnostic strip). */
  readonly rows: number;
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

/** What a click did: the render after it, and the daemon's refusal if it refused. */
export interface Clicked {
  readonly rendered: string;
  readonly refused: string | null;
}

export interface Bar {
  /** The config file the daemon reads and every durable click writes. */
  readonly configPath: string;
  render(): Promise<string>;
  /**
   * Click the `nth` (from 1) link of the last render whose visible text is
   * `text`, then render again.
   */
  click(text: string, nth?: number): Promise<Clicked>;
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
  const configPath = path.join(scratch, "config.json5");
  fs.writeFileSync(
    configPath,
    opts.config === null ? "{}\n" : fs.readFileSync(opts.config, "utf8"),
  );
  const claudeConfigDir = path.join(scratch, "claude");
  fs.mkdirSync(claudeConfigDir);
  const env: NodeJS.ProcessEnv = {
    ...daemonEnv.env,
    // The daemon dies with this process, however this process ends.
    [PARENT_PID_ENV]: String(process.pid),
    // No update notice reaches the network: the registry is a closed port.
    CC_CANDYBAR_REGISTRY_URL: "http://127.0.0.1:1",
    // An empty Claude Code config dir, so the daemon wears no host memento.
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    NODE_OPTIONS: withStamp(process.env.NODE_OPTIONS),
  };
  const daemon = await spawnDaemonWithEnv(env);
  const sockPath = daemonEnv.sockPath;
  let last = "";

  const send = (req: Record<string, unknown>): Promise<Response> =>
    sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, ...req }, REPLY_BUDGET_MS);

  const render = async (): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      const resp = await send({
        kind: "render",
        hookData: hookData(opts.cwd, path.join(scratch, "transcript.jsonl")),
        args: ["cc-candybar", "--config", configPath],
        cwd: opts.cwd,
        termCols: opts.width,
        termRows: opts.rows,
        ssh: opts.ssh,
        claudeConfigDir,
      });
      if (resp.ok && "output" in resp) return (last = resp.output);
      if (!resp.ok && resp.code === "TIMEOUT" && attempt < TIMEOUT_RETRY_BUDGET) continue;
      throw new Error(`render refused: ${JSON.stringify(resp)}`);
    }
  };

  const click = async (text: string, nth = 1): Promise<Clicked> => {
    const drawn = drawnLinks(last);
    const hit = drawn.filter((l) => l.text === text)[nth - 1];
    if (hit === undefined) {
      throw new Error(
        `the bar drew no link "${text}" #${nth}; it drew: ` +
          drawn.map((l) => JSON.stringify(l.text)).join(" "),
      );
    }
    if (!isBarLink(hit.url)) {
      throw new Error(`"${text}" opens ${hit.url}: the terminal's click, not the daemon's`);
    }
    const { verb, value } = parseHandlerUrl(hit.url);
    const resp = await send({ kind: "click", verb, value });
    return {
      refused: resp.ok ? null : `${resp.error} (${resp.code})`,
      rendered: await render(),
    };
  };

  return {
    configPath,
    render,
    click,
    stop: () => {
      daemon.killTree();
      daemonEnv.removeTmpDirs();
      fs.rmSync(scratch, { recursive: true, force: true });
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

