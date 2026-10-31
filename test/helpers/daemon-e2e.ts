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

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";

import {
  PROTOCOL_VERSION,
  type ClientHints,
  type Response,
} from "../../src/daemon/protocol";
import type { ClaudeHookData } from "../../src/utils/claude";
import { parseHandlerUrl } from "../../src/install/index";
import { effectsOf, type DecodedEffect } from "./click";
import {
  endpointOf,
  sendDaemonRequest,
  waitForExit,
  type DaemonTarget,
} from "./daemon-wire";
import type { RunningDaemon } from "./spawn-isolated-daemon";
import { linkUrls, stripAnsi } from "./ansi";
import { detectClaudeConfigDir } from "../../src/claude-settings";
import { PACKAGE_VERSION } from "../../src/version";
import { logLines } from "../../src/daemon/log";
import { valueOf } from "../../src/utils/logfmt";
import { until } from "./until";
export { linkUrls, stripAnsi } from "./ansi";

const REPLY_BUDGET_MS = 5000;

// [LAW:no-ambient-temporal-coupling] `TIMEOUT` (request-deadline.ts's REQUEST_TIMEOUT_MS
// — a real 200ms per-request guard protecting the daemon from one slow request
// blocking every other connection) is classified `transient` by the real client
// (client-transport.ts's interpretResponse): the daemon is up, just slow for
// this one request, and the documented recovery is retry, not fail. A cold
// first render for a brand-new (projectDir, cwd) — first git subprocess spawn,
// first config parse + template compile — can genuinely exceed 200ms on a
// loaded CI runner even though it's fast on a warm local machine. A real client
// shows a blank line and lets the next natural render tick retry; a test has no
// "next tick" to lean on, so it retries inline, bounded, matching the
// documented transient contract rather than treating an expected-occasionally
// condition as a hard failure.
const TIMEOUT_RETRY_BUDGET = 5;

// [LAW:no-ambient-temporal-coupling] The same contract for an answer drawn at
// its deadline: a request is answered by its client's deadline, and a source
// still reading then draws as pending (src/daemon/request-deadline.ts) — a
// new repo's first git reads, a config's first compile. A real client shows
// those cells and the next tick shows them answered; a test asks again
// inline, bounded, and reads which answer it got from the request's own
// render event. A case that means to see the pending answer sends a request
// of its own (sendDaemonRequest).
const PENDING_RETRY_BUDGET = 20;

// A session's render events whose reply its client read, in log order.
export function answeredEvents(log: string, sessionId: string): string[] {
  return logLines(log).filter(
    (l) =>
      l.includes(`] render sid=${valueOf(sessionId)} `) &&
      l.includes(" timedOut=N "),
  );
}

// The click events whose client had already been told TIMEOUT, in log order.
function timedOutClicks(log: string): string[] {
  return logLines(log).filter(
    (l) => l.includes("] click ") && l.includes(" timedOut=Y "),
  );
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
// source pending, within the budgets above, its output returned. The one
// spelling of the transient contract: `render` below and
// test/helpers/drive-bar.ts both send through it.
export async function renderRequest(
  target: DaemonTarget,
  request: Record<string, unknown>,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<string> {
  const { log, now } = endpointOf(target);
  const sessionId = String(
    (request.hookData as Partial<ClaudeHookData> | undefined)?.session_id,
  );
  for (let attempt = 1; ; attempt++) {
    const before = answeredEvents(log, sessionId).length;
    // [LAW:one-source-of-truth] The deadline it states is the one it waits
    // to: like a real client, it says when it will hang up, so the daemon's
    // wait for its refreshes ends by that or by its own backstop
    // (src/daemon/request-deadline.ts). A case's own deadline wins.
    const resp = await sendDaemonRequest(
      target,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        deadline: now() + replyBudgetMs,
        ...request,
      },
      replyBudgetMs,
    );
    if (!resp.ok) {
      if (resp.code === "TIMEOUT" && attempt < TIMEOUT_RETRY_BUDGET) continue;
      throw new Error(`render failed: ${resp.error} (${resp.code})`);
    }
    if (!("output" in resp)) {
      throw new Error(
        `render response carried no output: ${JSON.stringify(resp)}`,
      );
    }
    let event = "";
    await until(
      () => (event = answeredEvents(log, sessionId)[before] ?? "") !== "",
      `the render event of ${sessionId}'s answer`,
    );
    if (/ pending=-(?: |$)/.test(event)) return resp.output;
    // A source a run superseded is drawn pending by design: no request waits
    // on it (the run may outlast the deadline), so this answer is the one.
    if (drewOnlySuperseded(event)) return resp.output;
    // [LAW:no-silent-failure] Only a wait its deadline ended may draw
    // pending: one that answered yet drew a value not answered means the wait
    // left out something the request started (rule 1), and asking again would
    // hide it. A value still pending after every ask is the failure too.
    // Both are named by the event that drew them, never a bar a later
    // assertion trips over.
    if (!/ ended=deadline(?: |$)/.test(event))
      throw new Error(`render drew pending though its wait answered: ${event}`);
    if (attempt >= PENDING_RETRY_BUDGET)
      throw new Error(
        `render still drew pending after ${attempt} asks: ${event}`,
      );
  }
}

// Whether every value a render event drew pending is a plugin source a run
// superseded, as its `sourcesPending=` names them.
function drewOnlySuperseded(event: string): boolean {
  const field = (name: string): string[] =>
    (new RegExp(` ${name}=(\\S+)`).exec(event)?.[1] ?? "-")
      .split(",")
      .filter((v) => v !== "-");
  const superseded = new Set(
    field("sourcesPending")
      .filter((v) => v.endsWith(":superseded"))
      .map((v) => v.slice(0, -":superseded".length)),
  );
  const pending = field("pending");
  return pending.length > 0 && pending.every((name) => superseded.has(name));
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
    // What the real client always reports from its env: test/setup.ts
    // points CLAUDE_CONFIG_DIR at an empty dir, so no test daemon reads the
    // host's Claude Code settings. A case's own hints win.
    claudeConfigDir: detectClaudeConfigDir(process.env, cwd),
    ...hints,
  };
}

// One status-line render, as Claude Code would ask for it.
export function render(
  target: DaemonTarget,
  sessionId: string,
  cwd: string,
  hints: ClientHints = {},
  args: string[] = [],
): Promise<string> {
  return renderRequest(target, renderBody(sessionId, cwd, hints, args));
}

// A click, decoded the same way `cc-candybar url-handle` decodes it, then sent
// as the wire request the URL handler app sends. The daemon's answer is
// returned as it came, refusal included.
export function sendClick(
  target: DaemonTarget,
  url: string,
  replyBudgetMs = REPLY_BUDGET_MS,
): Promise<Response> {
  const { verb, value } = parseHandlerUrl(url);
  return sendDaemonRequest(
    target,
    {
      v: PROTOCOL_VERSION,
      kind: "click",
      verb,
      value,
      clientVersion: PACKAGE_VERSION,
    },
    replyBudgetMs,
  );
}

// `sendClick`, for a test whose click must land.
//
// [LAW:no-ambient-temporal-coupling] A TIMEOUT is not the click's outcome. The
// daemon's 200 ms guard abandons a request's reply, never its work, so a click
// answered TIMEOUT still runs and its effect still lands (reply.ts records it
// as `timedOut=Y`). A render may be asked again on TIMEOUT because it is a
// read; a click is a write, so sending it again applies it twice, and a second
// apply-update is refused as already running. On TIMEOUT the click's outcome
// is read from the daemon's own click event instead.
export async function click(target: DaemonTarget, url: string): Promise<void> {
  const { log } = endpointOf(target);
  const before = timedOutClicks(log).length;
  const resp = await sendClick(target, url);
  if (resp.ok) return;
  if (resp.code !== "TIMEOUT") {
    throw new Error(`click failed: ${resp.error} (${resp.code})`);
  }
  let event = "";
  // The event is the click's answer by another road, so it has the budget
  // the click's reply had.
  await until(
    () => (event = timedOutClicks(log)[before] ?? "") !== "",
    `the click event of a click answered TIMEOUT (${url})`,
    REPLY_BUDGET_MS,
  );
  if (!/ outcome=ok(?: |$)/.test(event)) {
    throw new Error(`click failed once it ran past its TIMEOUT: ${event}`);
  }
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
  accepts: (rendered: string) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<string> {
  let last = "";
  await until(
    async () => accepts((last = await render(target, sessionId, projectDir))),
    () =>
      last
        ? `a render of ${what}; last render was:\n${last}`
        : `a render of ${what}; no render answered within the budget`,
    timeoutMs,
  );
  return last;
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
      { ...options, encoding: "utf8", timeout: 10_000 },
    );
    if (run.status !== 0 || stripAnsi(run.stdout).trim() !== "") break;
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
// find it: by what it does, from the rendered bytes — never constructed.
export function urlWriting(
  rendered: string,
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

// Stop the daemon and wait for it to be gone.
//
// The default is SIGKILL, which is right for teardown — a test that is done
// does not care how the daemon dies, and SIGKILL cannot hang. It is the WRONG
// signal for a test that restarts the daemon and expects durable state to come
// back: SIGKILL bypasses server.ts's `shutdown()` funnel, and with it the
// session state close that lands writes still inside FileSessionStorage's
// 500ms debounce. Pass "SIGTERM" to exercise the graceful path a real restart
// takes (a signal, the RSS backstop, or the parent watchdog — all three go
// through that one funnel).
export async function killAndWait(
  daemon: RunningDaemon,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<void> {
  const exited = waitForExit(daemon.child);
  daemon.killTree(signal);
  await exited;
}
