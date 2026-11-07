// The render/click client — the statusline hot path. The socket round-trip
// and failure classification live in ./client-transport (the single
// implementation shared with the stats/debug CLIs); this module contributes
// only the render path's own data: tight timeout budgets and the
// output-string payload projection. [LAW:dataflow-not-control-flow]
// The render budgets are wire facts, declared in ./protocol.

import type { ClaudeHookData } from "../utils/claude";
import { interpretResponse, requestOutcome } from "./client-transport";
import type {
  ClientWorld,
  RoundTripBudgets,
  RoundTripOutcome,
} from "./client-transport";
import {
  CONNECT_TIMEOUT_MS,
  TOTAL_BUDGET_MS,
  type ClientHints,
  type Response,
} from "./protocol";
import { REQUEST_TIMEOUT_MS } from "./request-deadline";

export const RENDER_BUDGETS: RoundTripBudgets = {
  connectMs: CONNECT_TIMEOUT_MS,
  budgetMs: TOTAL_BUDGET_MS,
};
// [LAW:one-source-of-truth] A click or pane lookup waits past the daemon's
// own backstop, so a slow one hears the daemon's TIMEOUT, a definite answer,
// rather than giving up first on a request the daemon is still running.
const CLICK_BUDGETS: RoundTripBudgets = {
  connectMs: CONNECT_TIMEOUT_MS,
  budgetMs: REQUEST_TIMEOUT_MS + TOTAL_BUDGET_MS,
};

// The render/click outcome vocabulary, mirrored by the Rust client's outcome
// enum. The ok payload is the rendered line (or click acknowledgement) to
// print. See client-transport.ts for the transient/permanent semantics.
export type ClientOutcome = RoundTripOutcome<string>;

// [LAW:no-defensive-null-guards] exception: trust boundary. The ok response
// is an unchecked cast from socket JSON; the typeof check is the explicit
// narrowing at the wire edge, and its failure means "ok response without our
// payload" (classified permanent/malformed_response by the transport).
function projectOutput(
  resp: Extract<Response, { ok: true }>,
): string | undefined {
  const output = (resp as { output?: unknown }).output;
  return typeof output === "string" ? output : undefined;
}

// A render response the daemon pushed (a frame stream), classified as the
// answer to a render request is.
export function renderOutcomeOf(resp: Response): ClientOutcome {
  return interpretResponse("render", resp, projectOutput);
}

// Try to render via the daemon. Returns a typed outcome — see ClientOutcome.
// There is no inline render path; see src/index.ts. The caller is responsible
// for branching on outcome.kind and deciding whether to kick, display an
// error glyph, or print the rendered output.
// [LAW:one-source-of-truth] `hints` carries every fact the daemon cannot
// observe for itself; it is spread onto the request verbatim so this relay
// never becomes a second place that decides what the client saw.
// [LAW:dataflow-not-control-flow] The budgets are a value the caller may state;
// the statusline states none and gets the wire facts. A test whose subject is
// the deadline, not the speed of a loaded runner's loop, states wider ones.
export function tryRenderViaDaemon(
  world: ClientWorld,
  hookData: ClaudeHookData,
  args: string[],
  cwd: string,
  hints: ClientHints,
  budgets: RoundTripBudgets = RENDER_BUDGETS,
): Promise<ClientOutcome> {
  return requestOutcome(
    world,
    (deadline) => ({ kind: "render", hookData, args, cwd, deadline, ...hints }),
    budgets,
    projectOutput,
  );
}

// The session a tmux pane runs (PaneSessionRequest), or null when the daemon
// holds no request that runs in it.
export function trySessionInPane(
  world: ClientWorld,
  socket: string,
  pane: string,
): Promise<RoundTripOutcome<string | null>> {
  return requestOutcome(
    world,
    () => ({ kind: "pane-session", socket, pane }),
    CLICK_BUDGETS,
    (resp) => ("paneSession" in resp ? resp.paneSession : undefined),
  );
}

// [LAW:single-enforcer] Same outcome translator for click as for render —
// click failures decompose into the same transient/permanent split, so the
// caller's "ok? done : kick + fallback" logic gets the same typed input.
export function tryClickViaDaemon(
  world: ClientWorld,
  url: string,
): Promise<ClientOutcome> {
  return requestOutcome(
    world,
    () => ({ kind: "click", url }),
    CLICK_BUDGETS,
    projectOutput,
  );
}
