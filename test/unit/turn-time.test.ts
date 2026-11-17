// [LAW:no-ambient-temporal-coupling] The renderer's time (src/renderer/turn-time.ts):
// the instant of the input in its turn, and the work held for a later one,
// which a `due` runs. No clock is read: every instant here is the case's.

import { TurnTime } from "../../src/renderer/turn-time";
import type { Instant } from "../../src/utils/instant";

const at = (s: number): Instant => (1_700_000_000 + s) as Instant;

// A TurnTime inside a turn at `s`, for the duration of `body`.
const during = <T>(time: TurnTime, s: number, body: () => T): T => {
  time.begin(at(s));
  try {
    return body();
  } finally {
    time.end();
  }
};

test("the time is the turn's instant, and reading it outside any turn throws", () => {
  const time = new TurnTime();
  expect(() => time.at()).toThrow(
    "the renderer read the time outside any turn",
  );
  during(time, 5, () => {
    expect(time.at()).toBe(at(5));
    expect(time.now()).toBe(at(5) * 1000);
  });
  expect(() => time.now()).toThrow();
});

test("a deferral falls due its delay after the turn that held it, and runs in the due that reaches it, once", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  during(time, 0, () => time.after(1500, () => ran.push("settle")));
  expect(time.next()).toBe(at(1.5));
  time.runDue(at(1.4));
  expect(ran).toEqual([]);
  time.runDue(at(1.5));
  time.runDue(at(9));
  expect(ran).toEqual(["settle"]);
  expect(time.next()).toBeNull();
});

test("deferrals due by one instant run earliest first", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  during(time, 0, () => {
    time.after(300, () => ran.push("late"));
    time.after(100, () => ran.push("early"));
  });
  time.runDue(at(1));
  expect(ran).toEqual(["early", "late"]);
});

test("a deferral let go of never runs, though an earlier one in the same due lets go of it", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  let letGo = (): void => {};
  during(time, 0, () => {
    time.after(100, () => {
      ran.push("first");
      letGo();
    });
    letGo = time.after(200, () => ran.push("second"));
  });
  time.runDue(at(1));
  expect(ran).toEqual(["first"]);
  expect(time.next()).toBeNull();
});

test("a deferral that throws fails the due, and leaves those behind it held, due again", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  during(time, 0, () => {
    time.after(100, () => {
      throw new Error("the settle broke");
    });
    time.after(200, () => ran.push("behind"));
  });
  expect(() => time.runDue(at(1))).toThrow("the settle broke");
  expect(ran).toEqual([]);
  expect(time.next()).toBe(at(0.2));
  time.runDue(at(1));
  expect(ran).toEqual(["behind"]);
});

test("a wall stepped back since the last turn is answered, and every deferral held moves back with it; one gone forward moves nothing", () => {
  const time = new TurnTime();
  const ran: string[] = [];
  const letGo = during(time, 100, () => {
    time.after(2000, () => ran.push("settle"));
    return time.after(5000, () => ran.push("let go"));
  });
  expect(time.begin(at(40))).toBe(60);
  time.end();
  expect(time.next()).toBe(at(42));
  // Let go of after the step, as it was held before it.
  letGo();
  time.runDue(at(50));
  expect(ran).toEqual(["settle"]);
  expect(time.begin(at(500))).toBe(0);
  time.end();
});
