// The session's usage as the renderer composes it: the hook's reported cost
// over the transcript's priced totals (`usageOver`).

import { usageOver } from "../src/segments/session";
import type { ClaudeHookData } from "../src/utils/claude";
import { failed, ok, pendingOf } from "../src/utils/outcome";

const FOLD = { calculatedCost: 0.03, tokens: 30, tokenBreakdown: null };

const hook = (cost?: ClaudeHookData["cost"]) =>
  ({ session_id: "s", cost }) as ClaudeHookData;

describe("usageOver", () => {
  it("answers the hook's total_cost_usd over the priced transcript total", () => {
    const cost = {
      total_cost_usd: 0.99,
      total_duration_ms: 0,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    };
    expect(usageOver(ok(FOLD), hook(cost))).toEqual(
      ok({ cost: 0.99, tokens: 30 }),
    );
  });

  it("answers the priced transcript total when the hook omits cost", () => {
    expect(usageOver(ok(FOLD), hook())).toEqual(ok({ cost: 0.03, tokens: 30 }));
  });

  it("answers an empty session's nulls, which the payload drops", () => {
    const empty = { calculatedCost: null, tokens: null, tokenBreakdown: null };
    expect(usageOver(ok(empty), hook())).toEqual(
      ok({ cost: null, tokens: null }),
    );
  });

  // The hook carries the cost alone, so a composed answer over a fold not
  // read would claim the session has no tokens.
  it("carries a fold not answered or failed as it stands", () => {
    expect(usageOver(pendingOf("unread"), hook())).toEqual(pendingOf("unread"));
    const failure = failed("unreadable", "read");
    expect(usageOver(failure, hook())).toBe(failure);
  });
});
