// [LAW:no-shared-mutable-globals] The gates a daemon (or a `check`) holds, as
// one value its root builds and passes down. A registration changes only
// this value, so what a load accepts is visible in its inputs.

import type { DslConfig } from "../../config/dsl-types";
import { makeConfigKeyspace } from "./config-validators";
import { makeStateKeyspace } from "./state-validators";
import type { Keyspace } from "./validator-registry";

// A key every session may write whatever config it renders, and the values a
// link writes to it. An empty list holds the key with nothing writable yet.
export interface HeldKey {
  readonly key: string;
  readonly allowed: readonly string[];
}

export interface HeldKeys {
  readonly state: readonly HeldKey[];
  readonly config: readonly HeldKey[];
}

export interface Gates {
  // The SessionState writes (`set-state`, `step-state`) a config's sessions may make.
  readonly state: Keyspace<DslConfig>;
  // The config-file writes (`persist`) a config's sessions may make.
  readonly config: Keyspace<DslConfig>;
}

// [LAW:one-source-of-truth] `held` is the whole daemon-wide contribution at
// construction: the one place a daemon's gates are said to hold anything beyond
// what configs derive. Later registrations go through the keyspaces.
export function createGates(held: HeldKeys = { state: [], config: [] }): Gates {
  const state = makeStateKeyspace();
  const config = makeConfigKeyspace();
  for (const { key, allowed } of held.state) state.register(key, allowed);
  for (const { key, allowed } of held.config) config.register(key, allowed);
  return { state, config };
}
