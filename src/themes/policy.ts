// [LAW:single-enforcer] The vocabulary and the resolution for every `globals`
// field a config can set or a click can pick: what values each field admits,
// what its floor is, and the one function that turns a session pick, a config
// default and that floor into the value a render actually uses.
//
// It sits in the themes module because theme/style/endcaps were the first three
// fields to need it, and it is a LEAF: the config loader (validation, JSON
// schema) and the render layer both import it, which is what keeps a
// config↔render cycle from forming [LAW:one-way-deps].
//
// No color arithmetic lives here. cc-candybar selects theme NAMES and style
// IDENTIFIERS; every color *value* operation (hydrate hex, resolve specs,
// darken/contrast, hue/transpose) lives in rich-js, as does the semantic/anchor
// knowledge of which tokens keep their hue (ANCHORED_ROOTS).

import {
  ColorDepth,
  resolveColorSystem,
  IDENTITY,
  JOINERS,
  EFFECT_CATALOGUE,
  listThemePalettes,
  type LoopName,
  type ThemeKey,
} from "@promptctl/rich-js";
import {
  SHADES,
  TRIAL_SHADE_NAMES,
  TRIAL_VARIATION_NAMES,
  VARIATIONS,
  type ShadeName,
  type VariationName,
} from "./decor.js";

export { TRIAL_SHADE_NAMES, TRIAL_VARIATION_NAMES };

// [LAW:one-source-of-truth] Theme names the registry no longer installs: old
// name → the theme that replaced it. `dark`/`light` were second names for the
// textual palettes, and a second name put a step in every theme carousel that
// recoloured nothing (brandon-theme-picker-bgw.exj.dw1) — but the settings
// menu's own save could write them, so a file may still hold one. The loader
// refuses it [LAW:no-silent-failure], as does a `globals.palette` rule that
// renders one, and each refusal names the theme to write instead. A
// future retirement is one row here.
// A Map, not an object literal: an authored name is user data.
const RETIRED_THEMES: ReadonlyMap<string, string> = new Map([
  ["dark", "textual-dark"],
  ["light", "textual-light"],
]);

// The sentence appended to an unknown-theme refusal — empty for a name that
// was never installed, so every refusal site spells it the same way.
export function retiredThemeNote(name: unknown): string {
  const to = typeof name === "string" ? RETIRED_THEMES.get(name) : undefined;
  return to === undefined
    ? ""
    : ` — "${name as string}" was retired; write "${to}", the same palette`;
}

// [LAW:one-source-of-truth] The theme domain's floor: the palette a render wears
// when nothing above it decided. Spelled once because three things reach it — a
// config declaring no `palette`, a session pick naming nothing installed, and an
// EXPRESSION whose result names nothing (brandon-themes-dzl) — and, unlike the
// style's floor, it is a SPECIFIC theme rather than an identity, which is why the
// third of those reports itself (see `decideThemeName`).
export const THEME_FLOOR = "textual-dark";

// --- The one globals resolution ---

// [LAW:one-type-per-behavior] THE resolution every globals field a click can
// pick shares: the session's own value, over the config default, over a floor.
// Written once because the fields differ only in DATA — which floor, and how a
// raw SessionState string becomes a value of that field's type. Theme, style,
// preset, endcaps, autoWrap and padding are all this function with different
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

// [LAW:one-source-of-truth] The set of names that resolve to a concrete Palette
// is exactly the registry's names — no alias, so every name is its palette's
// own and a label always names the palette the bar wears. "custom" and "random" are
// deliberately absent: neither names a concrete palette (custom needs inline
// colors; random is a per-session sentinel). Config validators that gate a
// palette PULL (DSL `palette:` field) must reuse this, not re-derive it.
export function listResolvablePaletteNames(): readonly string[] {
  return listThemePalettes();
}

// [LAW:types-are-the-program] What a placement's `theme` setting may hold
// (brandon-settings-menu-6c5): the bar's own theme, or any installed one.
// "Follow the bar" is a MEMBER of the domain, not the absence of a value, so
// a placement always holds a theme and nothing downstream asks whether it has
// one. No installed theme is named `bar` (pinned in
// test/placement-theme.test.ts), so the two can never be confused.
export const FOLLOW_BAR = "bar";

export function placementThemeNames(): readonly string[] {
  return [FOLLOW_BAR, ...listResolvablePaletteNames()];
}

// Membership in `placementThemeNames`, which the render asks of every
// placement's `theme` each render. The installed themes are fixed for the
// life of the process, so the set is built once.
let placementThemeSet: ReadonlySet<string> | undefined;
export function isPlacementThemeName(name: string): boolean {
  placementThemeSet ??= new Set(placementThemeNames());
  return placementThemeSet.has(name);
}

// --- Per-config member selection ---

// The `effectiveGlobal` instance for every selection whose domain is PER-CONFIG
// (declared in the config, not a registry-static list). `styles` and `presets`
// are both exactly this — what differs between them is only the floor name and
// which map holds the members, i.e. DATA.
//
// The config default runs through the SAME membership parse the session pick
// does, one layer down: a `style:`/`preset:` naming a member the config no longer
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

// --- A globals field that may hold a NAME or a RULE ---

// [LAW:types-are-the-program] What a render was told about one globals field
// whose author may write either a name or a template, and the whole of it
// (brandon-looks-pe6 for `style`, brandon-themes-dzl for `palette`). Either the
// fold FINISHED before the render — a session pick, a staged fragment, or a
// plain NAME in that slot — and carries both the name a label displays and the
// VALUE that name denotes, or it did not, and carries the expression the render
// evaluates to finish it.
//
// The union is what keeps precedence structural rather than a matter of
// statement order: an expression can only ever occupy the `globals` rung, so
// when a higher rung decided there is no expression arm left to evaluate. An
// explicit session pick of the FLOOR name is therefore a decision that holds —
// which a "did it come out as the floor?" test would get wrong.
//
// [LAW:one-type-per-behavior] ONE type for both fields, because what differs
// between them is only DATA: what a settled name denotes (`T` — a style's
// ThemeKey, a theme's Palette) and the lookup that turns the name into it. The
// name and the value travel TOGETHER in the decided arm, out of ONE lookup, so a
// label and the thing it labels cannot disagree [LAW:one-source-of-truth].
export type Selection<T> =
  | { readonly kind: "decided"; readonly name: string; readonly value: T }
  | { readonly kind: "expression"; readonly source: string };

// The arm a render ends up holding, whichever way it got there. Named so the
// functions that RESOLVE a field can say so in their return type rather than
// handing back a union one arm of which they have just ruled out.
export type Decided<T> = Extract<Selection<T>, { kind: "decided" }>;

// The globals slots whose value may be a rule instead of a name, as data.
// [LAW:one-source-of-truth] registerDslConfig parses every slot named here
// eagerly, so this list IS the set whose expression a render can evaluate — a
// slot cannot be one the loader accepts and the render then cannot settle.
//
// `endcaps`/`autoWrap`/`padding` are deliberately absent, and the reason is a type
// rather than a preference: their result would need a parse into a non-name
// domain (a closed enum, a bool, a bounded int), which is a second variability
// this shape does not carry. A style, a theme and an effect each name a member
// of their own domain, which is why one shape serves all three.
export const EXPRESSION_SLOTS = ["style", "palette", "effect"] as const;
export type ExpressionSlot = (typeof EXPRESSION_SLOTS)[number];

// Shape-detection, the same way a template is told from a literal everywhere
// else in this config language: a declared NAME can never contain braces, so
// there is no ambiguity to resolve and no second declaration an author has to
// keep in sync with the value they wrote. ONE predicate for every slot and every
// reader — the loader's membership exemption, registerDslConfig's eager parse,
// and the resolution below — so no reader can be wider or narrower than another.
//
// [LAW:types-are-the-program] A type guard, not a bare boolean: the predicate
// already proves the value is present, so saying so in the signature deletes the
// non-null assertion every caller would otherwise write beside it.
export function isExpression(
  globalsValue: string | undefined,
): globalsValue is string {
  return globalsValue !== undefined && globalsValue.includes("{{");
}

// [LAW:one-type-per-behavior] THE fold for a name-or-rule field: the same rungs
// `effectiveMemberName` folds for every per-config domain — staged over session
// over config default over the floor — lifted into the `Selection` domain so
// that ONE rung may hold an expression instead of a name. The rungs' order and
// their membership parse are unchanged; the only new thing is what that one rung
// is allowed to hold, which is why this is not a second resolver beside the old
// one.
//
// The per-field variability is two arguments: the floor (already decided,
// because a floor that could fail would be no floor) and `named`, which turns a
// name from ANY rung into that field's value or reports that it names nothing.
export function resolveSelection<T>(
  stagedName: string | undefined,
  sessionPick: string | null,
  globalsValue: string | undefined,
  floor: Decided<T>,
  named: (raw: string) => Decided<T> | null,
): Selection<T> {
  // [LAW:dataflow-not-control-flow] The expression is a VALUE occupying the
  // config-default rung, so `effectiveGlobal`'s `??` chain enforces the
  // precedence — there is no "is there an expression?" branch anywhere deciding
  // whether the rungs above it are honoured.
  const configRung: Selection<T> | null = isExpression(globalsValue)
    ? { kind: "expression", source: globalsValue }
    : named(globalsValue ?? floor.name);
  return effectiveGlobal<Selection<T>>(
    stagedName === undefined ? null : named(stagedName),
    sessionPick,
    configRung,
    floor,
    named,
  );
}

// The value a render actually uses, whichever way the fold got there. Returns
// the selection ITSELF when it was already decided — identity, so the caller can
// tell "the fold finished here" from "it had already finished" without
// re-testing the discriminator [LAW:dataflow-not-control-flow].
//
// `settle` is TOTAL, and each field supplies its own: it evaluates the rule it
// is handed and decides the name — a style whose rule named nothing collapses to
// the identity adaptation in silence, a theme's collapses to a floor that is a
// SPECIFIC theme and must therefore say so, naming where that rule was written.
// That difference is a value passed in here, never an arm of this function.
export function finishSelection<T>(
  selected: Selection<T>,
  settle: (source: string) => Decided<T>,
): Decided<T> {
  return selected.kind === "decided" ? selected : settle(selected.source);
}

// --- Style (theme-adaptation) identifiers ---

// [LAW:one-source-of-truth] The style domain's floor: the name of the identity
// adaptation every merged config carries. Spelled once because three different
// things collapse to it — a stale session pick, a config default naming no
// declared style, and an EXPRESSION whose result names none (brandon-looks-pe6)
// — and they must all land on the same name.
export const STYLE_FLOOR = "none";

// The style instances of the two types above. A style's `value` is the ThemeKey
// the render transposes the base palette by.
export type StyleSelection = Selection<ThemeKey>;
export type DecidedStyle = Decided<ThemeKey>;

// One rung's contribution: the style this name selects, or null when it names no
// declared style — which is not a pick at all, so the fold moves on.
// [LAW:polishing-by-subtraction] The map lookup IS the membership test; asking
// `hasOwnProperty` first and then looking the key up would be the same question
// twice, and the second answer could only ever restate the first.
function namedStyle(
  name: string,
  declaredStyles: Readonly<Record<string, ThemeKey>>,
): DecidedStyle | null {
  const value = declaredStyles[name];
  return value === undefined ? null : { kind: "decided", name, value };
}

// [LAW:single-enforcer] The membership policy for a style NAME, wherever the name
// came from — a config default, a session pick, or an expression's RESULT. A
// declared style decides; anything else is the floor. This is the one place the
// forgiveness for an expression's result lives, and it is the same forgiveness a
// stale session pick has always had.
//
// Silent, unlike the theme's counterpart, and the asymmetry is the floor itself:
// this floor is the IDENTITY adaptation, so collapsing to it means the bar wears
// no style — a benign answer an author reading the bar can see. A theme's floor is
// a specific palette nobody asked for, which is why `decideThemeName` reports.
//
// The floor is looked up too, because `styles` merges BY NAME and a user may
// declare their own `none` — the floor is whatever this config says it is. Only
// a config declaring no `none` at all (no merge with the bundled stdlib: a
// compile-only caller) falls back to the identity key, which is what the stdlib
// would have declared anyway; the NAME reported is `STYLE_FLOOR` either way, so
// nothing downstream can tell the two apart or needs to.
export function decideStyleName(
  name: string,
  declaredStyles: Readonly<Record<string, ThemeKey>>,
): DecidedStyle {
  return (
    namedStyle(name, declaredStyles) ??
    namedStyle(STYLE_FLOOR, declaredStyles) ?? {
      kind: "decided",
      name: STYLE_FLOOR,
      value: IDENTITY,
    }
  );
}

// The style a render should use, as far as it can be known before the render runs
// [LAW:one-type-per-behavior] — `resolveSelection` with the style's own two
// values.
export function resolveStyleSelection(
  stagedStyle: string | undefined,
  sessionStyle: string | null,
  globalsStyle: string | undefined,
  declaredStyles: Readonly<Record<string, ThemeKey>>,
): StyleSelection {
  return resolveSelection(
    stagedStyle,
    sessionStyle,
    globalsStyle,
    decideStyleName(STYLE_FLOOR, declaredStyles),
    (raw) => namedStyle(raw, declaredStyles),
  );
}

// --- Effect identifiers ---

// [LAW:one-source-of-truth] The effect domain's floor: no effect, the identity.
// Like the style's, three things collapse to it — a stale session pick, a config
// default naming nothing, and a rule whose result names nothing — and they must
// all land on the same name.
export const EFFECT_FLOOR = "none";

// [LAW:one-source-of-truth] Each rule slot's floor, by slot: what a render draws
// when that slot's rule cannot be honoured. Keyed by every `ExpressionSlot`, so
// a new slot is a compile error here until it names its floor.
export const SLOT_FLOORS: Readonly<Record<ExpressionSlot, string>> = {
  style: STYLE_FLOOR,
  palette: THEME_FLOOR,
  effect: EFFECT_FLOOR,
};

// [LAW:one-source-of-truth] The one spelling of "this slot's rule could not be
// honoured": where the rule was written, the floor it wears instead, and why —
// a template that threw, or a palette result naming no installed theme.
export function ruleFloorMessage(
  where: string,
  slot: ExpressionSlot,
  why: string,
): string {
  return `${where} rendered "${SLOT_FLOORS[slot]}": ${why}`;
}

// [LAW:one-source-of-truth][LAW:types-are-the-program] The looping effects a bar
// can wear are rich-js's catalogue, by name: this list is the floor and the
// catalogue's keys, so a loop rich-js adds is offered by the loader, the settings
// control and the session gate with no edit here — as `ENDCAPS_SHAPES` is the
// keys of `JOINERS`.
export type EffectName = typeof EFFECT_FLOOR | LoopName;
export const EFFECT_NAMES: readonly EffectName[] = Object.freeze([
  EFFECT_FLOOR,
  ...(Object.keys(EFFECT_CATALOGUE.loops) as LoopName[]),
]);

// [LAW:one-source-of-truth] How fast the bar's animations run
// (brandon-menus-sjhy.nt2), by name: the keys are the `globals.animationSpeed`
// domain the loader, the settings control and the session gate admit, and each
// value is the rate the session's animation clock advances at against the wall
// clock.
export const ANIMATION_SPEEDS = Object.freeze({
  "1x": 1,
  "5x": 5,
  "10x": 10,
  "20x": 20,
});
export type AnimationSpeedName = keyof typeof ANIMATION_SPEEDS;
export const ANIMATION_SPEED_NAMES = Object.keys(
  ANIMATION_SPEEDS,
) as readonly AnimationSpeedName[];

// [LAW:types-are-the-program] What a placement's `effect` setting may hold
// (brandon-effects-2gka.bm1): the bar's own effect — `globals.effect` as the
// session resolves it, the setting's default — or any effect by name, `none`
// included, so a placement can stand still on a moving bar. Following the bar
// is a MEMBER, as it is for a placement's theme, and no catalogue loop is
// named `bar`.
export type PlacementEffect = typeof FOLLOW_BAR | EffectName;
export const PLACEMENT_EFFECTS: readonly PlacementEffect[] = Object.freeze([
  FOLLOW_BAR,
  ...EFFECT_NAMES,
]);

// An effect's selection carries its NAME as its value: what a settled name
// denotes is a catalogue entry made per row by the render (each row sits at its
// own place in the noise and keeps its own effect object across frames), so the
// name is the whole of what crosses here.
export type EffectSelection = Selection<EffectName>;
export type DecidedEffect = Decided<EffectName>;

function namedEffect(name: string): DecidedEffect | null {
  const value = EFFECT_NAMES.find((member) => member === name);
  return value === undefined ? null : { kind: "decided", name, value };
}

// [LAW:single-enforcer] The membership policy for an effect NAME, wherever it
// came from. Silent, as the style's is and for the same reason: the floor is the
// identity, so a rule that named nothing leaves a still bar, which is right.
export function decideEffectName(name: string): DecidedEffect {
  return (
    namedEffect(name) ?? {
      kind: "decided",
      name: EFFECT_FLOOR,
      value: EFFECT_FLOOR,
    }
  );
}

// The effect a render should wear, as far as it can be known before the render
// runs [LAW:one-type-per-behavior] — `resolveSelection` with the effect's own two
// values.
export function resolveEffectSelection(
  stagedEffect: string | undefined,
  sessionEffect: string | null,
  globalsEffect: string | undefined,
): EffectSelection {
  return resolveSelection(
    stagedEffect,
    sessionEffect,
    globalsEffect,
    decideEffectName(EFFECT_FLOOR),
    namedEffect,
  );
}

// --- Powerline strip-style identifiers ---

// [LAW:one-source-of-truth][LAW:types-are-the-program] The joiners a render can
// take are rich-js's bundled `JOINERS`, by name: rich-js owns what each one
// draws, and this list is its keys, so the picker's option domain, the
// SessionState validator, the `endcaps()` template binding and `pickJoiner`'s
// lookup all name exactly the joiners that exist — a joiner rich-js adds is
// offered with no edit here, and one it drops is a compile error wherever a
// name is spelled.
export const ENDCAPS_SHAPES = Object.freeze(
  Object.keys(JOINERS) as Array<keyof typeof JOINERS>,
);
export type Endcaps = (typeof ENDCAPS_SHAPES)[number];

// [LAW:types-are-the-program] The trust-boundary narrowing from a raw
// SessionState string (or a config default) to the closed `Endcaps` union.
export function isEndcaps(value: string): value is Endcaps {
  return (ENDCAPS_SHAPES as readonly string[]).includes(value);
}

// [LAW:one-source-of-truth] The endcaps `style` could hold before it was
// renamed (brandon-menu-ia-q30.xuz) — history, so not derived from the live
// joiner list, and typed `Endcaps` so a migration message never points at a
// shape that no longer exists. Only these names unambiguously mean "the old
// key": a joiner added since is a name a style may take.
const STYLE_ERA_ENDCAPS: readonly string[] = [
  "powerline",
  "capsule",
  "plain",
] satisfies readonly Endcaps[];
export function isStyleEraEndcaps(value: string): value is Endcaps {
  return STYLE_ERA_ENDCAPS.includes(value);
}

// --- Color-depth identifiers ---

// [LAW:one-source-of-truth][LAW:types-are-the-program] The single canonical set
// of color depths a config can pin (the legacy display.colorCompatibility).
// Same species as ENDCAPS_SHAPES: a closed render-vocabulary enum hosted in this leaf
// policy module so the config loader (validation + JSON-schema emit) and the
// render layer both derive from one literal without a config↔render cycle
// [LAW:one-way-deps]. Every member is a name rich-js's `resolveColorSystem`
// accepts; it takes a bare `string` and throws on a name it does not know, so
// test/option-domain.test.ts runs each member through it rather than the
// compiler holding the two vocabularies together.
//
// Deliberately NARROWER than rich-js's vocabulary: "auto" is excluded.
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
] as const;
export type ColorCompatibility = (typeof COLOR_COMPATIBILITIES)[number];

export function isColorCompatibility(
  value: string,
): value is ColorCompatibility {
  return (COLOR_COMPATIBILITIES as readonly string[]).includes(value);
}

// [LAW:one-source-of-truth] The depth a setting draws at, which is what a
// contrast floor has to be measured on (rich-js `ensureContrast`'s `drawnAt`):
// at 256 the terminal rounds text and background independently, so text chosen
// in truecolor is re-measured on the drawn pair. rich-js's `resolveColorSystem`
// is the mapping its SGR writer draws by, so the floor is measured at exactly
// the depth the bytes are written at; `none` draws no colour (null there), so
// no floor is measurable and DEFAULT says so.
export function drawnDepth(compatibility: ColorCompatibility): ColorDepth {
  return resolveColorSystem(compatibility) ?? ColorDepth.DEFAULT;
}

// --- Bar variation identifiers ---

// [LAW:one-source-of-truth] The names a `globals.variation` may hold — the
// keys of decor.ts's VARIATIONS table, so the loader's enum, the option
// domain and the session parse cannot admit a name the render has no
// variation for. Like `endcaps`, it is a taste that may differ between two
// sessions, so a session pick sits over the config default.
export const VARIATION_NAMES = Object.keys(
  VARIATIONS,
) as readonly VariationName[];

// --- Bar shade identifiers ---

// [LAW:one-source-of-truth] The names a `globals.shade` may hold — the keys of
// decor.ts's SHADES table, lowest position first, so the loader's enum, the
// option domain, the settings control and the session parse cannot admit a
// position the render has no shades for.
export const SHADE_NAMES = Object.keys(SHADES) as readonly ShadeName[];

// --- Layout globals (autoWrap, padding) ---
//
// Wrapping and cell padding are how much bar you want on your screen right now
// — a taste that legitimately differs between one session in a wide terminal
// and another in a split pane, so, unlike colorCompatibility above,
// each resolves a session pick over the config default. Their domains and the
// session parses over them live here, beside the other globals vocabularies,
// because both the config loader (range validation, JSON-schema emit) and the
// render layer need them and config must not import render
// [LAW:one-way-deps]; their floors are their rows'
// (src/config/globals-fields.ts).

// [LAW:one-source-of-truth] The spelling of a boolean as a SessionState string.
// SessionState holds strings, so "true"/"false" is the wire vocabulary for every
// boolean globals field — the same two members the bundled default's
// `cycle: [...]` toggle writes and the parse below reads. Spelled once so a
// toggle cannot write a member the resolver refuses to parse.
// [LAW:one-source-of-truth] The two members, named, because their ORDER is
// meaningful: a cycle's members are ordered default-state-first (an unwritten
// key counts as the first member and clicks to the second), so `autoWrap` — on
// by default — cycles ["true","false"], and a toggle that starts off would
// cycle [BOOLEAN_FALSE, BOOLEAN_TRUE].
export const BOOLEAN_TRUE = "true";
export const BOOLEAN_FALSE = "false";
export const BOOLEAN_MEMBERS = [BOOLEAN_TRUE, BOOLEAN_FALSE] as const;

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
// truthiness rule; a bespoke `raw !== ""` would accept values this parse
// rejects.
export function parseSessionBoolean(raw: string): boolean | null {
  return raw === BOOLEAN_TRUE ? true : raw === BOOLEAN_FALSE ? false : null;
}

// [LAW:parse-dont-validate] A SessionState string to an integer inside a
// range, or null. A session holds an integer in exactly the spelling
// `String(n)` writes, so that spelling is the test: `""`, `" 3"`, `"1e1"`,
// `"007"` and `"-0"` all coerce to numbers nobody wrote and are refused.
//
// [LAW:one-source-of-truth] Every reader of an integer session value parses it
// here — the padding pick, a placement's range setting, and the loader's
// check of what a `set` may write — so the three cannot admit different
// strings.
export function parseSessionInt(
  raw: string,
  range: { readonly min: number; readonly max: number },
): number | null {
  const value = Number(raw);
  return Number.isInteger(value) &&
    String(value) === raw &&
    value >= range.min &&
    value <= range.max
    ? value
    : null;
}
