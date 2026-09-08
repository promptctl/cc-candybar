// [LAW:single-enforcer] The vocabulary and the resolution for every `globals` field a
// config can set or a click can pick. A LEAF: config loader and render layer both
// import it, which keeps a config↔render cycle from forming [LAW:one-way-deps].

import { listThemePalettes, type ThemeKey } from "@promptctl/rich-js";
import type { ColorSystemSpec } from "@promptctl/rich-js/widgets";

const THEME_ALIASES: Record<string, string> = {
  dark: "textual-dark",
  light: "textual-light",
};

export function resolvePaletteName(name: string): string {
  return THEME_ALIASES[name] ?? name;
}

// [LAW:one-type-per-behavior] THE resolution every globals field shares — staged mode
// fragment over session pick over config default over floor, `staged` rightmost
// because a mode is entered LATER than a pick. [LAW:parse-dont-validate] `parseSession`
// returns null for "no session pick", so a stale entry defaults instead of throwing.
export function effectiveGlobal<T>(
  staged: T | null | undefined,
  sessionPick: string | null,
  configDefault: T | null | undefined,
  floor: T,
  parseSession: (raw: string) => T | null,
): T {
  const picked = sessionPick === null ? null : parseSession(sessionPick);
  return staged ?? picked ?? configDefault ?? floor;
}

// [LAW:one-source-of-truth] The single definition of "which theme is effective". The
// theme domain is OPEN — names resolve downstream — so the parse here is identity.
export function effectiveThemeName(
  stagedPalette: string | undefined,
  sessionTheme: string | null,
  globalsPalette: string | undefined,
): string {
  return effectiveGlobal(
    stagedPalette,
    sessionTheme,
    globalsPalette,
    "textual-dark",
    (raw) => raw,
  );
}

function listThemeAliases(): readonly string[] {
  return Object.keys(THEME_ALIASES);
}

// [LAW:one-source-of-truth] "custom"/"random" are deliberately absent: neither names
// a concrete palette. Validators gating a palette pull reuse this, never re-derive it.
export function listResolvablePaletteNames(): readonly string[] {
  return [...listThemePalettes(), ...listThemeAliases()];
}

// The `effectiveGlobal` instance for every PER-CONFIG domain (looks, presets). EVERY
// rung — staged, session AND the config default — runs the same membership parse, so
// a name the config no longer declares collapses onward wherever it came from.
export function effectiveMemberName(
  stagedName: string | undefined,
  sessionPick: string | null,
  configDefault: string | undefined,
  floor: string,
  declared: Readonly<Record<string, unknown>>,
): string {
  const member = (raw: string): string | null =>
    Object.prototype.hasOwnProperty.call(declared, raw) ? raw : null;
  return effectiveGlobal(
    stagedName === undefined ? null : member(stagedName),
    sessionPick,
    member(configDefault ?? floor),
    floor,
    member,
  );
}

// [LAW:one-source-of-truth] A named wrapper so the `"none"` floor is spelled once and
// the three call sites cannot disagree about it.
export function effectiveLookName(
  stagedLook: string | undefined,
  sessionLook: string | null,
  globalsLook: string | undefined,
  declaredLooks: Readonly<Record<string, ThemeKey>>,
): string {
  return effectiveMemberName(
    stagedLook,
    sessionLook,
    globalsLook,
    "none",
    declaredLooks,
  );
}

// [LAW:single-enforcer] The one place a look NAME becomes a ThemeKey; by here it must
// be a member. [LAW:no-defensive-null-guards] The throw is loud, never an identity fallback.
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

// [LAW:one-source-of-truth][LAW:types-are-the-program] `StripStyle` is DERIVED from
// this, so adding a shape forces a new `pickJoiner` arm at compile time.
export const STRIP_STYLES = ["powerline", "capsule", "plain"] as const;
export type StripStyle = (typeof STRIP_STYLES)[number];

// [LAW:types-are-the-program] The trust-boundary narrowing to the closed union.
export function isStripStyle(value: string): value is StripStyle {
  return (STRIP_STYLES as readonly string[]).includes(value);
}

// [LAW:one-type-per-behavior] The narrowing guard IS the parse, so a stale session
// entry is an ABSENT pick — it falls to the config default, not straight to the floor.
export function effectiveStripStyle(
  stagedStyle: StripStyle | undefined,
  sessionStyle: string | null,
  globalsStyle: StripStyle | undefined,
): StripStyle {
  return effectiveGlobal(
    stagedStyle,
    sessionStyle,
    globalsStyle,
    "powerline",
    (raw) => (isStripStyle(raw) ? raw : null),
  );
}

// [LAW:one-source-of-truth][LAW:types-are-the-program] Orthogonal to StripStyle:
// style picks the joiner SHAPE, charset the glyph VALUES. [config-only] No session
// half — charset describes the TERMINAL's font, not a taste. Same for the depths below.
export const CHARSETS = ["unicode", "ascii"] as const;
export type Charset = (typeof CHARSETS)[number];

// [LAW:one-source-of-truth][LAW:types-are-the-program] `satisfies` ties every member
// to rich-js's ColorSystemSpec without widening the derived union. Deliberately
// NARROWER: "auto" is out — the detached daemon would read the wrong terminal's env.
export const COLOR_COMPATIBILITIES = [
  "truecolor",
  "256",
  "ansi",
  "none",
] as const satisfies readonly ColorSystemSpec[];
export type ColorCompatibility = (typeof COLOR_COMPATIBILITIES)[number];

// autoWrap and padding DO have a session half: how much bar you want on screen right
// now is a taste that differs between a wide terminal and a split pane.
export const DEFAULT_WRAP = true;
// Renders unless a config opts out, durably, through the notice's own `[disable]`.
export const DEFAULT_UPDATE_NOTICE = true;

// [LAW:one-source-of-truth] The spelling of a boolean as a SessionState string, so a
// toggle cannot write a member the resolver refuses to parse. Named separately
// because cycle members are ordered default-state-first, which differs per control.
export const BOOLEAN_TRUE = "true";
export const BOOLEAN_FALSE = "false";
export const BOOLEAN_MEMBERS = [BOOLEAN_TRUE, BOOLEAN_FALSE] as const;

export const DEFAULT_PADDING = 1;

// [LAW:one-source-of-truth] THE padding domain, read by the loader's int spec, the
// stepper actions' min/max and the session parse alike — three copies could drift.
export const PADDING_RANGE = { min: 0, max: 16 } as const;

// [LAW:parse-dont-validate] `??` in effectiveGlobal (never `||`) keeps a parsed
// `false` a real answer. [LAW:one-source-of-truth] Every reader of a boolean session
// key parses HERE, never with its own truthiness rule.
export function parseSessionBoolean(raw: string): boolean | null {
  return raw === BOOLEAN_TRUE ? true : raw === BOOLEAN_FALSE ? false : null;
}

// [LAW:parse-dont-validate] The digits test comes first: `Number("")` is 0.
function parsePadding(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= PADDING_RANGE.min && value <= PADDING_RANGE.max
    ? value
    : null;
}

export function effectiveAutoWrap(
  stagedAutoWrap: boolean | undefined,
  sessionAutoWrap: string | null,
  globalsAutoWrap: boolean | undefined,
): boolean {
  return effectiveGlobal(
    stagedAutoWrap,
    sessionAutoWrap,
    globalsAutoWrap,
    DEFAULT_WRAP,
    parseSessionBoolean,
  );
}

// A value outside PADDING_RANGE is a stale entry, so it falls to the config default.
export function effectivePadding(
  stagedPadding: number | undefined,
  sessionPadding: string | null,
  globalsPadding: number | undefined,
): number {
  return effectiveGlobal(
    stagedPadding,
    sessionPadding,
    globalsPadding,
    DEFAULT_PADDING,
    parsePadding,
  );
}
