// The look each bundled theme ships with: every entry is the default Brandon
// set for that theme in the bar (`⤓ default for <theme>` behind the settings
// menu's theme ⚙ writes one into a config file's `themeDefaults`; the
// chosen entries are copied here to ship). A theme with no entry wears the
// floors — shade "middle", variation "accent", style "none" — and a user's
// own `themeDefaults.<theme>` merges over its entry field by field.
//
// [LAW:one-source-of-truth] Data only, beside the bundled default it is part
// of: the rung it feeds is src/config/theme-defaults.ts.

import type { ThemeDefault } from "./dsl-types.js";

export const BUNDLED_THEME_DEFAULTS: Readonly<Record<string, ThemeDefault>> =
  {};
