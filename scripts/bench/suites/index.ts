// Every benchmark there is, in the order a tick pays for them.

import type { Benchmark } from "../types.js";
import { CLIENTS } from "./client.js";
import { SOURCES } from "./sources.js";
import { STAGES } from "./stages.js";
import { WIRE } from "./wire.js";

export const BENCHMARKS: readonly Benchmark[] = [...STAGES, ...SOURCES, ...WIRE, ...CLIENTS];

// [LAW:single-enforcer] The one place ids are checked: a report row is keyed
// by its id, so two benchmarks sharing one would silently overwrite each other
// in a baseline join.
const seen = new Set<string>();
for (const { id } of BENCHMARKS) {
  if (seen.has(id)) throw new Error(`two benchmarks are named ${id}`);
  seen.add(id);
}
