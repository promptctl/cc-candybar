import { timekeeperContract } from "../contract/timekeeper.contract";
import { heldClock } from "../helpers/held-clock";

// Letting the promises a fired timer resolved run their continuations.
const turns = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

timekeeperContract("the held clock", () => {
  const clock = heldClock(new Date(1_000_000));
  return {
    clock,
    settle: async (ms) => {
      clock.advance(ms);
      await turns();
    },
  };
});

describe("the held clock", () => {
  test("stands still until it is advanced", () => {
    const clock = heldClock(new Date(1_000_000));
    expect(clock.now()).toBe(1_000_000);
    expect(clock.monotonic()).toBe(0);
    clock.advance(250);
    expect(clock.now()).toBe(1_000_250);
    expect(clock.monotonic()).toBe(250);
  });

  test("each timer runs at its own moment, so a run can read how far time had gone", () => {
    const clock = heldClock(new Date(1_000_000));
    const at: number[] = [];
    clock.after(30, () => at.push(clock.monotonic()));
    clock.every(40, () => at.push(clock.monotonic()));
    clock.advance(100);
    expect(at).toEqual([30, 40, 80]);
    expect(clock.monotonic()).toBe(100);
  });

  test("a burn moves time and fires nothing; what fell due runs at the burned moment on the next advance", () => {
    const clock = heldClock(new Date(1_000_000));
    const at: number[] = [];
    clock.after(30, () => at.push(clock.monotonic()));
    clock.burn(60);
    expect(clock.monotonic()).toBe(60);
    expect(clock.now()).toBe(1_000_060);
    expect(at).toEqual([]);
    clock.advance(0);
    expect(at).toEqual([60]);
  });

  test("an advance that ends before a burn's end leaves time where the burn put it", () => {
    const clock = heldClock(new Date(1_000_000));
    clock.burn(60);
    clock.advance(10);
    expect(clock.monotonic()).toBe(70);
  });

  test("a timer that re-arms with no delay inside a burning callback runs once per burn, so an advance ends", () => {
    const clock = heldClock(new Date(1_000_000));
    const at: number[] = [];
    const run = (): void => {
      at.push(clock.monotonic());
      clock.burn(60);
      clock.after(0, run);
    };
    clock.after(0, run);
    clock.advance(130);
    // Runs at 0, 60 and 120; the one after the burn at 180 is past the end.
    expect(at).toEqual([0, 60, 120]);
    expect(clock.monotonic()).toBe(180);
  });

  test("counts the timers armed, not those fired or cancelled", () => {
    const clock = heldClock(new Date(1_000_000));
    expect(clock.pending()).toBe(0);
    const cancel = clock.after(10, () => {});
    clock.after(20, () => {});
    clock.every(5, () => {});
    expect(clock.pending()).toBe(3);
    cancel();
    expect(clock.pending()).toBe(2);
    clock.advance(20);
    expect(clock.pending()).toBe(1);
  });
});
