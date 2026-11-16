import type { ConfigFileFacts } from "../../src/renderer/render-payload.js";
import { perSetting } from "../../src/config/setting-projections.js";

// A session rendering the bundled default with nothing picked: no drafts, no
// file, nothing a reset would change.
export const NO_CONFIG_FILE: ConfigFileFacts = {
  unsaved: 0,
  resettable: perSetting(() => false),
  themeDefault: { differs: false },
  configPath: null,
  layers: { user: true, project: false, local: false },
};
