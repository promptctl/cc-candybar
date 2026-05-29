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

// Selectable theme names for the random pool + picker: registry names plus the
// "custom" sentinel. Aliases are excluded — they duplicate registry entries.
export function listAvailableThemes(): string[] {
  const allNames = new Set<string>(listThemePalettes() as readonly string[]);
  allNames.add("custom");
  return [...allNames].sort();
}

// --- Style identifiers ---

export const STYLE_ORDER: readonly string[] = [
  "surface",
  "muted",
  "button",
  "hue",
];

export const DISPLAY_STYLES: ReadonlyArray<
  "minimal" | "powerline" | "capsule"
> = ["minimal", "powerline", "capsule"];

// --- Session-random pick ---

// [LAW:one-source-of-truth] The random pool derives from the same registry the
// rest of the system uses. "custom" is excluded because it requires inline
// colors.custom to be defined.
export function pickRandomTheme(): string {
  const themes = listAvailableThemes().filter((t) => t !== "custom");
  return themes[Math.floor(Math.random() * themes.length)]!;
}
