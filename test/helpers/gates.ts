// The gates a test builds a piece against. Each call makes its own, so nothing
// here is shared between tests or between files, and a gate derives from the
// config alone: no key the daemon's links hold, as before any daemon armed.

import type { DslConfig } from "../../src/config/dsl-types";
import {
  createGates,
  type Gates,
  type HeldKeys,
} from "../../src/daemon/foundations/gates";
import type { Gate } from "../../src/daemon/foundations/validator-registry";

export const BARE_HELD_KEYS: HeldKeys = { state: [], config: [] };

export function bareGates(): Gates {
  return createGates(BARE_HELD_KEYS);
}

export const stateGate = (config: DslConfig): Gate =>
  bareGates().state.gateFor(config);

export const configGate = (config: DslConfig): Gate =>
  bareGates().config.gateFor(config);
