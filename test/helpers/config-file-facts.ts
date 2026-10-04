import type { ConfigFileFacts } from "../../src/daemon/render-payload.js";
import { SETTINGS, type SettingName } from "../../src/config/setting-projections.js";

// A session rendering the bundled default with nothing picked: no drafts, no
// file, nothing a reset would change.
export const NO_CONFIG_FILE: ConfigFileFacts = {
  unsaved: 0,
  resettable: Object.fromEntries(
    Object.keys(SETTINGS).map((name) => [name, false]),
  ) as Record<SettingName, boolean>,
  configPath: null,
};
