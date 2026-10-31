import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import v8 from "node:v8";
import vm from "node:vm";
import { validateConfig } from "./helpers/parse-and-validate";
import {
  loadConfig,
  NO_PROJECT,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { registerDslConfig } from "../src/dsl/render";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { SessionState } from "../src/daemon/session-state";

// [LAW:verifiable-goals] The 2026-09-03 outage in numbers: the helper preamble
// re-parsed into every template cost ~30 MB per registered config; the daemon
// holds one per (projectDir, cwd) and sat at 600+ MB with twenty. Helpers are
// now one shared Defines (src/dsl/render.ts compileHelpers), which brought a
// stdlib config to ~1.2 MB; the stdlib has grown since (~4.2 MB at
// brandon-settings-coverage-g4p.lx2, whose per-placement threshold controls
// added ~0.2 MB; 8.2 MB by brandon-unfiled-3248.8ro6 step 6, part 1, and
// 8.3 MB once part 2 classified every template's reads of the instant — 8.6 MB
// as CI measured it). This pins the order of magnitude, not the exact figure:
// a regression back to per-template copies overshoots the bound several times;
// ordinary growth of the stdlib does not.
const PER_CONFIG_BOUND_BYTES = 12 * 1024 * 1024;

v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc") as () => void;
function heapUsed(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function registerStdlib() {
  const config = validateConfig(
    loadConfig(null, DEFAULT_DSL_CONFIG, NO_PROJECT),
    "<default>",
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  return { registry, compiled: registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" }) };
}

test("a registered stdlib config costs megabytes, not tens of them, helpers included", () => {
  const keep = [registerStdlib()];
  const before = heapUsed();
  const K = 4;
  for (let i = 0; i < K; i++) keep.push(registerStdlib());
  const perConfig = (heapUsed() - before) / K;
  for (const { registry } of keep) registry.dispose();
  expect(perConfig).toBeLessThan(PER_CONFIG_BOUND_BYTES);
});
