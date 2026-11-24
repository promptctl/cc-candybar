// The render/click client — the statusline hot path. The socket round-trip
// and failure classification live in ./client-transport (the single
// implementation shared with the stats/debug CLIs); this module contributes
// only the render path's own data: tight timeout budgets and the
// output-string payload projection. [LAW:dataflow-not-control-flow]
// The render budgets are wire facts, declared in ./protocol.

import type { ClaudeHookData } from "../utils/claude";
import {
  interpretResponse,
  requestOutcome,
  type ClientWorld,
  type RoundTripBudgets,
  type RoundTripOutcome,
} from "./client-transport";
import {
  CONNECT_TIMEOUT_MS,
  TOTAL_BUDGET_MS,
  SESSION_RENDER_KIND,
  ENVIRONMENT_NEEDED,
  UNKNOWN_REQUEST_KIND,
  type ClientHints,
  type OwnerFacts,
  type Response,
} from "./foundations/protocol";
import { REQUEST_TIMEOUT_MS } from "./foundations/request-deadline";
import { environmentKey, plainEnvironment } from "./foundations/session-env";
import { detectClientHints } from "../client-hints";

export const RENDER_BUDGETS: RoundTripBudgets = {
  connectMs: CONNECT_TIMEOUT_MS,
  budgetMs: TOTAL_BUDGET_MS,
};
// [LAW:one-source-of-truth] A click or pane lookup waits past the
// daemon's own backstop, so a request the daemon had not read hears its
// TIMEOUT, a definite answer, rather than giving up first. A click the daemon
// has read is answered with its own outcome however long that takes, so only
// this clock can end that wait, and then its outcome is unknown.
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
// [LAW:dataflow-not-control-flow] The budgets are a value the caller may state;
// the statusline states none and gets the wire facts. A test whose subject is
// the deadline, not the speed of a loaded runner's loop, states wider ones.
export async function tryRenderViaDaemon(
  world: ClientWorld,
  hookData: ClaudeHookData,
  args: string[],
  cwd: string,
  observed: Pick<ClientHints, "termCols" | "termRows" | "client">,
  budgets: RoundTripBudgets = RENDER_BUDGETS,
): Promise<ClientOutcome> {
  // The environment Claude Code gave this client, which the host runs the
  // session's programs in (src/daemon/foundations/session-env.ts).
  const expiresAt = world.clock.now() + budgets.budgetMs;
  const env = plainEnvironment(world.host.env);
  const envKey = environmentKey(env);
  const { termCols, termRows, client } = observed;
  const fields = { hookData, args, cwd, envKey, termCols, termRows, client };
  const needed = Symbol("environment");
  const first = await requestOutcome<string | typeof needed>(
    world,
    (deadline) => ({ kind: SESSION_RENDER_KIND, ...fields, deadline }),
    budgets,
    (resp) =>
      "need" in resp && resp.need === ENVIRONMENT_NEEDED
        ? needed
        : projectOutput(resp),
    expiresAt,
  );
  if (first.kind === "ok") {
    if (first.value !== needed) return { kind: "ok", value: first.value };
  } else if (
    first.kind !== "permanent" ||
    first.cause !== "bad_request" ||
    first.message !== UNKNOWN_REQUEST_KIND
  ) {
    return first;
  }
  // A missing snapshot and an older v3 daemon's refusal are both definite
  // answers before a render. Resending after any other failure could draw twice.
  const legacyHints =
    first.kind === "ok"
      ? undefined
      : detectClientHints({ env, home: world.host.home }, cwd, {
          columns: observed.termCols,
          rows: observed.termRows,
        });
  return requestOutcome(
    world,
    (deadline) => ({
      kind: "render",
      ...fields,
      deadline,
      env,
      ...legacyHints,
    }),
    budgets,
    projectOutput,
    expiresAt,
  );
}

// The session that last rendered from a tmux pane (PaneSessionRequest), or
// null when the daemon holds no request from it.
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

// A bar pane's pointer, restated to the host (PointerRequest): the host takes
// it only from the session's live owner, and says why when it does not.
export function tryPointerViaDaemon(
  world: ClientWorld,
  sessionId: string,
  owner: OwnerFacts,
): Promise<ClientOutcome> {
  return requestOutcome(
    world,
    () => ({ kind: "pointer", sessionId, owner }),
    CLICK_BUDGETS,
    projectOutput,
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
