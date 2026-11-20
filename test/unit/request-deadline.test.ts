// When a statusline request's wait ends (brandon-unfiled-3248.8ro6, §4c): by
// its client's stated deadline or the connection's backstop, whichever is
// first, less the draw's reserve — and, from a client too old to state one,
// by the earliest an old client gives up at.

import {
  CONNECT_TIMEOUT_MS,
  TOTAL_BUDGET_MS,
} from "../../src/daemon/foundations/protocol";
import {
  DRAW_RESERVE_MS,
  REQUEST_TIMEOUT_MS,
  parseClientDeadline,
  renderDeadlines,
} from "../../src/daemon/foundations/request-deadline";

// A request accepted at 1000 ms on the monotonic clock, beginning 10 ms later,
// at a wall-clock instant of 5_000_000 ms.
const ACCEPTED = 1000;
const ARRIVAL = { epochMs: 5_000_000, monoMs: 1010 };

describe("a request's source wait and reply deadlines", () => {
  test("a stated deadline ends the wait the reserve before it", () => {
    expect(
      renderDeadlines(
        { kind: "stated", at: ARRIVAL.epochMs + 100 },
        ACCEPTED,
        ARRIVAL,
      ),
    ).toEqual({
      waitEndsAt: ARRIVAL.monoMs + 100 - DRAW_RESERVE_MS,
      clientEndsAt: ARRIVAL.monoMs + 100,
    });
  });

  test("a deadline past the backstop waits only until the backstop's reserve", () => {
    expect(
      renderDeadlines(
        { kind: "stated", at: ARRIVAL.epochMs + 60_000 },
        ACCEPTED,
        ARRIVAL,
      ),
    ).toEqual({
      waitEndsAt: ACCEPTED + REQUEST_TIMEOUT_MS - DRAW_RESERVE_MS,
      clientEndsAt: ARRIVAL.monoMs + 60_000,
    });
  });

  test("an old client can take a reply until the backstop even after its estimated wait", () => {
    expect(renderDeadlines({ kind: "unstated" }, ACCEPTED, ARRIVAL)).toEqual({
      waitEndsAt:
        ACCEPTED + TOTAL_BUDGET_MS - CONNECT_TIMEOUT_MS - DRAW_RESERVE_MS,
      clientEndsAt: null,
    });
  });

  test("a deadline already inside the reserve leaves no wait", () => {
    expect(
      renderDeadlines(
        { kind: "stated", at: ARRIVAL.epochMs + 5 },
        ACCEPTED,
        ARRIVAL,
      ).waitEndsAt,
    ).toBeLessThan(ARRIVAL.monoMs);
  });
});

describe("a request's deadline field", () => {
  test("absent is unstated: a client too old to state one", () => {
    expect(parseClientDeadline(undefined)).toEqual({ kind: "unstated" });
  });

  test("epoch milliseconds are stated", () => {
    expect(parseClientDeadline(5_000_150)).toEqual({
      kind: "stated",
      at: 5_000_150,
    });
  });

  test.each([["soon"], [1.5], [0], [-1], [null]])(
    "%p is refused, naming what was sent",
    (raw) => {
      expect(parseClientDeadline(raw)).toEqual({
        kind: "refused",
        problem: `request 'deadline' is not epoch milliseconds: ${JSON.stringify(raw)}`,
      });
    },
  );
});
