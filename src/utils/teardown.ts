import { inspect } from "node:util";
import type { DaemonLogger } from "./logger.js";

// One step of a teardown: its name, which a failure is logged by, and what it
// runs.
export type TeardownStep = readonly [
  name: string,
  run: () => void | Promise<unknown>,
];

// [LAW:no-silent-failure][LAW:dataflow-not-control-flow] The one teardown
// runner: every step runs, each in order, and one that throws is logged by
// name, stack and all, without skipping the rest.
export async function runTeardown(
  steps: readonly TeardownStep[],
  log: DaemonLogger,
): Promise<void> {
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (e) {
      log("warn", `${name} failed: ${inspect(e)}`);
    }
  }
}
