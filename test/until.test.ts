import { setTimeout as sleep } from "node:timers/promises";
import { untilHeard } from "./helpers/reload-signal";
import { DEBOUNCE_MS } from "../src/daemon/cache/watchers";

// Past the round cadence, so the probe outlives the round that made it.
const LATE_MS = 8 * DEBOUNCE_MS;

const lateThrow = async (): Promise<boolean> => {
  await sleep(LATE_MS);
  throw new Error("late");
};

describe("a probe that outlives its round", () => {
  it("fails the wait with its late throw", async () => {
    let probes = 0;
    await expect(
      untilHeard(
        () => {},
        () => {
          probes++;
          return lateThrow();
        },
        "heard",
      ),
    ).rejects.toThrow("late");
    expect(probes).toBe(1);
  });

  it("ends the wait with its late answer", async () => {
    let probes = 0;
    await untilHeard(
      () => {},
      async () => {
        probes++;
        await sleep(LATE_MS);
        return true;
      },
      "heard",
    );
    expect(probes).toBe(1);
  });

  it("is asked again once it answers false", async () => {
    let probes = 0;
    await untilHeard(() => {}, async () => ++probes === 2, "heard");
    expect(probes).toBe(2);
  });

  it("does not hold a wait whose mutation threw", async () => {
    let round = 0;
    const never = new Promise<boolean>(() => {});
    await expect(
      untilHeard(
        () => {
          if (++round === 2) throw new Error("mutate");
        },
        () => never,
        "heard",
      ),
    ).rejects.toThrow("mutate");
  });
});
