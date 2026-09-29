// [LAW:one-source-of-truth] The presets the bundled default declares, the
// floor included. A file's entry under one of these names is a delta over the
// bundled one; any other preset is the user's own content. Reset (which
// clears a delta but never the user's own pin), save-as-preset's delete (which
// refuses a bundled name) and the menu's `🗑` (shown only on a user preset)
// all ask this one question.

import { DEFAULT_DSL_CONFIG } from "../config/default-dsl-config.js";
import { presetNames } from "../config/presets.js";

export const BUNDLED_PRESETS: readonly string[] = presetNames(
  DEFAULT_DSL_CONFIG.presets,
);

export function isBundledPreset(name: string): boolean {
  return BUNDLED_PRESETS.includes(name);
}
