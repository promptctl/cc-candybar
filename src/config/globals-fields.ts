// [LAW:one-source-of-truth][LAW:locality-or-seam] THE declaration of every
// `globals` field (candybar-theme-colours-6fq5.11l): one row each, saying what
// differs about it — how the loader reads it, the values a control ranges, its
// floor, and, for a setting the bar offers a control for, its label, the place
// in the settings menu it sits and what its list previews. Everything that
// carries a field derives from its row: the `Globals` type (dsl-types.ts), the
// loader's schema (loader/globals.ts), the resolution and `EffectiveGlobals`
// (effective-globals.ts), the settings table (setting-projections.ts) and the
// menu's places, the payload's `.effective` fields and the inputs that read
// them, the named option domains, a persist write's JSON5 spelling and a
// draft's session spelling. Adding a setting is a row here, the code that
// consumes its value, and its own tests.
//
// [LAW:types-are-the-program] A row is discriminated by how the field
// resolves, which is the one thing about a field its carriers branch on:
// - `text`: free text no control shape fits, read by its consumer from the
//   config alone;
// - `config`: a value the config file alone sets (no session pick), resolved
//   staged › config › floor and published as `<field>.effective`;
// - `session`: a setting the bar controls, resolved staged › session pick ›
//   config › floor through the one generic fold;
// - `selection`: a setting whose domain is per-config or whose config rung may
//   hold a rule (theme, style, effect, preset) — each has a fold of its own in
//   resolveEffectiveGlobals, and this row carries the rest of what it is.
//
// [LAW:one-way-deps] It sits below everything that derives from it: it imports
// the loader's spec builders and the themes vocabulary, and only types from the
// menu and the control generator.

import {
  ANIMATION_SPEED_NAMES,
  COLOR_COMPATIBILITIES,
  EFFECT_NAMES,
  ENDCAPS_SHAPES,
  PADDING_RANGE,
  SHADE_NAMES,
  TRIAL_SHADE_NAMES,
  TRIAL_VARIATION_NAMES,
  VARIATION_NAMES,
  isExpression,
  parseSessionBoolean,
  parseSessionInt,
  type ColorCompatibility,
} from "../themes/policy.js";
import {
  optionalBooleanSpec,
  optionalEnum,
  optionalEnumSpec,
  optionalIntSpec,
  optionalStringField,
  optionalStringSpec,
  validatePaletteName,
  type FieldSpec,
} from "./loader/validate-core.js";
import { findKeyLine } from "./loader/diagnostics.js";
import { DISCLOSURE_GLYPH_CLOSE, DOOR_CLOSE_GLYPH } from "./disclosure.js";
import {
  IN_TMUX,
  LANES,
  RENDERERS,
  TOGGLED_LANES,
  type LaneSetting,
  type Renderer,
  type ToggledLane,
} from "./lanes.js";
import type { DomainLibrary, OptionLabel } from "./option-domain.js";
import type { ControlDomain } from "./setting-control.js";
import type { SettingRange } from "./dsl-types.js";
import { MENU_TIMEOUT_DEFAULT, MENU_TIMEOUT_RANGE } from "./menu-timeout.js";
import type { Place, PreviewName } from "./menu-places.js";

// ─── What a row says ─────────────────────────────────────────────────────────

// How a setting the bar controls is shown in the settings menu: what its
// control is called, where it sits, and the rows hung under its list of
// options while that list is open, each showing what the option in force does
// to the bar.
export interface Control {
  readonly label: string;
  readonly place: Place;
  readonly previews: readonly PreviewName[];
  // A template expression, true in the sessions the control is offered to:
  // `true` for one every session may turn, or a session fact such as being
  // inside tmux for a setting only such a session can act on.
  // [LAW:dataflow-not-control-flow] Every control carries one, so the menu
  // gates each the same way and none is a special case.
  readonly shown: string;
}

// The values a session-resolved field ranges, one arm per primitive: a flag, a
// bounded integer, or a closed list of words. A per-config or theme domain is a
// `selection`'s, so it is not representable here.
type ValueDomain<T> = [T] extends [boolean]
  ? "bool"
  : [T] extends [number]
    ? SettingRange
    : { readonly from: readonly T[] };

export interface NamedDomain {
  readonly name: string;
  readonly members: readonly string[];
  // A catalogue's groups and a line per member, when its picker lays it out
  // as one described row per option (option-domain.ts).
  readonly library?: DomainLibrary;
  readonly labelOf?: OptionLabel;
}

interface Valued<T> {
  readonly spec: FieldSpec<T>;
  readonly domain: ValueDomain<T>;
  // What renders when no rung above decides.
  readonly floor: T;
  // [LAW:parse-dont-validate] A SessionState string to this field's value, or
  // null for one it does not admit — a stale entry falls through to the
  // config's own value. Built from `domain` by the row constructors below, so
  // a pick is admitted by exactly the members the loader accepts.
  readonly parse: (raw: string) => T | null;
  // The domain under the name an author's `from:` may give it (`"shades"`),
  // registered by option-domain.ts. Absent for a domain no author needs by
  // name.
  readonly optionDomain?: NamedDomain;
}

export interface TextRow<T> {
  readonly kind: "text";
  readonly spec: FieldSpec<T>;
}
export interface ConfigRow<T> extends Valued<T> {
  readonly kind: "config";
}
export interface SessionRow<T, D extends boolean = boolean> extends Valued<T> {
  readonly kind: "session";
  readonly control: Control;
  // Whether a theme's default look may carry it (themeDefaults:, ix8).
  readonly themeDefault: D;
}
export interface SelectionRow<
  S extends string = string,
  D extends boolean = boolean,
> {
  readonly kind: "selection";
  // The SessionState key a pick writes, which is also the setting's name —
  // the field's own name unless history made them differ (`palette` is
  // `theme` in the session).
  readonly sessionKey: S;
  readonly spec: FieldSpec<string>;
  readonly domain: ControlDomain;
  readonly control: Control;
  readonly themeDefault: D;
}

export type FieldRow =
  | TextRow<string>
  | ConfigRow<string>
  | SessionRow<string>
  | SessionRow<number>
  | SessionRow<boolean>
  | SelectionRow;

// ─── Row constructors: each builds the loader's spec, the control's domain and
// the session parse from ONE literal, so the three cannot admit different
// values ──────────────────────────────────────────────────────────────────────

const control = (
  label: string,
  place: Place,
  {
    previews = [],
    shown = "true",
  }: Partial<Pick<Control, "previews" | "shown">> = {},
): Control => ({ label, place, previews, shown });

const enumValues = <T extends string>(
  members: readonly T[],
  optionDomain?: string,
  facets: Pick<NamedDomain, "library" | "labelOf"> = {},
) => ({
  spec: optionalEnumSpec(members),
  domain: { from: members } as ValueDomain<T>,
  parse: (raw: string): T | null =>
    (members as readonly string[]).includes(raw) ? (raw as T) : null,
  ...(optionDomain !== undefined && {
    optionDomain: {
      name: optionDomain,
      members,
      ...facets,
    },
  }),
});

// A member still on trial shows marked 🧪, in every list of its domain.
const markTrials =
  (trials: readonly string[]): OptionLabel =>
  (option) =>
    trials.includes(option) ? `🧪 ${option}` : option;

const boolValues = {
  spec: optionalBooleanSpec(),
  domain: "bool" as const,
  parse: parseSessionBoolean,
};

const intValues = (range: SettingRange) => ({
  spec: optionalIntSpec(range),
  domain: range,
  parse: (raw: string): number | null => parseSessionInt(raw, range),
});

function enumSetting<T extends string, const D extends boolean = false>(
  members: readonly T[],
  floor: NoInfer<T>,
  shown: Control,
  extra: {
    readonly optionDomain?: string;
    readonly library?: DomainLibrary;
    readonly labelOf?: OptionLabel;
    readonly themeDefault?: D;
  } = {},
): SessionRow<T, D> {
  return {
    kind: "session",
    ...enumValues(members, extra.optionDomain, {
      library: extra.library,
      labelOf: extra.labelOf,
    }),
    floor,
    control: shown,
    themeDefault: (extra.themeDefault ?? false) as D,
  };
}

function boolSetting(
  floor: boolean,
  shown: Control,
): SessionRow<boolean, false> {
  return {
    kind: "session",
    ...boolValues,
    floor,
    control: shown,
    themeDefault: false,
  };
}

function intSetting(
  range: SettingRange,
  floor: number,
  shown: Control,
): SessionRow<number, false> {
  return {
    kind: "session",
    ...intValues(range),
    floor,
    control: shown,
    themeDefault: false,
  };
}

function selection<const S extends string, const D extends boolean = false>(
  sessionKey: S,
  spec: FieldSpec<string>,
  domain: ControlDomain,
  shown: Control,
  extra: { readonly themeDefault?: D } = {},
): SelectionRow<S, D> {
  return {
    kind: "selection",
    sessionKey,
    spec,
    domain,
    control: shown,
    themeDefault: (extra.themeDefault ?? false) as D,
  };
}

const text = (spec: FieldSpec<string>): TextRow<string> => ({
  kind: "text",
  spec,
});

// ─── The specs a row needs beyond the shared builders ───────────────────────

// [LAW:types-are-the-program] Closed enum like `endcaps`, plus one
// migration-pointing rejection: "auto" was the LEGACY default, so migrating
// configs will carry it — but the daemon runs detached, so rich-js env
// detection would downsample against the daemon's terminal, not the client's.
// Rather than ship that silent lie [LAW:no-silent-failure], "auto" is outside
// the ColorCompatibility domain and gets an error that says why. The json emit
// and the membership check derive from the same COLOR_COMPATIBILITIES literal.
const colorCompatibilitySpec: FieldSpec<ColorCompatibility> = {
  required: false,
  json: { enum: [...COLOR_COMPATIBILITIES] },
  parse: (ctx, path, field, raw) => {
    if (raw[field] === "auto") {
      ctx.issues.push({
        path: `${path}.${field}`,
        message:
          `${path}.${field}: "auto" is not supported — the render daemon runs detached, ` +
          `so terminal detection would read the daemon's environment, not your terminal's. ` +
          `Pick an explicit depth: ${COLOR_COMPATIBILITIES.join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), field]),
      });
      return undefined;
    }
    return optionalEnum(ctx, path, raw, field, COLOR_COMPATIBILITIES);
  },
};

// [LAW:types-are-the-program] `globals.palette` admits a NAME or a RULE
// (brandon-themes-dzl). A template there names no theme — it names how to choose
// one per render — so there is nothing for the name check to check; its own
// well-formedness is checked where every other template's is (parsed eagerly by
// registerDslConfig, so a malformed one is still a LOAD error), and its result
// gets the forgiveness `decideThemeName` owns.
//
// [LAW:one-type-per-behavior] A spec of its own rather than a flag on the shared
// `paletteSpec`, because the two slots genuinely differ in behaviour: a
// segment's `palette:` is the default of its placements' `theme` setting, whose
// domain holds theme NAMES, so a rule there must stay a load error. Both reach
// the one `validatePaletteName`, so the name policy itself cannot drift.
//
// [LAW:dataflow-not-control-flow] The exemption reads the SAME `isExpression`
// the eager parse and the render's fold read, so the loader cannot accept a
// shape the render declines to evaluate, nor reject one it would have settled.
const paletteOrRuleSpec: FieldSpec<string> = {
  required: false,
  // Shape-only, exactly as `paletteSpec`'s schema facet is: the allowed names
  // are resolved at load from installed palettes, and a rule is a string too.
  json: { type: "string" },
  parse: (ctx, path, field, raw) => {
    const v = optionalStringField(ctx, path, raw, field);
    return isExpression(v) ? v : validatePaletteName(ctx, path, raw);
  },
};

// [LAW:types-are-the-program] `globals.effect` admits a NAME of the closed
// effect domain or a RULE, `globals.palette`'s two shapes over an enum: a name
// is checked by membership here, a rule is parsed eagerly by registerDslConfig
// and its result gets the forgiveness `decideEffectName` owns.
const effectOrRuleSpec: FieldSpec<string> = {
  required: false,
  json: {
    anyOf: [{ enum: [...EFFECT_NAMES] }, { type: "string", pattern: "\\{\\{" }],
  },
  parse: (ctx, path, field, raw) => {
    const v = raw[field];
    return typeof v === "string" && isExpression(v)
      ? v
      : optionalEnum(ctx, path, raw, field, EFFECT_NAMES);
  },
};

const MENU_GLYPH = /^[^\r\n]*\S[^\r\n]*$/u;
const CLOSE_GLYPH = new RegExp(
  `^(?:${DOOR_CLOSE_GLYPH}|${DISCLOSURE_GLYPH_CLOSE})[\\uFE0E\\uFE0F]?$`,
  "u",
);

const menuGlyphSpec: FieldSpec<string> = {
  required: false,
  json: {
    type: "string",
    pattern: MENU_GLYPH.source,
    not: { pattern: CLOSE_GLYPH.source },
  },
  parse: (ctx, path, field, raw) => {
    const v = optionalStringField(ctx, path, raw, field);
    if (v === undefined || (MENU_GLYPH.test(v) && !CLOSE_GLYPH.test(v)))
      return v;
    ctx.issues.push({
      path: `${path}.${field}`,
      message: `${path}.${field}: must be one line of visible text other than a close glyph ("${DOOR_CLOSE_GLYPH}", "${DISCLOSURE_GLYPH_CLOSE}") — the settings menu needs a glyph to click`,
      line: findKeyLine(ctx.source, [...path.split("."), field]),
    });
    return undefined;
  },
};

// ─── The rows ────────────────────────────────────────────────────────────────

// The experimental lanes' toggles (LANES, src/config/lanes.ts): each such
// lane's setting is a flag, off until a config or a session turns it on,
// behind the `🧪 toggles` submenu.
const LANE_ROWS = Object.fromEntries(
  TOGGLED_LANES.map((lane: ToggledLane) => [
    LANES[lane].switch.setting,
    boolSetting(false, control(LANES[lane].label, "toggles")),
  ]),
) as { readonly [K in LaneSetting]: SessionRow<boolean, false> };

// What each renderer's row says in the open renderer menu, laid out as the
// add-segment menu lays its library: one aligned row per option.
const RENDERER_DESCRIPTIONS: Readonly<Record<Renderer, string>> = {
  claude: "Claude Code's status line",
  tmux: "the tmux status line, while this pane is shown",
};
const RENDERER_LIBRARY: DomainLibrary = {
  groups: [{ id: "renderer", label: "draw the bar in" }],
  entry: (option) => ({
    group: "renderer",
    description: RENDERER_DESCRIPTIONS[option as Renderer],
  }),
};

// Row order is the order the settings carry everywhere they are listed — the
// menu's controls within a place, the drafts a save writes, the schema's keys.
export const GLOBAL_FIELDS = {
  // The config default for the base theme: a theme NAME, or a rule choosing
  // one per render (brandon-themes-dzl). A placement's `theme` setting other
  // than `bar` ignores it.
  palette: selection(
    "theme",
    paletteOrRuleSpec,
    { themes: "themes" },
    control("🎨 theme", "door"),
  ),
  // The config default for the PRESET — a named fragment from `presets:`
  // whose globals and root the session renders. Membership in the merged
  // `presets` map is cross-ref's. [LAW:one-source-of-truth] A preset's own
  // globals may NOT carry it: a
  // preset selecting a preset is a second, cyclic authority over which is
  // active. Its control sits on the door's first line, one click away:
  // switching arrangement is what people open the menu for.
  preset: selection(
    "preset",
    optionalStringSpec(),
    { from: "presets" },
    control("▦ preset", "door", { previews: ["layout", "presetDelete"] }),
  ),
  // The config default for the STYLE (a named theme adaptation from
  // `styles:`), or a rule choosing one by data (brandon-looks-pe6).
  // Membership in the merged `styles` map is cross-ref's, which exempts a rule.
  style: selection(
    "style",
    optionalStringSpec(),
    { from: "styles" },
    control("◐ style", "gear", { previews: ["palette"] }),
    { themeDefault: true },
  ),
  // The looping EFFECT the whole bar wears (brandon-effects-2gka.d2i): `none`
  // or a rich-js catalogue loop name, or a rule rendering one.
  effect: selection(
    "effect",
    effectOrRuleSpec,
    { from: EFFECT_NAMES },
    control("✨ effect", "look"),
  ),
  // The powerline cap/separator SHAPE — one of rich-js's bundled joiners.
  endcaps: enumSetting(
    ENDCAPS_SHAPES,
    "powerline",
    control("✦ endcaps", "look"),
    {
      optionDomain: "endcaps",
    },
  ),
  // Which theme role each ROW of the closed bar wears, in order — a named
  // entry of VARIATIONS (src/themes/decor.ts): rows in `secondary`, then
  // `accent` by default (brandon-theme-picker-bgw.7g6).
  variation: enumSetting(
    VARIATION_NAMES,
    "accent",
    control("🎼 variation", "gear", {
      previews: ["layout"],
    }),
    {
      optionDomain: "variations",
      labelOf: markTrials(TRIAL_VARIATION_NAMES),
      themeDefault: true,
    },
  ),
  // Which of its role's shades each CELL of the closed bar wears — a named
  // position of the shade dial, SHADES (src/themes/decor.ts): a window of the
  // role's darkenings and lightenings, or its muted form. The default is the
  // window centred on each role's own colour — "the default will be 'middle'
  // (standard role)" (candybar-theme-colours-6fq5.e5n).
  shade: enumSetting(
    SHADE_NAMES,
    "middle",
    control("🔆 shade", "gear", {
      previews: ["layout"],
    }),
    {
      optionDomain: "shades",
      labelOf: markTrials(TRIAL_SHADE_NAMES),
      themeDefault: true,
    },
  ),
  // Whether a placement that appears mid-session fades in over 20 s
  // (brandon-effects-2gka.631) and one that leaves dissolves out over 30 s
  // (brandon-effects-2gka.3vt). Off: a bloom is a look somebody chooses.
  transitions: boolSetting(false, control("fade in/out", "look")),
  // How fast every decorative animation runs — the effects above, fades and
  // dissolves, and a template's `frames`/`stepped` (brandon-menus-sjhy.nt2):
  // the rate the session's animation clock advances against the wall clock
  // (`ANIMATION_SPEEDS`, src/render/effect.ts `SessionEffects.clockAt`).
  animationSpeed: enumSetting(
    ANIMATION_SPEED_NAMES,
    "1x",
    control("speed", "look"),
  ),
  // Whether FlexStrip soft-wraps a root row that exceeds the usable width
  // (the legacy display.autoWrap). False renders each row as one unbounded
  // line, overflow off-screen.
  autoWrap: boolSetting(true, control("wrap", "config")),
  // Spaces synthesized INSIDE each segment cell per side (intra-cell, within
  // the bg fill — the legacy display.padding). Templates author content; this
  // chrome is applied structurally at the cell-formation seam. Bounded above
  // so a config value can never drive an unbounded `" ".repeat` in the daemon
  // [LAW:no-silent-failure] — the file, the click and the session pick all
  // honour PADDING_RANGE.
  padding: intSetting(
    { ...PADDING_RANGE, step: 1 },
    1,
    control("padding", "config"),
  ),
  // Whether the daemon renders its update notice — the row saying newer source
  // or a newer release exists than the code rendering the bar
  // (src/daemon/update-notice.ts). The notice's own `[disable]` writes `false`
  // here; a per-session, per-version dismissal lives in SessionState instead.
  updateNotice: boolSetting(true, control("update notice", "config")),
  // Seconds without a click before every open menu flashes and closes
  // (src/config/menu-timeout.ts, src/daemon/menu-idle.ts).
  menuTimeout: intSetting(
    MENU_TIMEOUT_RANGE,
    MENU_TIMEOUT_DEFAULT,
    control("menu timeout", "config"),
  ),
  // Where the bar is drawn (RENDERERS, src/config/lanes.ts). Offered only to a
  // session inside tmux: outside it, `claude` is the one renderer there is,
  // and a session there draws in Claude Code's status line whatever this
  // says, leaving the setting the sessions share as it is.
  renderer: enumSetting(
    RENDERERS,
    "claude",
    control("renderer", "config", { shown: IN_TMUX }),
    { optionDomain: "renderers", library: RENDERER_LIBRARY },
  ),
  ...LANE_ROWS,
  // The color depth rich-js downsamples output to (the legacy
  // display.colorCompatibility) — truecolor by default, deliberately NOT the
  // legacy "auto", which the detached daemon cannot honour (see
  // COLOR_COMPATIBILITIES). Set in the config file only: Brandon cut the
  // control (brandon-menu-ia-q30.5y4).
  colorCompatibility: {
    kind: "config",
    ...enumValues(COLOR_COMPATIBILITIES, "colorCompatibilities"),
    // Its own spec only for the migration-pointing "auto" refusal above.
    spec: colorCompatibilitySpec,
    floor: "truecolor",
  } satisfies ConfigRow<ColorCompatibility>,
  // The text segments render when their value is empty.
  default_empty_value: text(optionalStringSpec()),
  // The cell separator `plain` draws between segments. Absent means the glyph
  // rich-js's bundled `plain` joiner owns — no floor here, since naming one
  // would be a second copy of a constant that lives in rich-js.
  default_separator: text(optionalStringSpec()),
  // The settings menu's door glyph (🍫 by default, synthesized by the menu).
  menuGlyph: text(menuGlyphSpec),
} as const;

export type GlobalFieldRows = typeof GLOBAL_FIELDS;
export type GlobalField = keyof GlobalFieldRows;

// ─── Types derived from the rows ────────────────────────────────────────────

// The value a field holds, as its spec parses it.
type ValueOf<R> = R extends { readonly spec: FieldSpec<infer T> } ? T : never;

// [LAW:types-are-the-program] The `globals:` block a config authors: every
// field optional, each holding what its row's spec parses.
export type GlobalsOf<Rows> = {
  readonly [K in keyof Rows]?: ValueOf<Rows[K]>;
};

type FieldsOfKind<Kind extends FieldRow["kind"]> = {
  [K in GlobalField]: GlobalFieldRows[K] extends { readonly kind: Kind }
    ? K
    : never;
}[GlobalField];

// The fields the one generic fold resolves: every session setting and every
// config-only value. Each is published under its own name.
export type ValuedField = FieldsOfKind<"session" | "config">;
export type SessionField = FieldsOfKind<"session">;
export type SelectionField = FieldsOfKind<"selection">;
export type ControlledField = SessionField | SelectionField;

// [LAW:types-are-the-program] What the generic fold resolves each valued field
// to — required, the field's own value type.
export type ValuedGlobals = {
  readonly [K in ValuedField]: ValueOf<GlobalFieldRows[K]>;
};

// A setting's name: a selection's session key, a session setting's field.
type SettingNameOf<K extends ControlledField> =
  GlobalFieldRows[K] extends SelectionRow<infer S> ? S : K;
export type SettingName = {
  [K in ControlledField]: SettingNameOf<K>;
}[ControlledField];

// [LAW:one-source-of-truth] The globals a theme may carry a default for — the
// "look" settings that decide which of the theme's own colours each cell wears
// (candybar-theme-colours-6fq5.ix8). The loader's schema, the resolution's
// rung, the save that writes an entry and the release of the picks it saves
// all range this list.
export type ThemeDefaultField = {
  [K in ControlledField]: GlobalFieldRows[K] extends {
    readonly themeDefault: true;
  }
    ? K
    : never;
}[ControlledField];

// ─── Runtime projections of the rows ────────────────────────────────────────

const ROWS = Object.entries(GLOBAL_FIELDS) as ReadonlyArray<
  [GlobalField, FieldRow]
>;

export function globalFieldRow(field: GlobalField): FieldRow {
  return GLOBAL_FIELDS[field];
}

export const VALUED_FIELDS = ROWS.filter(
  ([, row]) => row.kind === "session" || row.kind === "config",
).map(([field]) => field) as readonly ValuedField[];

export const CONTROLLED_FIELDS = ROWS.filter(
  ([, row]) => row.kind === "session" || row.kind === "selection",
).map(([field]) => field) as readonly ControlledField[];

export const THEME_DEFAULT_FIELDS = ROWS.filter(
  ([, row]) =>
    (row.kind === "session" || row.kind === "selection") && row.themeDefault,
).map(([field]) => field) as readonly ThemeDefaultField[];

// The closed lists an author's `from:` may name, each under its row's name.
export const NAMED_DOMAINS: readonly NamedDomain[] = ROWS.flatMap(([, row]) =>
  "optionDomain" in row && row.optionDomain !== undefined
    ? [row.optionDomain]
    : [],
);

// The row of a valued field, typed to its value.
export function valuedRow<K extends ValuedField>(
  field: K,
): Valued<ValuedGlobals[K]> & { readonly kind: "session" | "config" } {
  return GLOBAL_FIELDS[field] as unknown as Valued<ValuedGlobals[K]> & {
    readonly kind: "session" | "config";
  };
}

// The floor of a valued field: what renders when nothing above it decides.
export const floorOf = <K extends ValuedField>(field: K): ValuedGlobals[K] =>
  valuedRow(field).floor;

// The primitive a field's value is written as — the one fact a persist
// write's JSON5 text, a payload input's declared type and its default read.
export type WireKind = "string" | "number" | "boolean";
export function wireKindOf(field: GlobalField): WireKind {
  const row: FieldRow = GLOBAL_FIELDS[field];
  if (row.kind === "text") return "string";
  const { domain } = row;
  return domain === "bool"
    ? "boolean"
    : typeof domain === "object" && "min" in domain
      ? "number"
      : "string";
}
