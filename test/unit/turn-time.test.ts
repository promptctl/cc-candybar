// The renderer's time (src/renderer/turn-time.ts): what an owner asked to run
// later runs in the `due` turn that reaches it, earliest first.

import { TurnTime } from "../../src/renderer/turn-time";
import type { Instant } from "../../src/utils/instant";

const at = (s: number) => s as Instant;

test("a deferral that throws fails its turn, and those behind it stay due for the next", () => {
  const time = new TurnTime();
  time.turn(at(10));
  const ran: string[] = [];
  time.after(100, () => {
    ran.push("first");
    throw new Error("the settle broke");
  });
  time.after(200, () => ran.push("second"));

  time.turn(at(11));
  expect(() => time.due(at(11))).toThrow("the settle broke");
  expect(ran).toEqual(["first"]);
  expect(time.next()).toBe(10.2);

  time.due(at(11));
  expect(ran).toEqual(["first", "second"]);
  expect(time.next()).toBe(null);
});
