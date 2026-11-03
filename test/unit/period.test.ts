import { Period } from "../../src/utils/period";
import { systemTimekeeper, type Monotonic } from "../../src/time";
import { heldClock } from "../helpers/held-clock";

afterEach(() => {
  jest.useRealTimers();
});

describe("Period", () => {
  test("a disposed period never runs again, whatever holds or lands after", async () => {
    jest.useFakeTimers();
    let ticks = 0;
    const period = new Period(() => ticks++, systemTimekeeper);
    period.landed(1_000);
    period.hold(true);
    period.dispose();

    period.hold(false);
    period.hold(true);
    period.landed(1_000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(ticks).toBe(0);
  });

  test("a landing kept from earlier resumes where it left off", async () => {
    jest.useFakeTimers();
    let ticks = 0;
    const period = new Period(() => ticks++, systemTimekeeper);
    period.hold(true);

    period.landed(1_000, (performance.now() - 600) as Monotonic);
    await jest.advanceTimersByTimeAsync(399);
    expect(ticks).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(1);

    period.landed(1_000, (performance.now() - 5_000) as Monotonic);
    await jest.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(2);
    period.dispose();
  });
});

describe("Period's gap", () => {
  test("is measured on the monotonic clock, so a wall step does not move the next read", () => {
    const held = heldClock(new Date("2026-01-01T00:00:00Z"));
    let step = 0;
    const clock = { ...held, now: () => held.now() + step };
    let ticks = 0;
    const period = new Period(() => ticks++, clock);
    period.hold(true);
    period.landed(1_000);
    period.hold(false);
    held.advance(400);
    step = -3_600_000;
    period.hold(true);
    held.advance(599);
    expect(ticks).toBe(0);
    held.advance(1);
    expect(ticks).toBe(1);
    period.dispose();
  });
});
