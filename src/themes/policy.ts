// [LAW:single-enforcer] The vocabulary and the resolution for every `globals`
// field a config can set or a click can pick: what values each field admits,
// what its floor is, and the one function that turns a session pick, a config
// default and that floor into the value a render actually uses.
//
// It sits in the themes module because theme/look/style were the first three
// fields to need it, and it is a LEAF: the config loader (validation, JSON
// schema) and the render layer both import it, which is what keeps a
// config↔render cycle from forming [LAW:one-way-deps].
//
// No color arithmetic lives here. cc-candybar selects theme NAMES and style
// IDENTIFIERS; every color *value* operation (hydrate hex, resolve specs,
// darken/contrast, hue/transpose) lives in rich-js, as does the semantic/anchor
// knowledge of which tokens keep their hue (ANCHORED_ROOTS).

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

// --- The one globals resolution ---

// [LAW:one-type-per-behavior] THE resolution every globals field a click can
// pick shares: the session's own value, over the config default, over a floor.
// Written once because the fields differ only in DATA — which floor, and how a
// raw SessionState string becomes a value of that field's type. Theme, look,
// preset, style, autoWrap and padding are all this function with different
// arguments, so the precedence order cannot land on one field and miss another.
//
// [LAW:dataflow-not-control-flow] The `??` chain IS the precedence; there is no
// "does this session have one" branch. A session that has never clicked passes
// null and lands on the config default by the same code path a session that
// clicked lands on its pick.
//
// [LAW:parse-dont-validate] `parseSession` is the boundary between an untyped
// SessionState string and this field's domain: it returns the typed value or
// null, and null means "no session pick" — indistinguishable, on purpose, from
// never having clicked. That is what makes a stale entry from a prior config's
// vocabulary (or a value a since-narrowed gate would now refuse) resolve to the
// default rather than throw or render something the label disagrees with
// [LAW:no-silent-failure] — the caller publishes what this returns as
// `<field>.effective`, so bar and label always trace to one value.
export function effectiveGlobal<T>(
  sessionPick: string | null,
  configDefault: T | null | undefined,
  floor: T,
  parseSession: (raw: string) => T | null,
): T {
  const picked = sessionPick === null ? null : parseSession(sessionPick);
  return picked ?? configDefault ?? floor;
}

// The theme name a render should use, as data.
// [LAW:one-source-of-truth] The single definition of "which theme is effective";
// every render derives basePalette through this, so the rendered palette can
// never disagree with the chosen theme. The theme domain is OPEN — registry
// names, aliases, and per-session sentinels all resolve downstream — so its
// parse is identity: there is no membership to check here, and pretending
// otherwise would collapse names `paletteForThemeName` handles fine.
export function effectiveThemeName(
  sessionTheme: string | null,
  globalsPalette: string | undefined,
): string {
  return effectiveGlobal(
    sessionTheme,
    globalsPalette,
    "textual-dark",
    (raw) => raw,
  );
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

// --- Per-config member selection ---

// The `effectiveGlobal` instance for every selection whose domain is PER-CONFIG
// (declared in the config, not a registry-static list). `looks` and `presets`
// are both exactly this — what differs between them is only the floor name and
// which map holds the members, i.e. DATA.
//
// The config default runs through the SAME membership parse the session pick
// does, one layer down: a `look:`/`preset:` naming a member the config no longer
// declares is no default at all, and collapses to the floor exactly as a stale
// session pick does. The loader cannot catch that for a per-config domain, so
// this resolution is where it is caught.
//
// The floor's membership is a load-time guarantee, not a runtime hope: the
// bundled stdlib ships it and merge-by-name cannot remove it.
export function effectiveMemberName(
  sessionPick: string | null,
  configDefault: string | undefined,
  floor: string,
  declared: Readonly<Record<string, unknown>>,
): string {
  const member = (raw: string): string | null =>
    Object.prototype.hasOwnProperty.call(declared, raw) ? raw : null;
  return effectiveGlobal(
    sessionPick,
    member(configDefault ?? floor),
    floor,
    member,
  );
}

// --- Look (theme-adaptation) identifiers ---

// [LAW:one-source-of-truth] The look domain's instance of the shared resolver
// above — the floor is `"none"`, the identity adaptation every merged config
// carries. A named wrapper (not a bare call at each site) so the floor is
// spelled once and the three call sites cannot disagree about it.
export function effectiveLookName(
  sessionLook: string | null,
  globalsLook: string | undefined,
  declaredLooks: Readonly<Record<string, ThemeKey>>,
): string {
  return effectiveMemberName(sessionLook, globalsLook, "none", declaredLooks);
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

// The strip style a render should use, as data.
// [LAW:one-type-per-behavior] `effectiveGlobal` over a closed registry-static
// vocabulary: the narrowing guard IS the parse, so a stale SessionState entry
// from a prior option vocabulary collapses to the floor. `pickJoiner` would
// render an unknown style as powerline anyway; parsing here keeps the returned
// TYPE honest rather than silently widening it.
export function effectiveStripStyle(
  sessionStyle: string | null,
  globalsStyle: StripStyle | undefined,
): StripStyle {
  return effectiveGlobal(sessionStyle, globalsStyle, "powerline", (raw) =>
    isStripStyle(raw) ? raw : null,
  );
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
// is the whole resolution. That is a decision, not a gap: charset describes the
// TERMINAL (does its font carry the powerline private-use glyphs), not a taste.
// It does not vary session-to-session on one machine, so a per-session override
// would be a knob whose only honest setting is the one already in the config.
// Same for COLOR_COMPATIBILITIES below.
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

// --- Layout globals (autoWrap, padding) ---
//
// These two DO have a session half, unlike charset/colorCompatibility above:
// wrapping and cell padding are how much bar you want on your screen right now
// — a taste that legitimately differs between one session in a wide terminal
// and another in a split pane. Their floors and domains live here, beside the
// other globals vocabularies, because both the config loader (range validation,
// JSON-schema emit) and the render layer need them and config must not import
// render [LAW:one-way-deps]. src/render/strip.ts re-exports them so render-layer
// callers keep their existing import site.

// [LAW:one-source-of-truth] The one statement of the globals.autoWrap default
// (on — current behavior).
export const DEFAULT_WRAP = true;

// [LAW:one-source-of-truth] The spelling of a boolean as a SessionState string.
// SessionState holds strings, so "true"/"false" is the wire vocabulary for every
// boolean globals field — the same two members the bundled default's
// `cycle: [...]` toggle writes and the parse below reads. Spelled once so a
// toggle cannot write a member the resolver refuses to parse.
export const BOOLEAN_MEMBERS = ["true", "false"] as const;

// [LAW:one-source-of-truth] The one statement of the globals.padding default
// (one space per side inside each segment cell — current behavior, matching the
// legacy display.padding).
export const DEFAULT_PADDING = 1;

// [LAW:one-source-of-truth] THE padding domain: an integer, inclusive both ends.
// Read by the loader's `padding` int spec (config-file values), by the bundled
// default's stepper actions (`min`/`max`, which bound what a click may persist),
// and by the session parse below. When those were three copies of `0`/`16`, a
// widened range could land on the file and miss the clicks.
export const PADDING_RANGE = { min: 0, max: 16 } as const;

// [LAW:parse-dont-validate] A SessionState string to a boolean, or null for
// anything else. `??` in effectiveGlobal (never `||`) is what keeps a parsed
// `false` a real answer rather than falling through to the default.
function parseBoolean(raw: string): boolean | null {
  return raw === "true" ? true : raw === "false" ? false : null;
}

// [LAW:parse-dont-validate] A SessionState string to a padding value inside the
// one declared range. The digits test comes first because `Number("")` is 0 and
// `Number(" 3 ")` is 3 — an empty or padded entry would otherwise parse to a
// value nobody wrote.
function parsePadding(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= PADDING_RANGE.min && value <= PADDING_RANGE.max
    ? value
    : null;
}

// Whether a render wraps over-wide rows, as data. The session's pick over the
// config default over the on floor — `effectiveGlobal` with a boolean domain.
export function effectiveAutoWrap(
  sessionAutoWrap: string | null,
  globalsAutoWrap: boolean | undefined,
): boolean {
  return effectiveGlobal(
    sessionAutoWrap,
    globalsAutoWrap,
    DEFAULT_WRAP,
    parseBoolean,
  );
}

// The intra-cell padding a render uses, as data. A session value outside
// PADDING_RANGE collapses to the config default the same way a stale style name
// collapses to powerline: the gate already refuses out-of-range clicks, so a
// value that gets here is a stale entry from a narrower-since range, and the
// default is the honest answer rather than a render at a width nobody chose.
export function effectivePadding(
  sessionPadding: string | null,
  globalsPadding: number | undefined,
): number {
  return effectiveGlobal(
    sessionPadding,
    globalsPadding,
    DEFAULT_PADDING,
    parsePadding,
  );
}
