// [LAW:one-source-of-truth] The budget consts below are mirrored by the Rust
// client and anchored on by scripts/check-protocol.mjs — keep them named consts
// here, or repoint the CHECKS rows in the same commit.

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

// Mirrored by the Rust client's outcome enum.
export type ClientOutcome = RoundTripOutcome<string>;

// [LAW:no-defensive-null-guards] exception: trust boundary — the ok response is
// an unchecked cast from socket JSON, narrowed here at the wire edge.
function projectOutput(
  resp: Extract<Response, { ok: true }>,
): string | undefined {
  const output = (resp as { output?: unknown }).output;
  return typeof output === "string" ? output : undefined;
}

// [LAW:one-source-of-truth] `hints` carries every fact the daemon cannot observe
// for itself, spread verbatim so this relay never decides what the client saw.
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

// [LAW:single-enforcer] Same outcome translator for click as for render.
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
