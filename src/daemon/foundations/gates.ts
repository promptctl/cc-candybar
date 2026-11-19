// [LAW:no-shared-mutable-globals] Each renderer builds the write gates for
// the configs it compiles. Registering a key changes only that registry.

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

// [LAW:single-enforcer] Derive both write gates when a config loads. A
// conflicting action is a config diagnostic before a user ever clicks it.
export function deriveActionGates(gates: Gates, config: DslConfig): void {
  gates.state.gateFor(config);
  gates.config.gateFor(config);
}

// [LAW:one-source-of-truth] `held` supplies keys common to every config
// in this registry. Each config supplies the rest through its actions.
export function createGates(held: HeldKeys = { state: [], config: [] }): Gates {
  const state = makeStateKeyspace();
  const config = makeConfigKeyspace();
  for (const { key, allowed } of held.state) state.register(key, allowed);
  for (const { key, allowed } of held.config) config.register(key, allowed);
  return { state, config };
}
