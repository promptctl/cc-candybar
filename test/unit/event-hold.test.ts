// The daemon's one rule for how long an event-shaped error shows
// (src/utils/event-hold.ts): every render inside the hold, and past it a
// request until an answer has carried it; and the one rule for an event that
// follows another.

import {
  answeredBy,
  eventHoldAt,
  joinedEvent,
} from "../../src/utils/event-hold";
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
    revision: 1,
    answered: false,
  });
  expect(joinedEvent(fresh, "run failed", at(200))).toEqual({
    text: "e\nrun failed",
    at: at(200),
    revision: 1,
    answered: false,
  });
  expect(joinedEvent(answered, "run failed", at(200))).toEqual({
    text: "run failed",
    at: at(200),
    revision: 1,
    answered: false,
  });
});

test("a failure said again while still owed is held once, and an earlier owed failure stays", () => {
  let last = joinedEvent(null, "launch failed", at(200));
  for (let i = 1; i <= 40; ++i)
    last = joinedEvent(last, `discovery failed ${"z".repeat(100)}`, at(200 + i));
  expect(last.text).toBe(`launch failed\ndiscovery failed ${"z".repeat(100)}`);
  expect(last).toMatchObject({ at: at(240), revision: 41, answered: false });
});

test("only the most recent unanswered diagnostics are kept once the text budget fills", () => {
  let last = joinedEvent(null, `early ${"x".repeat(400)} tail`, at(200));
  for (let i = 1; i <= 20; ++i)
    last = joinedEvent(last, `launch ${i}: ${"y".repeat(140)}`, at(200 + i));
  expect(last.text.length).toBeLessThanOrEqual(2048);
  expect(last.text).not.toContain("early");
  expect(last.text).toContain("…");
  expect(last.text).toContain(`launch 19: ${"y".repeat(140)}\nlaunch 20:`);
  expect(last.text).toMatch(/launch 20: y{140}$/u);
});

test("an oversized newest diagnostic retains its action and outcome and is acknowledged by identity", () => {
  const text = (middle: string) => `run build: ${middle.repeat(1800)}: exit 1`;
  const earlier = joinedEvent(null, text("😀"), at(300));
  const newest = joinedEvent(earlier, text("😀"), at(300));
  expect(newest.text.length).toBeLessThanOrEqual(2048);
  expect(newest.text).toBe(earlier.text);
  expect(newest.text).toBe(newest.text.toWellFormed());
  expect(newest.text).toMatch(/^run build:/u);
  expect(newest.text).toMatch(/: exit 1$/u);
  expect(newest.text).toContain("…");
  expect(answeredBy(newest, earlier)).toBe(false);
  expect(answeredBy(newest, newest)).toBe(true);
  const after = joinedEvent({ ...newest, answered: true }, text("😀"), at(300));
  expect(after.text).toBe(newest.text);
  expect(answeredBy(after, newest)).toBe(false);
});
