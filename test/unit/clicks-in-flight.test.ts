// [LAW:behavior-not-structure] The host's answer of whether a click's client
// left, by the click's id (src/daemon/clicks-in-flight.ts).

import { ClicksInFlight } from "../../src/daemon/clicks-in-flight";
import type { RequestId } from "../../src/renderer/interface";

const CLICK = 4 as RequestId;

test("answers for a held click from its connection, as the connection's answer moves", () => {
  const clicks = new ClicksInFlight();
  let left = false;
  using _held = clicks.hold({ id: CLICK, gone: () => left });
  expect(clicks.gone(CLICK)).toBe(false);
  left = true;
  expect(clicks.gone(CLICK)).toBe(true);
});

test("a click asked about once its turn let go of it is a bug, named by its id", () => {
  const clicks = new ClicksInFlight();
  {
    using _held = clicks.hold({ id: CLICK, gone: () => false });
  }
  expect(() => clicks.gone(CLICK)).toThrow(/click 4 is not in flight/);
});
