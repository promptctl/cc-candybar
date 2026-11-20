import type { ConfigSnapshot } from "../../src/config/config-snapshot";

// A config snapshot as discovery hands it over: an empty chain at `/`, every
// fault null, with whatever a case sets. The one place a fixture learns a new
// snapshot field.
export function configSnapshot(
  over: Partial<ConfigSnapshot> = {},
): ConfigSnapshot {
  return {
    chain: [],
    repo: null,
    plugins: [],
    strays: [],
    checkout: { root: "/", git: false },
    notices: [],
    watch: null,
    discoveryFault: null,
    ...over,
  };
}
