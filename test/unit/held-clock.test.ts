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
});
