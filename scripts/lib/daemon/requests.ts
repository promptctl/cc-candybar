// [LAW:one-source-of-truth] A real daemon asked over its wire as its clients
// ask it: a render, retried under the documented transient contract, and a
// click as the URL handler sends it. The tests (test/helpers/daemon-e2e.ts)
// and the dev tools (`pnpm bar`) send through these, so the contract is
// spelled once.

import {
  PROTOCOL_VERSION,
  type ClickRequest,
  type Response,
} from "../../../src/daemon/foundations/protocol";
import type { Environment } from "../../../src/daemon/foundations/session-env";
import { logLines } from "../../../src/daemon/log";
import { parseFrame, type Frame } from "../../../src/render/frame";
import type { ClaudeHookData } from "../../../src/utils/claude";
import { until } from "../until";
import {
  answeredRender,
  drewAwaitedPending,
  owedLandings,
  renderEventsOf,
  retriedRender,
} from "./log";
import { endpointOf, sendDaemonRequest, type DaemonTarget } from "./wire";

// [LAW:types-are-the-program] What a render request carries beyond its
// version, kind and deadline. Like a real client's, it states the environment
// its session was started in: the daemon runs the session's sources and
// programs in it.
export type RenderAsk = Readonly<Record<string, unknown>> & {
  readonly env: Environment;
};

export const REPLY_BUDGET_MS = 5000;

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

// One render request, retried on TIMEOUT and on an answer that drew a
// source pending, within the budgets above. The one spelling of the transient
// contract: `renderOutput` and `renderFrame` below both send through it.
async function renderAnswer(
  target: DaemonTarget,
  request: RenderAsk,
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
export async function renderOutput(
  target: DaemonTarget,
  request: RenderAsk,
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

// The Frame of a render, as a reader of one render's answer asks for it.
export async function renderFrame(
  target: DaemonTarget,
  request: RenderAsk,
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

// A click as `cc-candybar url-handle` sends it: the link as it was clicked.
export function clickBody(url: string) {
  return {
    v: PROTOCOL_VERSION,
    kind: "click",
    url,
  } as const satisfies ClickRequest;
}

// A click sent as the URL handler app sends it, and sent again while the
// daemon answers TIMEOUT, within the reply budget counted from the first ask.
// Each ask gets the whole budget, since one given the remainder can expire
// before the round trip does. The daemon's answer is returned as it came,
// refusal included; a TIMEOUT only once the budget is spent.
//
// [LAW:one-source-of-truth] A TIMEOUT to a click is safe to send again
// (request-deadline.ts), so a click is asked again as a render is, and what
// became of it is the daemon's answer, never a second reading off its log.
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

