import type { PluginStorage } from "../../src/daemon/cache/render";

// The storage a state's build is handed in a test whose configs declare no
// plugin source: a build asks it nothing, so any ask is the test's mistake,
// said loudly. A test that loads a source passes a real ManagedStorage.
export const NO_PLUGIN_STORAGE: PluginStorage = {
  keyFor: (folder) => {
    throw new Error(
      `this test declares no plugin source, yet ${folder} was asked for`,
    );
  },
  watch: () => {
    throw new Error(
      "this test declares no plugin source, yet a watch was asked for",
    );
  },
};
