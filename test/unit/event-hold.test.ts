// The daemon's one rule for how long an event-shaped error shows
// (src/utils/event-hold.ts): every render inside the hold, and past it a
// request until an answer has carried it; and the one rule for an event that
// follows another.

import { answeredBy, eventHoldAt, joinedEvent } from "../../src/utils/event-hold";
import type { Instant } from "../../src/utils/instant";

const at = (seconds: number): Instant => seconds as Instant;
const HOLD = 10;
const fresh = { text: "e", at: at(100), answered: false };
const answered = { ...fresh, answered: true };

test("every render inside the hold shows the event, answered or not", () => {
  for (const render of ["feed", "request"] as const)
    for (const event of [fresh, answered]) {
      expect(eventHoldAt(event, HOLD, at(100), render)).toBe("held");
      expect(eventHoldAt(event, HOLD, at(109.999), render)).toBe("held");
    }
});

test("past the hold a request is owed an unanswered event, and a feed is not", () => {
  expect(eventHoldAt(fresh, HOLD, at(110), "request")).toBe("owed");
  expect(eventHoldAt(fresh, HOLD, at(10_000), "request")).toBe("owed");
  expect(eventHoldAt(fresh, HOLD, at(110), "feed")).toBe("over");
});

test("past the hold an answered event is over for every render", () => {
  expect(eventHoldAt(answered, HOLD, at(110), "request")).toBe("over");
  expect(eventHoldAt(answered, HOLD, at(110), "feed")).toBe("over");
});

test("an answer marks the latest event it carried, once, and never a newer one", () => {
  expect(answeredBy(fresh, fresh)).toBe(true);
  expect(answeredBy(answered, fresh)).toBe(false);
  expect(answeredBy({ ...fresh, at: at(101) }, fresh)).toBe(false);
  expect(answeredBy({ ...fresh, text: "2× e" }, fresh)).toBe(false);
});

test("an event while the last is still owed joins it; once an answer carried the last, the next starts afresh", () => {
  expect(joinedEvent(null, "run failed", at(200))).toEqual({
    text: "run failed",
    at: at(200),
    answered: false,
  });
  expect(joinedEvent(fresh, "run failed", at(200))).toEqual({
    text: "e\nrun failed",
    at: at(200),
    answered: false,
  });
  expect(joinedEvent(answered, "run failed", at(200))).toEqual({
    text: "run failed",
    at: at(200),
    answered: false,
  });
});
