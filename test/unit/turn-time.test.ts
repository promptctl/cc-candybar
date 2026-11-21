// The renderer's time (src/renderer/turn-time.ts): a turn reads the readings
// its input carried and nothing else, and work held for later runs in the due
// turn whose tick has reached it, earliest first.

import { TurnTime } from "../../src/renderer/turn-time";
import type { Instant, Readings, Tick } from "../../src/utils/instant";

const at = (wall: number, tick: number): Readings => ({
  at: wall as Instant,
  tick: tick as Tick,
});

test("a turn reads its input's readings, and none is there to read outside one, even after a turn that threw", () => {
  const time = new TurnTime();
  expect(
    time.during(at(100, 5), () => [time.at, time.tick, time.clock.now()]),
  ).toEqual([100, 5, 100_000]);
  expect(() => time.at).toThrow("the renderer's time was read outside a turn");
  expect(() =>
    time.during(at(100, 5), () => {
      throw new Error("the turn broke");
    }),
  ).toThrow("the turn broke");
  expect(() => time.tick).toThrow("outside a turn");
});

test("held work runs in the first due turn whose tick has reached it, earliest first, and is measured on ticks whatever the wall did", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  time.during(at(100, 0), () => {
    time.after("test task", 2000, () => ran.push("two"));
    time.clock.after("test task", 1000, () => ran.push("one"));
  });
  expect(time.next()).toBe(1);
  // The wall stepped back an hour: the ticks still say one second on.
  time.during(at(100 - 3600, 1), () => time.runDue());
  expect(ran).toEqual(["one"]);
  expect(time.next()).toBe(2);
  time.during(at(0, 5), () => time.runDue());
  expect(ran).toEqual(["one", "two"]);
  expect(time.next()).toBeNull();
});

test("work let go never runs, even by work due before it in the same turn", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  time.during(at(0, 0), () => {
    let release = (): void => {};
    time.after("test task", 0, () => {
      ran.push("first");
      release();
    });
    release = time.after("test task", 10, () => ran.push("second"));
  });
  time.during(at(0, 1), () => time.runDue());
  expect(ran).toEqual(["first"]);
  expect(time.next()).toBeNull();
});

test("work held while due work runs waits for the next due turn, so a chain spreads over turns", () => {
  const time = new TurnTime();
  let runs = 0;
  const again = (): void => {
    runs++;
    time.after("test task", 0, again);
  };
  time.during(at(0, 0), () => time.after("test task", 0, again));
  time.during(at(0, 0), () => time.runDue());
  expect(runs).toBe(1);
  expect(time.next()).toBe(0);
  time.during(at(0, 0), () => time.runDue());
  expect(runs).toBe(2);
});

test("held work that throws keeps none due after it from running, is not held again, and its throw is the turn's", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  time.during(at(0, 0), () => {
    time.after("test task", 0, () => {
      throw new Error("the walk broke");
    });
    time.after("test task", 10, () => ran.push("after"));
  });
  expect(() => time.during(at(0, 1), () => time.runDue())).toThrow(
    "the walk broke",
  );
  expect(ran).toEqual(["after"]);
  expect(time.next()).toBeNull();
});
