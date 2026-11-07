// A session's state as a test hands it to a registry
// (src/daemon/foundations/judged-state.ts).
import {
  judged,
  type JudgedState,
  type StoredReads,
} from "../../src/daemon/foundations/judged-state";
import { createKeyspace } from "../../src/daemon/foundations/validator-registry";
import { daemonGates } from "../../src/daemon/update-keys";
import type { DslConfig } from "../../src/config/dsl-types";

// Read by a config with no controls: every stored value held, so a test about
// something other than a value written under an older config reads its
// session exactly as it wrote it.
const noControls = createKeyspace<object>({}, "state", () => []).gateFor({});
export const readAsWritten = (state: StoredReads): JudgedState =>
  judged(state, () => noControls);

// Read as the daemon reads it: judged by `config`'s own state gate.
export const judgedBy = (state: StoredReads, config: DslConfig): JudgedState => {
  const gates = daemonGates();
  return judged(state, () => gates.state.gateFor(config));
};
