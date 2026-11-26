// [LAW:one-source-of-truth] The scaffolding every real-daemon end-to-end test
// needs: drive a render over the socket, find an affordance in the rendered
// bytes by WHAT IT DOES, dispatch it through the real click wire, and stop the
// daemon. Each e2e file used to carry its own copy, which meant the documented
// transient-retry contract below was restated once per file and could drift
// from the daemon's actual timeout behaviour in any one of them.
//
// [LAW:behavior-not-structure] `urlWriting` deliberately searches for the
// affordance by the effect it carries rather than by position, glyph, or
// constructed URL — so a test keeps passing when the bar is restyled and fails
// when the click stops doing what it claimed.

import { linkUrls } from "./frame";
import { linksOf } from "../../src/click/read";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { decodeAnsi, Style } from "@promptctl/rich-js";
import {
  openFrameStream,
  type StreamEnd,
} from "../../src/daemon/client-frames";

import type { ClientHints, Response } from "../../src/daemon/foundations/protocol";
import { textOf, type Frame } from "../../src/render/frame";
import type { ClaudeHookData } from "../../src/utils/claude";
import { linkKeyFile, linkKeyFromFile } from "../../src/daemon/link-key";
import {
  linkSignerOver,
  unprovenLink,
  type FrameSource,
} from "../../src/click/link-signer";
import { effectsOf, landsAt, type DecodedEffect } from "./click";
import { parseAndValidate } from "../../scripts/lib/draw-fixtures/parse-and-validate";
import { listResolvablePaletteNames } from "../../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import type { DslConfig } from "../../src/config/dsl-types";
import {
  endpointOf,
  REPLY_BUDGET_MS,
  type DaemonTarget,
} from "../../scripts/lib/daemon/wire";
import {
  renderFrame,
  renderOutput,
  saidOf,
  sendClick,
  type RenderAsk,
  type SessionRenderAsk,
} from "../../scripts/lib/daemon/requests";
import { statusHook } from "../../scripts/lib/hook-data";
import { detectClaudeConfigDir } from "../../src/claude-settings";
import { until } from "../../scripts/lib/until";
import { TEST_ENV } from "./session-environment";

// The argv a client sends: binary path first, as parseRenderArgs expects.
export const configFlag = (p: string): string[] => [
  "cc-candybar",
  "--config",
  p,
];

// The Status hook payload Claude Code sends (scripts/lib/hook-data.ts), for
// session `sessionId` in `cwd`, as `render` below relays it and as the real
// client reads it from stdin.
export const hookData = (sessionId: string, cwd: string): ClaudeHookData =>
  statusHook(sessionId, cwd, path.join(cwd, "transcript.jsonl"));

// A request as the suite's clients send it: they report the environment
// test/setup.ts made for the worker, unless a case states its own, and the
// Claude directory that environment names, as the real client always does.
// A request that names none has the daemon read the account's own, the
// host's real one. A case's own report wins.
// A relay's request names the environment by key, so it carries none.
type SuiteAsk =
  | (Omit<RenderAsk, "env"> & Partial<Pick<RenderAsk, "env">>)
  | SessionRenderAsk;
const asked = (request: SuiteAsk): RenderAsk | SessionRenderAsk => {
  if (request.kind === "render-session") return request;
  const env = request.env ?? TEST_ENV;
  return {
    claudeConfigDir: detectClaudeConfigDir(env, request.cwd),
    ...request,
    env,
  };
};

// The bytes of a render, as Claude Code's client reads them.
export const renderRequest = (
  target: DaemonTarget,
  request: SuiteAsk,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<string> => renderOutput(target, asked(request), replyBudgetMs);

// The Frame of a render, as a reader of one render's answer asks for it.
export const frameRequest = (
  target: DaemonTarget,
  request: SuiteAsk,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<Frame> => renderFrame(target, asked(request), replyBudgetMs);

export const urlsOfAnsi = (output: string): string[] =>
  decodeAnsi(output).spans.flatMap(({ style }) =>
    style instanceof Style && style.link !== undefined ? [style.link] : [],
  );

export function observePane(sockPath: string, session: string) {
  const frames: Response[] = [];
  let ended: StreamEnd | null = null;
  const stream = openFrameStream(
    sockPath,
    session,
    "pane",
    (frame) => frames.push(frame),
    (end) => {
      ended = end;
    },
  );
  const waitFor = async (
    matches: (text: string) => boolean,
    wanted: string,
  ): Promise<string> => {
    const output = () =>
      frames
        .flatMap((frame) =>
          frame.ok && "output" in frame ? [frame.output] : [],
        )
        .find((ansi) => matches(decodeAnsi(ansi).plain));
    const seen = () =>
      `${wanted} (last pane message: ${JSON.stringify(ended ?? frames.at(-1))})`;
    await until(() => output() !== undefined || ended !== null, seen);
    const match = output();
    if (match === undefined) throw new Error(seen());
    return match;
  };
  return { waitFor, close: stream.close };
}

// The body of a status-line render request, as Claude Code's client sends it.
// `hints` are the client-observed facts (termCols/termRows/ssh/tmux) spread
// onto the request the way the real client spreads them; `args` is the
// client's argv (binary path first, as parseRenderArgs expects), empty for a
// bare render.
export function renderBody(
  sessionId: string,
  cwd: string,
  hints: ClientHints = {},
  args: string[] = [],
): RenderAsk {
  return {
    hookData: hookData(sessionId, cwd),
    args,
    cwd,
    // What the real client always reports from the env it reports: its
    // Claude directory is an empty one, so no test daemon reads the host's
    // Claude Code settings. A case's own hints win.
    claudeConfigDir: detectClaudeConfigDir(TEST_ENV, cwd),
    env: TEST_ENV,
    ...hints,
  };
}

// One status-line render's Frame, as a reader of its answer asks for it.
export function render(
  target: DaemonTarget,
  sessionId: string,
  cwd: string,
  hints: ClientHints = {},
  args: string[] = [],
): Promise<Frame> {
  return frameRequest(target, renderBody(sessionId, cwd, hints, args));
}

// [LAW:single-enforcer] A link as `target`'s bar would draw it: signed with
// that daemon's key, which lives in the state directory beside its log. For a
// test that builds the link a draw makes, or edits one a draw made, rather
// than clicking one read off a frame as it was drawn.
export function drawnLink(
  target: DaemonTarget,
  link: string,
  source?: FrameSource,
): string {
  return linkSignerOver(
    linkKeyFromFile(linkKeyFile(path.dirname(endpointOf(target).log))),
  ).signLink(unprovenLink(link), source);
}

// The url of the link a frame drew over `text`.
export const linkTo = (frame: Frame, text: string): string => {
  const hit = linksOf(frame).find((l) => l.text === text);
  if (hit === undefined)
    throw new Error(`no link "${text}" in:\n${textOf(frame)}`);
  return hit.url;
};

// `sendClick`, for a test whose click must land.
export async function click(
  target: DaemonTarget,
  url: string,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<void> {
  const resp = await sendClick(target, url, replyBudgetMs);
  if (!resp.ok) throw new Error(`click failed: ${saidOf(resp)}`);
}

// The reply code a refused click's outcome reaches its client as: the test's
// own statement of the wire, kept apart from the daemon's mapping so the two
// check each other.
const REPLY_CODE = {
  "bad-request": "BAD_REQUEST",
  threw: "RENDER_FAILED",
} as const;

// `sendClick`, for a test whose click the daemon must refuse: a forged link
// is a bad request, and a click whose verb fails threw.
export async function refusedClick(
  target: DaemonTarget,
  url: string,
  outcome: keyof typeof REPLY_CODE,
): Promise<void> {
  const resp = await sendClick(target, url);
  expect(resp.ok ? "ok" : resp.code).toBe(REPLY_CODE[outcome]);
}

// [LAW:no-ambient-temporal-coupling] Render until the daemon's own state
// catches up, or fail loudly at the deadline. A durable (`persist`) write
// lands in a file that RenderCache reloads through an fs WATCHER, so the
// reload is genuinely asynchronous with respect to the click's response —
// there is no happens-after signal to await (brandon-testing-82q tracks
// publishing one). Asserting on a single post-click render therefore encodes
// a bet on watcher latency; re-rendering until the expected state appears
// encodes the actual contract ("the write becomes visible"), and the budget
// makes a broken write fail with the last render in hand rather than hanging.
export async function renderUntil(
  target: DaemonTarget,
  sessionId: string,
  projectDir: string,
  accepts: (rendered: Frame) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<Frame> {
  let last: Frame | undefined;
  await until(
    async () => accepts((last = await render(target, sessionId, projectDir))),
    () =>
      last === undefined
        ? `a render of ${what}; no render answered within the budget`
        : `a render of ${what}; last render was:\n${textOf(last)}`,
    timeoutMs,
  );
  return last!;
}

// [LAW:no-ambient-temporal-coupling] The real client answers within its own
// wall-clock budgets (a 50 ms connect, a 150 ms round trip), and a client
// starved by a loaded machine spends them before it has run. Its contract for
// that is a blank line and a respawn kick, with the answer left to Claude
// Code's next tick; a test has no next tick, so this is it: run the client
// again until it draws something. A client that never draws fails at the
// last run's output rather than passing on a blank.
export function runRealClient(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string },
  attempts = 5,
): SpawnSyncReturns<string> {
  let run!: SpawnSyncReturns<string>;
  for (let i = 0; i < attempts; i++) {
    run = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "dist", "index.mjs"), ...args],
      {
        ...options,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    if (run.status !== 0 || run.stdout.trim() !== "") break;
    // [LAW:no-silent-failure] A retry that absorbs a blank is named, so a
    // client that needs several runs every time (a real latency regression)
    // shows in the log instead of passing unseen.
    console.warn(`runRealClient: blank answer on run ${i + 1}/${attempts}`);
  }
  return run;
}

// [LAW:single-enforcer] THE search over rendered affordances: decode each
// URL's effects and keep the first the predicate accepts. Every caller asks
// "which link DOES this?" — by verb, key and value, the facts the daemon acts
// on — rather than by the link's text or its position in the bar, so a
// re-glyphed or re-ordered control does not move the test. A URL that fails to
// decode is not a candidate (a rendered link this codec cannot read is not an
// affordance the daemon would honor either).
export function findUrl(
  urls: readonly string[],
  match: (effects: DecodedEffect[]) => boolean,
): string | undefined {
  return urls.find((u) => {
    try {
      return match(effectsOf(u));
    } catch {
      return false;
    }
  });
}

// The bar a daemon draws for a config no test wrote: the bundled default.
// [LAW:one-source-of-truth] A cycle's link names its action and its step, so
// "which link lands this value" is answered against the config the daemon
// loaded; a test that ran a config of its own hands it in.
export const BUNDLED = parseAndValidate(
  "<bundled>",
  "{}",
  new Set(listResolvablePaletteNames()),
  DEFAULT_DSL_CONFIG,
);

// The affordance that lands `value` at `key`, as the user's own click would
// find it: by what it does, from the drawn frame — never constructed. A link
// that writes the pair, or steps a cycle over `key` that has `value` as a
// member, is one.
export function urlWriting(
  rendered: Frame,
  key: string,
  value: string,
  config: DslConfig = BUNDLED,
): string {
  const url = findUrl(linkUrls(rendered), (effects) =>
    effects.some((e) => landsAt(config, e, key, value)),
  );
  if (url === undefined) {
    throw new Error(`no rendered affordance writes ${key}=${value}`);
  }
  return url;
}
