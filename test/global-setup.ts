// [LAW:single-enforcer] Runs once before the workers fork, in the process they
// inherit their real environment from. test/setup.ts could not do this: it
// writes the sandbox's copy of the env, and a child spawned with no `env` option
// reads the worker's real one, so a preload set there misses that child.

import fs from "node:fs";

import { LEDGER_ENV, withDaemonLedger } from "./helpers/process-tier.cjs";
import { jestTmpDir } from "./helpers/jest-tmp";

export default function globalSetup(): void {
  // Named for this process, so a concurrent run's teardown leaves it alone.
  const ledger = jestTmpDir("ledger");
  fs.writeFileSync(ledger, "");
  process.env[LEDGER_ENV] = ledger;
  process.env.NODE_OPTIONS = withDaemonLedger(process.env.NODE_OPTIONS);
}
