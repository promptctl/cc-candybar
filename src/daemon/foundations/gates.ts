// [LAW:no-shared-mutable-globals] The gates a daemon (or a `check`) holds, as
// one value its root builds and passes down. The keys a daemon writes at run
// time (the update notice's) are registered on THIS value, so two values share
// nothing and what a load accepts is visible in the inputs.

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
// what configs derive. Later registrations (the dismiss key following the
// identity) go through the keyspaces' own `register`.
export function createGates(held: HeldKeys): Gates {
  const state = makeStateKeyspace();
  const config = makeConfigKeyspace();
  for (const { key, allowed } of held.state) state.register(key, allowed);
  for (const { key, allowed } of held.config) config.register(key, allowed);
  return { state, config };
}
