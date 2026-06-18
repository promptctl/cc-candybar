// [LAW:single-enforcer] The slim name/string policy layered on top of rich-js's
// theme registry. cc-candybar selects theme NAMES and style IDENTIFIERS here;
// every color *value* operation (hydrate hex, resolve specs, darken/contrast,
// hue/transpose) lives in rich-js. This module only moves strings — no
// PaletteResolver, no ColorRgba, no hex. The semantic/anchor knowledge
// (which tokens keep their hue) stays in rich-js (ANCHORED_ROOTS), not here.

import { listThemePalettes } from "@promptctl/rich-js";

// --- Theme name aliasing ---

const THEME_ALIASES: Record<string, string> = {
  dark: "textual-dark",
  light: "textual-light",
};

export function resolvePaletteName(name: string): string {
  return THEME_ALIASES[name] ?? name;
}

// The theme name a render should use, as data. [LAW:dataflow-not-control-flow]
// The `??` chain is the precedence — session choice over config default over the
// built-in — with no "if the session has a theme" branch. The session value is
// the user's live per-session pick (null when unset); globals.palette is the
// config default; "textual-dark" is the always-present floor.
// [LAW:one-source-of-truth] The single definition of "which theme is effective";
// every render derives basePalette through this, so the rendered palette can
// never disagree with the chosen theme.
export function effectiveThemeName(
  sessionTheme: string | null,
  globalsPalette: string | undefined,
): string {
  return sessionTheme ?? globalsPalette ?? "textual-dark";
}

function listThemeAliases(): readonly string[] {
  return Object.keys(THEME_ALIASES);
}

// [LAW:one-source-of-truth] The set of names that resolve to a concrete Palette
// is exactly registry names ∪ aliases — the same inputs resolvePaletteName +
// getThemePalette accept. "custom" and "random" are deliberately absent: neither
// names a concrete palette (custom needs inline colors; random is a per-session
// sentinel). Config validators that gate a palette PULL (DSL `palette:` field)
// must reuse this, not re-derive it.
export function listResolvablePaletteNames(): readonly string[] {
  return [...listThemePalettes(), ...listThemeAliases()];
}

// --- Powerline strip-style identifiers ---

// [LAW:one-source-of-truth][LAW:types-are-the-program] The single canonical set
// of powerline cap/separator shapes a render can take. The `StripStyle` type is
// DERIVED from this const, so the picker's option domain, the SessionState
// validator, the `styles()` template binding, and `pickJoiner`'s dispatch all
// trace to one literal — adding a shape here forces a new `pickJoiner` arm at
// compile time (the joiner switch is total over `StripStyle`). This is where the
// drift between "what you can pick" and "what actually renders" is closed.
export const STRIP_STYLES = ["powerline", "capsule", "plain"] as const;
export type StripStyle = (typeof STRIP_STYLES)[number];

// [LAW:types-are-the-program] The trust-boundary narrowing from a raw
// SessionState string (or a config default) to the closed `StripStyle` union.
export function isStripStyle(value: string): value is StripStyle {
  return (STRIP_STYLES as readonly string[]).includes(value);
}

// The strip style a render should use, as data. [LAW:dataflow-not-control-flow]
// [LAW:one-type-per-behavior] The exact shape of `effectiveThemeName`, one
// dimension over: session choice over config default over the "powerline" floor,
// no "if the session has a style" branch. A value outside the domain (a stale
// SessionState entry from a prior option vocabulary) collapses to the floor —
// `pickJoiner` would render it as powerline anyway, so the floor keeps the
// returned type honest rather than silently widening.
export function effectiveStripStyle(
  sessionStyle: string | null,
  globalsStyle: StripStyle | undefined,
): StripStyle {
  const chosen = sessionStyle ?? globalsStyle ?? "powerline";
  return isStripStyle(chosen) ? chosen : "powerline";
}
