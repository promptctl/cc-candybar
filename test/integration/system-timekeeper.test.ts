import { systemTimekeeper } from "../../src/time";
import { timekeeperContract } from "../contract/timekeeper.contract";

timekeeperContract("the system timekeeper", () => ({
  clock: systemTimekeeper,
  settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}));

describe("the system timekeeper", () => {
  test("a timer set to leave the process alone does not hold the loop", () => {
    const set = jest.spyOn(globalThis, "setTimeout");
    const clear = systemTimekeeper.after(60_000, () => undefined, {
      unref: true,
    });
    const held = systemTimekeeper.after(60_000, () => undefined);
    const [unref, ref] = set.mock.results.map(
      (r) => r.value as NodeJS.Timeout,
    );
    set.mockRestore();
    clear();
    held();
    expect(unref!.hasRef()).toBe(false);
    expect(ref!.hasRef()).toBe(true);
  });
});
