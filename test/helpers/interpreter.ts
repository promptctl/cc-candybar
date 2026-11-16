import type { ConfigInterpreter } from "../../src/daemon/effect-interpreter";

// The interpreter of a host whose renderer writes no config: a change it
// returns fails its turn loudly, naming the effect.
export const NO_CHANGES: ConfigInterpreter = {
  change: (effect) => {
    throw new Error(
      `this test's renderer returns no config change, and it returned ${JSON.stringify(effect)}`,
    );
  },
};
