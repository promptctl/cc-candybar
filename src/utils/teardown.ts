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
// name, stack and all, without skipping the rest. It answers the names of the
// steps that threw, for a caller whose exit reports them.
export async function runTeardown(
  steps: readonly TeardownStep[],
  log: DaemonLogger,
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (e) {
      log("warn", `${name} failed: ${inspect(e)}`);
      failed.push(name);
    }
  }
  return failed;
}
