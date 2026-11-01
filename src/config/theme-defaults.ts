// [LAW:one-source-of-truth] Where a theme's default look sits in the
// precedence chain (candybar-theme-colours-6fq5.ix8). Different themes look
// best with different shades, variations and styles, so each theme may carry
// its own `themeDefaults.<theme>` entry, and it is ONE rung, read here:
//
//   floor  <  THEME DEFAULT  <  config globals (the active preset's over the
//   file's)  <  session pick  <  edit mode
//
// Below the config's globals on purpose: a theme's default fills only what
// the user's file leaves unsaid, so it can never override a choice the user
// wrote down. The rung is a VALUE folded under the globals every resolution
// already reads, never a branch in it [LAW:dataflow-not-control-flow]: a
// theme with no entry contributes the empty fragment, and every field
// resolves by the same expression either way.

import type { DslConfig, Globals, ThemeDefault } from "./dsl-types.js";
import { THEME_DEFAULT_FIELDS } from "./globals-fields.js";
import type { Selection } from "../themes/policy.js";

// The identity fragment: a theme that declares no default changes nothing.
const NO_THEME_DEFAULT: ThemeDefault = Object.freeze({});

// [LAW:types-are-the-program] Total over the theme selection's two arms. A
// theme chosen by NAME has its entry (or none). A theme chosen by a RULE
// (`globals.palette` holding a template) is known only inside drawDsl, once
// the store holds this render's values — after every other field has
// resolved — so under a rule the theme rung contributes nothing: the look
// resolves exactly as it would for a theme with no entry. That is a stated
// limitation, not an oversight; a rule-chosen theme's look is the config's.
export function themeDefaultsOf(
  theme: Selection<unknown>,
  themeDefaults: DslConfig["themeDefaults"],
): ThemeDefault {
  return theme.kind === "decided"
    ? (themeDefaults[theme.name] ?? NO_THEME_DEFAULT)
    : NO_THEME_DEFAULT;
}

// The config-default rung with the theme's default folded in beneath it:
// each look field is what the globals say, else what the theme's default
// says. Per field rather than a spread, so a globals object carrying an
// explicit `undefined` still reads as unsaid.
export function underThemeDefault(
  globals: Globals,
  fragment: ThemeDefault,
): Globals {
  return {
    ...globals,
    ...Object.fromEntries(
      THEME_DEFAULT_FIELDS.map((f) => [f, globals[f] ?? fragment[f]]),
    ),
  };
}
