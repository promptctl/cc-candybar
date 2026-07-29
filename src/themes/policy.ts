// [LAW:single-enforcer] The slim name/string policy layered on top of rich-js's
// theme registry. cc-candybar selects theme NAMES and style IDENTIFIERS here;
// every color *value* operation (hydrate hex, resolve specs, darken/contrast,
// hue/transpose) lives in rich-js. This module only moves strings — no
// PaletteResolver, no ColorRgba, no hex. The semantic/anchor knowledge
// (which tokens keep their hue) stays in rich-js (ANCHORED_ROOTS), not here.

import {
  listThemePalettes,
  type ColorSystemSpec,
  type ThemeKey,
} from "@promptctl/rich-js";

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

// --- Look (theme-adaptation) identifiers ---

// The look name a render should use, as data. [LAW:dataflow-not-control-flow]
// [LAW:one-type-per-behavior] The exact shape of `effectiveThemeName`, one
// dimension over: session choice over config default over the "none" floor, no
// "if the session has a look" branch. Unlike the registry-static theme/style
// domains, the look domain is PER-CONFIG (the merged `looks` block), so the
// declared names arrive as data. A value outside them (a stale SessionState
// entry from a prior config's look vocabulary — config edits can orphan a
// clicked name the per-config gate once admitted) collapses to "none", which
// every merged DslConfig carries by construction (the bundled stdlib ships it;
// merge-by-name cannot remove it) — the same collapse-to-floor that keeps
// effectiveStripStyle's return honest rather than silently widening.
export function effectiveLookName(
  sessionLook: string | null,
  globalsLook: string | undefined,
  declaredLooks: Readonly<Record<string, unknown>>,
): string {
  const chosen = sessionLook ?? globalsLook ?? "none";
  return Object.prototype.hasOwnProperty.call(declaredLooks, chosen)
    ? chosen
    : "none";
}

// [LAW:single-enforcer] The one place an effective look NAME becomes the
// ThemeKey a render transposes with. By the time a name reaches here it must be
// a member: effectiveLookName collapses unknown names to the "none" floor, and
// mergeWithDefault guarantees the bundled "none" exists in every DslConfig.
// [LAW:no-defensive-null-guards] the throw is the loud failure for that broken
// invariant (a hand-built config missing the stdlib), never a silent identity
// fallback that would hide the drift.
export function lookKeyByName(
  looks: Readonly<Record<string, ThemeKey>>,
  name: string,
): ThemeKey {
  const key = looks[name];
  if (key === undefined) {
    throw new Error(
      `Look "${name}" is not declared in this config — effectiveLookName ` +
        `collapses unknown names to "none", and every merged config carries ` +
        `"none"; a miss here is merge/policy drift`,
    );
  }
  return key;
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

// --- Joiner charset identifiers ---

// [LAW:one-source-of-truth][LAW:types-are-the-program] The single canonical set
// of glyph vocabularies the strip joiners can render with (the legacy
// display.charset). Same species as STRIP_STYLES — a closed render-vocabulary
// enum hosted in this leaf policy module so the config loader (validation +
// JSON-schema emit) and the render layer (glyph dispatch) both derive from one
// literal without a config↔render cycle [LAW:one-way-deps]. "ascii" swaps the
// powerline-private-use cap glyphs (U+E0Bx — tofu without a Nerd Font) for
// plain-ASCII equivalents; it is orthogonal to StripStyle: style picks the
// joiner SHAPE, charset picks the glyph VALUES fed to it.
// [config-only] Unlike STRIP_STYLES there is no SessionState/click half, so no
// narrowing guard or effective* resolver — the config global over the default
// is the whole resolution.
export const CHARSETS = ["unicode", "ascii"] as const;
export type Charset = (typeof CHARSETS)[number];

// --- Color-depth identifiers ---

// [LAW:one-source-of-truth][LAW:types-are-the-program] The single canonical set
// of color depths a config can pin (the legacy display.colorCompatibility).
// Same species as CHARSETS: a closed render-vocabulary enum hosted in this leaf
// policy module so the config loader (validation + JSON-schema emit) and the
// render layer both derive from one literal without a config↔render cycle
// [LAW:one-way-deps]. `satisfies` ties every member to rich-js's
// ColorSystemSpec at compile time WITHOUT widening the derived union — if
// rich-js renames a depth, this literal fails to compile rather than drifting.
//
// Deliberately NARROWER than ColorSystemSpec: "auto" (and null) are excluded.
// The daemon is long-lived and detached, so its process env is NOT the client
// terminal's — rich-js env detection would silently downsample against the
// wrong terminal [LAW:no-silent-failure]. Honoring "auto" needs a client
// capability hint over the wire (the termCols pattern); until that lands, the
// loader rejects "auto" with a pointer instead of shipping a lie.
export const COLOR_COMPATIBILITIES = [
  "truecolor",
  "256",
  "ansi",
  "none",
] as const satisfies readonly ColorSystemSpec[];
export type ColorCompatibility = (typeof COLOR_COMPATIBILITIES)[number];
