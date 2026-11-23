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

import {
  PROTOCOL_VERSION,
  type ClickRequest,
  type ClientHints,
  type Response,
} from "../../src/daemon/foundations/protocol";
import { textOf, parseFrame, type Frame } from "../../src/render/frame";
import type { ClaudeHookData } from "../../src/utils/claude";
import { linkKeyFile, linkKeyFromFile } from "../../src/daemon/link-key";
import {
  linkSignerOver,
  unprovenLink,
  type FrameSource,
} from "../../src/click/link-signer";
import { effectsOf, type DecodedEffect } from "./click";
import {
  endpointOf,
  sendDaemonRequest,
  type DaemonTarget,
} from "./daemon-wire";
import { detectClaudeConfigDir } from "../../src/claude-settings";
import { logLines } from "../../src/daemon/log";
import {
  answeredRender,
  drewAwaitedPending,
  owedLandings,
  renderEventsOf,
  retriedRender,
} from "./daemon-log";
import { until } from "./until";
import { TEST_ENV } from "./session-environment";

// The argv a client sends: binary path first, as parseRenderArgs expects.
export const configFlag = (p: string): string[] => [
  "cc-candybar",
  "--config",
  p,
];

const REPLY_BUDGET_MS = 5000;

// [LAW:no-ambient-temporal-coupling] `TIMEOUT` (request-deadline.ts's REQUEST_TIMEOUT_MS
// — a real 200ms per-request guard protecting the daemon from one slow request
// blocking every other connection) is classified `busy` by the real client
// (client-transport.ts's interpretResponse): the daemon is up, just slow for
// this one request, and the documented recovery is retry, not fail. A cold
// first render for a brand-new (projectDir, cwd) — first git subprocess spawn,
// first config parse + template compile — can genuinely exceed 200ms on a
// loaded CI runner even though it's fast on a warm local machine. A real client
// shows a blank line and lets the next natural render tick retry; a test has no
// "next tick" to lean on, so it asks again inline until the request's reply
// budget runs out, measured from its first ask. Each ask waits on the daemon's
// own answer, so the budget is a backstop for a daemon that never answers,
// not a guess at how long a cold one takes: a count of asks was one, and a
// first render queued behind a cold config load on a loaded runner outlasted
// five 200ms guards.

// [LAW:no-ambient-temporal-coupling] The same contract for an answer drawn at
// its deadline: a request is answered by its client's deadline, and a source
// still reading then draws as pending (src/daemon/foundations/request-deadline.ts) — a
// new repo's first git reads, a config's first compile. A real client shows
// those cells and the next tick shows them answered; a test asks again
// inline, bounded, and reads which answer it got from the request's own
// render event. A case that means to see the pending answer sends a request
// of its own (sendDaemonRequest).
const PENDING_RETRY_BUDGET = 20;

// [LAW:single-enforcer] The one rule for when a TIMEOUT is asked again: while
// the budget, counted from the first ask, has time left.
const askAgain = (
  resp: Response,
  firstAskMs: number,
  budgetMs: number,
): boolean =>
  !resp.ok && resp.code === "TIMEOUT" && Date.now() - firstAskMs < budgetMs;

// A session's render events whose reply its client read, in log order.
export function answeredEvents(log: string, sessionId: string): string[] {
  return renderEventsOf(logLines(log), sessionId).filter(answeredRender);
}

// The Status hook payload Claude Code sends, as `render` below relays it and
// as the real client reads it from stdin.
export function hookData(sessionId: string, cwd: string): ClaudeHookData {
  return {
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: path.join(cwd, "transcript.jsonl"),
    cwd,
    model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
  };
}

// One render request, retried on TIMEOUT and on an answer that drew a
// source pending, within the budgets above. The one spelling of the transient
// contract: `renderRequest` and `frameRequest` below both send through it.
async function renderAnswer(
  target: DaemonTarget,
  request: Record<string, unknown>,
  replyBudgetMs: number,
): Promise<Extract<Response, { ok: true }>> {
  const { log, now } = endpointOf(target);
  const sessionId = String(
    (request.hookData as Partial<ClaudeHookData> | undefined)?.session_id,
  );
  const asked = logLines(log).length;
  const firstAskMs = Date.now();
  for (let attempt = 1; ; attempt++) {
    const before = answeredEvents(log, sessionId).length;
    const linesBefore = logLines(log).length;
    // [LAW:one-source-of-truth] The deadline it states is the one it waits
    // to: like a real client, it says when it will hang up, so the daemon's
    // wait for its refreshes ends by that or by its own backstop
    // (src/daemon/foundations/request-deadline.ts). A case's own deadline wins.
    const resp = await sendDaemonRequest(
      target,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        deadline: now() + replyBudgetMs,
        // Like a real client, it reports the environment it was started in.
        env: TEST_ENV,
        ...request,
      },
      replyBudgetMs,
    );
    if (!resp.ok) {
      if (askAgain(resp, firstAskMs, replyBudgetMs)) continue;
      // [LAW:nothing-unseen] What the daemon logged across every attempt,
      // so a runner that failed says where its turns' time went.
      throw new Error(
        `render failed: ${resp.error} (${resp.code})\n${logLines(log).slice(asked).join("\n")}`,
      );
    }
    let event = "";
    await until(
      () => (event = answeredEvents(log, sessionId)[before] ?? "") !== "",
      `the render event of ${sessionId}'s answer`,
    );
    if (!drewAwaitedPending(event)) return resp;
    // [LAW:no-silent-failure] Only a wait its deadline ended may leave a
    // source owed: a request that ended any other way with one owed (a stamp
    // that failed, a world state the renderer did not take) is a failure
    // asking again would hide. A value still pending after every ask is the
    // failure too. Both are named by the event that drew them, never a bar a
    // later assertion trips over.
    if (!retriedRender(event))
      throw new Error(
        `render ended owing a source before its deadline: ${event}`,
      );
    if (attempt >= PENDING_RETRY_BUDGET)
      throw new Error(
        `render still drew pending after ${attempt} asks: ${event}`,
      );
    // [LAW:no-ambient-temporal-coupling] A value no request waits for is asked
    // again once its owner logs the refresh that lands it, never after a guessed
    // delay. The landing is logged after this ask began, since a value landed
    // before it would have been drawn.
    const owed = owedLandings(event);
    if (owed.length > 0)
      await until(
        () =>
          logLines(log)
            .slice(linesBefore)
            .some((line) => owed.some((o) => line.includes(o))),
        `${owed.join(" or ")} after ${sessionId}'s answer`,
      );
  }
}

// The bytes of a render, as Claude Code's client reads them.
export async function renderRequest(
  target: DaemonTarget,
  request: Record<string, unknown>,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<string> {
  const resp = await renderAnswer(target, request, replyBudgetMs);
  if (!("output" in resp)) {
    throw new Error(
      `render response carried no output: ${JSON.stringify(resp)}`,
    );
  }
  return resp.output;
}

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

// The Frame of a render, as a reader of one render's answer asks for it.
export async function frameRequest(
  target: DaemonTarget,
  request: Record<string, unknown>,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<Frame> {
  const resp = await renderAnswer(
    target,
    { ...request, encoding: "frame" },
    replyBudgetMs,
  );
  if (!("frame" in resp)) {
    throw new Error(
      `render response carried no frame: ${JSON.stringify(resp)}`,
    );
  }
  return parseFrame(resp.frame);
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
): Record<string, unknown> {
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

// A click as `cc-candybar url-handle` sends it: the link as it was clicked.
export function clickBody(url: string) {
  return {
    v: PROTOCOL_VERSION,
    kind: "click",
    url,
  } as const satisfies ClickRequest;
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

// A click sent as the URL handler app sends it, and sent again while the
// daemon answers TIMEOUT, within the reply budget counted from the first ask.
// Each ask gets the whole budget, since one given the remainder can expire
// before the round trip does. The daemon's answer is returned as it came,
// refusal included; a TIMEOUT only once the budget is spent.
//
// [LAW:no-ambient-temporal-coupling] A TIMEOUT to a click is safe to send
// again (connection.ts), so a click is asked again as a render is, and its
// answer is never read off the daemon's log.
export async function sendClick(
  target: DaemonTarget,
  url: string,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<Response> {
  const firstAskMs = Date.now();
  for (;;) {
    const resp = await sendDaemonRequest(target, clickBody(url), replyBudgetMs);
    if (!askAgain(resp, firstAskMs, replyBudgetMs)) return resp;
  }
}

// What the daemon said of the click, in full.
export const saidOf = (resp: Response): string =>
  resp.ok ? "ok" : `${resp.error} (${resp.code})`;

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

// The affordance that writes `value` to `key`, as the user's own click would
// find it: by what it does, from the drawn frame — never constructed.
export function urlWriting(
  rendered: Frame,
  key: string,
  value: string,
): string {
  const url = findUrl(linkUrls(rendered), (effects) =>
    effects.some((e) => e.args[1] === key && e.args[2] === value),
  );
  if (url === undefined) {
    throw new Error(`no rendered affordance writes ${key}=${value}`);
  }
  return url;
}
