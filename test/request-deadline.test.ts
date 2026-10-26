// When a statusline request's wait ends (brandon-unfiled-3248.8ro6, §4c): by
// its client's stated deadline or the connection's backstop, whichever is
// first, less the draw's reserve — and, from a client too old to state one,
// by the budget the Node client gives up at.

import { CONNECT_TIMEOUT_MS, TOTAL_BUDGET_MS } from "../src/daemon/client";
import {
  DRAW_RESERVE_MS,
  REQUEST_TIMEOUT_MS,
  waitBudgetMs,
} from "../src/daemon/request-deadline";

// A request accepted at 1000 ms on the monotonic clock, beginning 10 ms later,
// at a wall-clock instant of 5_000_000 ms.
const ACCEPTED = 1000;
const ARRIVAL = { epochMs: 5_000_000, monoMs: 1010 };

describe("a request's wait budget", () => {
  test("a stated deadline ends the wait the reserve before it", () => {
    expect(
      waitBudgetMs(
        { kind: "stated", at: ARRIVAL.epochMs + 100 },
        ACCEPTED,
        ARRIVAL,
      ),
    ).toBe(100 - DRAW_RESERVE_MS);
  });

  test("a deadline past the backstop waits only until the backstop's reserve", () => {
    expect(
      waitBudgetMs(
        { kind: "stated", at: ARRIVAL.epochMs + 60_000 },
        ACCEPTED,
        ARRIVAL,
      ),
    ).toBe(ACCEPTED + REQUEST_TIMEOUT_MS - DRAW_RESERVE_MS - ARRIVAL.monoMs);
  });

  test("an unstated deadline is the Node client's budget after a connect that took all its time", () => {
    expect(waitBudgetMs({ kind: "unstated" }, ACCEPTED, ARRIVAL)).toBe(
      ACCEPTED +
        TOTAL_BUDGET_MS -
        CONNECT_TIMEOUT_MS -
        DRAW_RESERVE_MS -
        ARRIVAL.monoMs,
    );
  });

  test("a deadline already inside the reserve leaves no wait", () => {
    expect(
      waitBudgetMs(
        { kind: "stated", at: ARRIVAL.epochMs + 5 },
        ACCEPTED,
        ARRIVAL,
      ),
    ).toBeLessThan(0);
  });
});
