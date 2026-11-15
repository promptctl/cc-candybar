import type { AdapterToHost } from "../../src/renderer-interface/adapter";

// The storage a render cache is handed in a test whose configs declare no
// plugin source: every load holds its state's folders, and with none declared
// it holds none, so a hold naming a folder is the test's mistake, said
// loudly. A test that loads a source passes a real ManagedStorage.
export const NO_PLUGIN_STORAGE: AdapterToHost["storage"] = {
  hold: (_id, folders) => {
    if (folders.length > 0)
      throw new Error(
        `this test declares no plugin source, yet ${folders.join(", ")} was held`,
      );
  },
  release: () => {},
};
