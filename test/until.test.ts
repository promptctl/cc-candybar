import { setTimeout as sleep } from "node:timers/promises";
import { untilHeard } from "./helpers/reload-signal";
import { throughout } from "./helpers/until";
import { DEBOUNCE_MS } from "../src/daemon/cache/watchers";

// Past the round cadence, so the probe outlives the round that made it.
const LATE_MS = 8 * DEBOUNCE_MS;

const lateThrow = async (): Promise<boolean> => {
  await sleep(LATE_MS);
  throw new Error("late");
};

describe("a probe that outlives its wait", () => {
  it("fails the untilHeard that left it, though a later round held", async () => {
    let round = 0;
    await expect(
      untilHeard(
        () => { round++; },
        () => (round === 1 ? lateThrow() : true),
        "heard",
      ),
    ).rejects.toThrow("late");
  });

  it("fails the throughout that left it, at the expiry that would have passed", async () => {
    await expect(throughout(lateThrow, "held", DEBOUNCE_MS)).rejects.toThrow("late");
  });

  it("does not hold an untilHeard that failed by name", async () => {
    const never = new Promise<boolean>(() => {});
    await expect(untilHeard(() => {}, () => never, "heard")).rejects.toThrow(
      "heard did not hold after",
    );
  }, 25_000);
});
