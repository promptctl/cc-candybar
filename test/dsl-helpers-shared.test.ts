import v8 from "node:v8";
import vm from "node:vm";
import { loadConfig, validateConfig } from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { registerDslConfig } from "../src/dsl/render";
import { SourceRegistry } from "../src/var-system/sources";
import { VariableStore } from "../src/var-system/store";
import { SessionState } from "../src/daemon/session-state";

// [LAW:verifiable-goals] An order-of-magnitude bound: per-template helper copies overshoot it tenfold.
const PER_CONFIG_BOUND_BYTES = 4 * 1024 * 1024;

v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc") as () => void;
function heapUsed(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function registerStdlib() {
  const { config: merged, source } = loadConfig(null, DEFAULT_DSL_CONFIG);
  const config = validateConfig(merged, "<default>", source);
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  return { registry, compiled: registerDslConfig(config, registry, { cwd: "/tmp" }) };
}

test("a registered stdlib config costs single-digit megabytes, helpers included", () => {
  const keep = [registerStdlib()];
  const before = heapUsed();
  const K = 4;
  for (let i = 0; i < K; i++) keep.push(registerStdlib());
  const perConfig = (heapUsed() - before) / K;
  for (const { registry } of keep) registry.dispose();
  expect(perConfig).toBeLessThan(PER_CONFIG_BOUND_BYTES);
});
