// The render/click client — the statusline hot path. The socket round-trip
// and failure classification live in ./client-transport (the single
// implementation shared with the stats/debug CLIs); this module contributes
// only the render path's own data: tight timeout budgets and the
// output-string payload projection. [LAW:dataflow-not-control-flow]
//
// [LAW:one-source-of-truth] These budget consts are mirrored by the Rust
// client (rust-client/src/main.rs) and diffed by scripts/check-protocol.mjs,
// which anchors on the declarations below — keep them named consts in this
// file, or repoint the CHECKS rows in the same commit.

import type { ClaudeHookData } from "../utils/claude";
import { requestOutcome } from "./client-transport";
import type { RoundTripBudgets, RoundTripOutcome } from "./client-transport";
import type { ClientHints, Response } from "./protocol";

const CONNECT_TIMEOUT_MS = 50;
const TOTAL_BUDGET_MS = 150;
const CLICK_BUDGET_MS = 200;

const RENDER_BUDGETS: RoundTripBudgets = {
  connectMs: CONNECT_TIMEOUT_MS,
  budgetMs: TOTAL_BUDGET_MS,
};
const CLICK_BUDGETS: RoundTripBudgets = {
  connectMs: CONNECT_TIMEOUT_MS,
  budgetMs: CLICK_BUDGET_MS,
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

// Try to render via the daemon. Returns a typed outcome — see ClientOutcome.
// There is no inline render path; see src/index.ts. The caller is responsible
// for branching on outcome.kind and deciding whether to kick, display an
// error glyph, or print the rendered output.
// [LAW:one-source-of-truth] `hints` carries every fact the daemon cannot
// observe for itself; it is spread onto the request verbatim so this relay
// never becomes a second place that decides what the client saw.
export function tryRenderViaDaemon(
  hookData: ClaudeHookData,
  args: string[],
  cwd: string,
  hints: ClientHints,
): Promise<ClientOutcome> {
  return requestOutcome(
    { kind: "render", hookData, args, cwd, ...hints },
    RENDER_BUDGETS,
    projectOutput,
  );
}

// [LAW:single-enforcer] Same outcome translator for click as for render —
// click failures decompose into the same transient/permanent split, so the
// caller's "ok? done : kick + fallback" logic gets the same typed input.
export function tryClickViaDaemon(
  verb: string,
  value: string,
): Promise<ClientOutcome> {
  return requestOutcome(
    { kind: "click", verb, value },
    CLICK_BUDGETS,
    projectOutput,
  );
}
