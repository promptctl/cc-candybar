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

import { IDENTITY, listThemePalettes, type ThemeKey } from "@promptctl/rich-js";
import type { ColorSystemSpec } from "@promptctl/rich-js/widgets";

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
//
// [LAW:one-source-of-truth] `staged` is the RIGHTMOST rung of the precedence
// chain documented in src/config/presets.ts — a fragment some transient MODE of
// the bar puts on top while it is on (today: edit mode's `editGlobals`). It
// outranks even the session pick because it is decided LATER: a user picks a
// style, then afterwards enters edit mode. That is the same lifetime rule that
// forced the preset's own position, applied one rung further along, which is
// why it is a parameter of THIS function rather than a check at any call site —
// a chain with a rung missing from one field is exactly the drift a single
// resolver exists to prevent.
//
// [LAW:dataflow-not-control-flow] Absent ⇒ `undefined`, which the `??` chain
// skips by the same code path a session that never clicked skips its own rung.
// There is no "is edit mode on" branch anywhere below this line; the mode is
// carried entirely by whether this argument has a value.
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

// The theme name a render should use, as data.
// [LAW:one-source-of-truth] The single definition of "which theme is effective";
// every render derives basePalette through this, so the rendered palette can
// never disagree with the chosen theme. The theme domain is OPEN — registry
// names, aliases, and per-session sentinels all resolve downstream — so its
// parse is identity: there is no membership to check here, and pretending
// otherwise would collapse names `paletteForThemeName` handles fine.
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
//
// The staged rung runs through the SAME membership parse the other two do: a
// fragment naming a member the config does not declare is no more a pick than a
// stale session entry is, and collapses one rung onward rather than throwing.
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

// --- Look (theme-adaptation) identifiers ---

// [LAW:one-source-of-truth] The look domain's floor: the name of the identity
// adaptation every merged config carries. Spelled once because three different
// things collapse to it — a stale session pick, a config default naming no
// declared look, and an EXPRESSION whose result names none (brandon-looks-pe6)
// — and they must all land on the same name.
export const LOOK_FLOOR = "none";

// [LAW:types-are-the-program] What a render was told about its look, and the
// whole of it (brandon-looks-pe6). Either the fold FINISHED before the render —
// a session pick, a staged fragment, or a plain name in `globals.look` — and
// carries both the name a label displays and the key the palette transposes by,
// or it did not, and carries the expression the render evaluates to finish it.
//
// The union is what keeps the ticket's precedence requirement structural rather
// than a matter of statement order: an expression can only ever occupy the
// `globals` rung, so when a higher rung decided there is no expression arm left
// to evaluate. An explicit session pick of the FLOOR name is therefore a
// decision that holds — which a "did it come out as the floor?" test would get
// wrong.
export type LookSelection =
  | { readonly kind: "decided"; readonly name: string; readonly key: ThemeKey }
  | { readonly kind: "expression"; readonly source: string };

// The arm a render ends up holding, whichever way it got there. Named so the
// functions that RESOLVE a look can say so in their return type rather than
// handing back a union one arm of which they have just ruled out.
export type DecidedLook = Extract<LookSelection, { kind: "decided" }>;

// Shape-detection, the same way a template is told from a literal everywhere
// else in this config language: a declared look NAME can never contain braces,
// so there is no ambiguity to resolve and no second declaration an author has to
// keep in sync with the value they wrote.
export function isLookExpression(globalsLook: string | undefined): boolean {
  return globalsLook !== undefined && globalsLook.includes("{{");
}

// One rung's contribution: the look this name selects, or null when it names no
// declared look — which is not a pick at all, so the fold moves on.
// [LAW:polishing-by-subtraction] The map lookup IS the membership test; asking
// `hasOwnProperty` first and then looking the key up would be the same question
// twice, and the second answer could only ever restate the first.
function namedLook(
  name: string,
  declaredLooks: Readonly<Record<string, ThemeKey>>,
): DecidedLook | null {
  const key = declaredLooks[name];
  return key === undefined ? null : { kind: "decided", name, key };
}

// [LAW:single-enforcer] The membership policy for a look NAME, wherever the name
// came from — a config default, a session pick, or an expression's RESULT. A
// declared look decides; anything else is the floor. This is the one place the
// forgiveness the ticket asks for an expression's result lives, and it is the
// same forgiveness a stale session pick has always had.
//
// The floor is looked up too, because `looks` merges BY NAME and a user may
// declare their own `none` — the floor is whatever this config says it is. Only
// a config declaring no `none` at all (no merge with the bundled stdlib: a
// compile-only caller) falls back to the identity key, which is what the stdlib
// would have declared anyway; the NAME reported is `LOOK_FLOOR` either way, so
// nothing downstream can tell the two apart or needs to.
export function decideLookName(
  name: string,
  declaredLooks: Readonly<Record<string, ThemeKey>>,
): DecidedLook {
  return (
    namedLook(name, declaredLooks) ??
    namedLook(LOOK_FLOOR, declaredLooks) ?? {
      kind: "decided",
      name: LOOK_FLOOR,
      key: IDENTITY,
    }
  );
}

// The look a render should use, as far as it can be known before the render runs.
//
// [LAW:one-type-per-behavior] ONE fold over the same rungs `effectiveMemberName`
// folds for every per-config domain — staged over session over config default
// over the floor — lifted into the `LookSelection` domain so that ONE rung may
// hold an expression instead of a name. The rungs' order and their membership
// parse are unchanged; the only new thing is what that one rung is allowed to
// hold, which is why this is not a second resolver beside the old one.
export function resolveLookSelection(
  stagedLook: string | undefined,
  sessionLook: string | null,
  globalsLook: string | undefined,
  declaredLooks: Readonly<Record<string, ThemeKey>>,
): LookSelection {
  const named = (raw: string): LookSelection | null =>
    namedLook(raw, declaredLooks);
  // [LAW:dataflow-not-control-flow] The expression is a VALUE occupying the
  // config-default rung, so `effectiveGlobal`'s `??` chain enforces the
  // precedence — there is no "is there an expression?" branch anywhere deciding
  // whether the rungs above it are honoured.
  const configRung: LookSelection | null = isLookExpression(globalsLook)
    ? { kind: "expression", source: globalsLook! }
    : named(globalsLook ?? LOOK_FLOOR);
  return effectiveGlobal<LookSelection>(
    stagedLook === undefined ? null : named(stagedLook),
    sessionLook,
    configRung,
    decideLookName(LOOK_FLOOR, declaredLooks),
    named,
  );
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
// vocabulary: the narrowing guard IS the parse. `pickJoiner` would render an
// unknown style as powerline anyway; parsing here keeps the returned TYPE
// honest rather than silently widening it.
//
// A stale SessionState entry (a member of a prior option vocabulary) is an
// ABSENT session pick, not a pick of the floor: it falls through to the config
// default, and only reaches "powerline" when the config declares no style
// either. That is a deliberate change from the pre-`effectiveGlobal` spelling,
// which collapsed straight to the floor and skipped the user's own declared
// default — a config saying `style: "capsule"` deserves capsule when a session
// entry goes stale, not powerline. Every field here now shares that one rule
// [LAW:one-source-of-truth]; test/session-globals.test.ts pins it with a stale
// pick over a valid non-floor default, the case the old tests never exercised.
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
// The update notice renders unless a config says otherwise: a developer
// running a stale checkout, or a user on a superseded release, is told so
// by default and opts OUT durably through the notice's own `[disable]`.
export const DEFAULT_UPDATE_NOTICE = true;

// [LAW:one-source-of-truth] The spelling of a boolean as a SessionState string.
// SessionState holds strings, so "true"/"false" is the wire vocabulary for every
// boolean globals field — the same two members the bundled default's
// `cycle: [...]` toggle writes and the parse below reads. Spelled once so a
// toggle cannot write a member the resolver refuses to parse.
// [LAW:one-source-of-truth] The two members, named, because their ORDER is
// meaningful and differs per control: a cycle's members are ordered
// default-state-first (an unwritten key counts as the first member and clicks
// to the second), so `autoWrap` — on by default — cycles ["true","false"]
// while `persist?` — off by default — cycles [BOOLEAN_FALSE, BOOLEAN_TRUE].
// Spelling the members rather than reversing the pair keeps each declaration's
// default state readable at its own site.
export const BOOLEAN_TRUE = "true";
export const BOOLEAN_FALSE = "false";
export const BOOLEAN_MEMBERS = [BOOLEAN_TRUE, BOOLEAN_FALSE] as const;

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
//
// [LAW:one-source-of-truth] Exported because SessionState holds strings and
// BOOLEAN_MEMBERS above is the one spelling of a boolean in that store — so
// every reader of a boolean session key parses it HERE, not with its own
// truthiness rule. The second reader is the dual-destination action's
// `persistWhen` selector (src/render/action.ts): "is persist? checked" is the
// same question `autoWrap`'s toggle asks of its own key, and a bespoke
// `raw !== ""` there would accept values this parse rejects.
export function parseSessionBoolean(raw: string): boolean | null {
  return raw === BOOLEAN_TRUE ? true : raw === BOOLEAN_FALSE ? false : null;
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

// The intra-cell padding a render uses, as data. A session value outside
// PADDING_RANGE falls through to the config default, the same rule every other
// field here follows: the gate already refuses out-of-range clicks, so a value
// that gets here is a stale entry from a narrower-since range, and the user's
// own default is the honest answer rather than a render at a width nobody
// chose.
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
