// [LAW:types-are-the-program] The globals schema: a fixed set of string fields
// plus a validated palette name, declared as DATA and interpreted by the record
// engine. A field is added or removed as a row of GLOBAL_FIELDS
// (src/config/globals-fields.ts); this file derives its schema from the rows.

import type { Globals, ThemeDefault } from "../dsl-types.js";
import {
  GLOBAL_FIELDS,
  THEME_DEFAULT_FIELDS,
  type ControlledField,
  type FieldRow,
  type GlobalField,
} from "../globals-fields.js";
import { isExpression, retiredThemeNote } from "../../themes/policy.js";
import {
  describeType,
  isPlainObject,
  record,
  recordJson,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { findKeyLine } from "./diagnostics.js";
import type { ControlDomain } from "../setting-control.js";
import { settingMenuPath } from "../menu-places.js";

// [LAW:one-source-of-truth] THE globals field specs, read off the globals
// rows (src/config/globals-fields.ts). Both the top-level `globals:` schema and
// the preset-scoped one below are built from this map, so a field added there
// is automatically settable from a preset — there is no second list to
// remember to grow.
const GLOBALS_FIELDS = Object.fromEntries(
  Object.entries(GLOBAL_FIELDS).map(([field, row]) => [field, row.spec]),
) as FieldSpecMap<Globals>;

// The domain a control changing `field` from the bar ranges, as its row
// declares it beside the field's spec — `text` for a field no control shape
// fits.
export function globalsControlDomain(
  field: GlobalField,
): ControlDomain | "text" {
  const row = GLOBAL_FIELDS[field];
  return row.kind === "text" ? "text" : rangedDomain(row);
}

// The domain of a setting the bar controls. Every controlled row declares
// one, so this cannot be asked of a field no control shape fits.
export function settingControlDomain(field: ControlledField): ControlDomain {
  return rangedDomain(GLOBAL_FIELDS[field]);
}

// [LAW:one-source-of-truth] A row with a named domain is ranged by that name,
// so the picker and the click gate resolve the one registration that carries
// its facets; every other row by the members it declares.
function rangedDomain(
  row: Exclude<FieldRow, { readonly kind: "text" }>,
): ControlDomain {
  return "optionDomain" in row && row.optionDomain !== undefined
    ? { from: row.optionDomain.name }
    : row.domain;
}

// [LAW:one-source-of-truth] A globals FRAGMENT — a delta layered over the
// config's own globals at render time — may not carry `preset`: which preset is
// active has exactly one authority (session pick over globals.preset over the
// floor), and a fragment re-selecting a preset would be a second one. For a
// preset's own fragment that second authority is also cyclic; for edit mode's
// it would let a style-only fragment restage the whole layout, which edit chrome
// already owns. Same species of bespoke, migration-pointing rejection as
// colorCompatibility's "auto" (globals-fields.ts), and for the same reason: an author who
// writes it deserves to be told WHY, not handed a bare unknown-key message.
//
// [LAW:one-type-per-behavior] Both fragments reject the field identically and
// differ only in the SUBJECT a diagnostic names, so this is one spec taking
// that noun as data — never two specs that could drift in what they reject.
function fragmentRejection(
  description: string,
  message: (at: string) => string,
): FieldSpec<string> {
  return {
    required: false,
    // Always-fail: JSON Schema's `not: {}` matches nothing, so an editor flags
    // the key at the same moment the validator does.
    json: { not: {}, description: `not allowed here — ${description}` },
    parse: (ctx, path, field, raw) => {
      if (raw[field] !== undefined) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message: message(`${path}.${field}`),
          line: findKeyLine(ctx.source, [...path.split("."), field]),
        });
      }
      return undefined;
    },
  };
}

function nestedPresetSpec(subject: string): FieldSpec<string> {
  return fragmentRejection(
    `${subject} cannot select a preset`,
    (at) =>
      `${at}: ${subject} cannot select a preset. Which preset is active is ` +
      `resolved once, as session pick over globals.preset over "default"; a fragment ` +
      `naming another would be a second authority over that. ` +
      `Set the default arrangement in the top-level globals.preset instead.`,
  );
}

function nestedMenuGlyphSpec(subject: string): FieldSpec<string> {
  return fragmentRejection(
    `${subject} cannot change the settings menu glyph`,
    (at) =>
      `${at}: ${subject} cannot change the settings menu glyph — one menu is shared by ` +
      `every preset. Set it in the top-level globals.menuGlyph instead.`,
  );
}

// [LAW:types-are-the-program] The staged rung decides by NAME only: a rule can
// occupy only the config-default rung (`resolveSelection`, themes/policy.ts), so
// the staged rung reads what it is handed as a name, and a rule there would name
// nothing and fall through in silence (brandon-themes-owl). The same field spec
// with the rule shape refused, so the loader accepts no shape the render
// declines to settle — `isExpression` is the one predicate on both sides.
function nameOnlySpec(
  spec: FieldSpec<string>,
  subject: string,
  why: string,
): FieldSpec<string> {
  return {
    ...spec,
    json: { ...spec.json, not: { pattern: "\\{\\{" } },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (typeof v === "string" && isExpression(v)) {
        ctx.issues.push({
          path: `${path}.${field}`,
          message:
            `${path}.${field}: a rule is not allowed here — ${subject} ${why}, ` +
            `so it names a value. Write the rule ` +
            `in globals.${field} (or a preset's globals.${field}) instead.`,
          line: findKeyLine(ctx.source, [...path.split("."), field]),
        });
        return undefined;
      }
      return spec.parse(ctx, path, field, raw);
    },
  };
}

// [LAW:no-silent-failure] Keys a globals block may no longer set, each with the
// pointer the record engine refuses it with — shared by every globals schema
// (top level, preset, editGlobals), so a removed key is refused wherever globals
// are authored and never listed as a legal one.
//
// brandon-config-349: all three were read by nothing. Since ai7 an absent `bg:`
// is the decoration tint of the segment's place in the bar and an absent `fg:`
// is text chosen for contrast against its background, so no fallback slot is
// left to fill; and no caller ever handed the marker to truncation.
const REMOVED_GLOBALS: Readonly<Record<string, string>> = {
  default_bg:
    "nothing reads it — a segment with no `bg:` wears the decoration tint of its " +
    "place in the bar. Delete the key, and author `bg:` on the segments that need a fixed colour.",
  default_fg:
    "nothing reads it — a segment with no `fg:` wears text chosen for contrast against " +
    "its background. Delete the key, and author `fg:` on the segments that need a fixed colour.",
  default_truncate_marker:
    'nothing reads it — a segment clipped to its `width:` always ends in "…". Delete the key.',
  // brandon-menu-ia-q30.xuz: renamed, with no shim. `style` is absent here
  // because it is still a key — it names what `style` did, and an endcaps
  // value in it is refused by value (cross-ref.ts).
  look: 'it was renamed "style" — write the same name as style: "<name>"',
  progression:
    'it was renamed "variation", and its values with it: accent (was secondary-accent), duo (was primary-secondary), mono (was primary)',
  // The tmux status line became a renderer the bar fully supports, so its
  // experimental toggle is a value of the renderer setting.
  // [LAW:one-source-of-truth] Where the control is comes from the menu's map.
  experimentalTmuxStatus: `it became the renderer setting — write renderer: "tmux" (or pick tmux in ${settingMenuPath("renderer")} › renderer, from a session inside tmux)`,
  // Brandon cut ascii mode: the bar draws Nerd Font glyphs, and the doctor's
  // nerdFont check names the font that lacks them.
  charset:
    "the bar always draws Nerd Font glyphs. Delete the key; `cc-candybar doctor` names what your terminal's font is missing.",
};

const GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "globals key",
  fields: GLOBALS_FIELDS,
  removed: REMOVED_GLOBALS,
};

// [LAW:one-source-of-truth] Each fragment-scoped globals schema is the SAME
// field table with exactly one field swapped for its rejection — not a
// hand-listed subset that a future globals field could be forgotten from.
const PRESET_FRAGMENT_REJECTIONS = {
  preset: nestedPresetSpec("a preset"),
  menuGlyph: nestedMenuGlyphSpec("a preset"),
};

const PRESET_GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "preset globals key",
  fields: { ...GLOBALS_FIELDS, ...PRESET_FRAGMENT_REJECTIONS },
  removed: REMOVED_GLOBALS,
};

// A field a preset's own globals fragment may author — every globals field but
// the ones its schema rejects, read off the same rejection table.
export function isPresetGlobalsField(key: string): key is keyof Globals {
  return isGlobalsField(key) && !(key in PRESET_FRAGMENT_REJECTIONS);
}

// [LAW:one-type-per-behavior] Edit mode's staged globals are the same shape one
// rung later in the precedence chain, so they reuse the same table rather than
// declaring which fields edit mode "supports" — a field added to Globals is
// edit-settable the same day, with no edit here.
const EDIT_GLOBALS_WHY = "is decided later than any rule could be settled";
const EDIT_GLOBALS_SCHEMA: RecordSchema<Globals> = {
  noun: "editGlobals key",
  removed: REMOVED_GLOBALS,
  fields: {
    ...GLOBALS_FIELDS,
    preset: nestedPresetSpec("the editGlobals fragment"),
    menuGlyph: nestedMenuGlyphSpec("the editGlobals fragment"),
    palette: nameOnlySpec(
      GLOBALS_FIELDS.palette,
      "the editGlobals fragment",
      EDIT_GLOBALS_WHY,
    ),
    style: nameOnlySpec(
      GLOBALS_FIELDS.style,
      "the editGlobals fragment",
      EDIT_GLOBALS_WHY,
    ),
    effect: nameOnlySpec(
      GLOBALS_FIELDS.effect,
      "the editGlobals fragment",
      EDIT_GLOBALS_WHY,
    ),
  },
};

// [LAW:one-source-of-truth] A theme's default look (candybar-theme-colours-
// 6fq5.ix8) is the SAME field table cut to THEME_DEFAULT_FIELDS, so its shade
// and variation accept exactly the members `globals` does, and the record
// engine refuses any other key. Its style is a name only: the rung sits under
// the config's globals, and a rule is something only a render can settle — a
// theme's default is a choice made once, by name. Whether that name is a
// declared style is cross-ref's (it needs the merged `styles` block).
const THEME_DEFAULT_SCHEMA: RecordSchema<ThemeDefault> = {
  noun: "theme default key",
  fields: {
    ...(Object.fromEntries(
      THEME_DEFAULT_FIELDS.map((f) => [f, GLOBALS_FIELDS[f]]),
    ) as FieldSpecMap<ThemeDefault>),
    style: nameOnlySpec(
      GLOBALS_FIELDS.style,
      "a theme's default",
      "is the look that theme wears by name",
    ),
  },
};

// `themeDefaults:` — theme name → that theme's default look. A key must name
// an installed theme: a default for a theme nothing installs could never
// apply, and silently carrying it would hide the typo [LAW:no-silent-failure].
export function validateThemeDefaults(
  ctx: ValidateCtx,
  raw: unknown,
): Readonly<Record<string, ThemeDefault>> {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "themeDefaults",
      message: `themeDefaults must be an object mapping theme names to { shade, variation, style }, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["themeDefaults"]),
    });
    return {};
  }
  const out: Record<string, ThemeDefault> = {};
  for (const [theme, value] of Object.entries(raw)) {
    const path = `themeDefaults.${theme}`;
    if (!ctx.allowedPalettes.has(theme)) {
      ctx.issues.push({
        path,
        message: `${path}: "${theme}" is not an installed theme${retiredThemeNote(theme)}. Expected one of: ${[...ctx.allowedPalettes].sort().join(", ")}`,
        line: findKeyLine(ctx.source, ["themeDefaults", theme]),
      });
      continue;
    }
    const parsed = record(ctx, THEME_DEFAULT_SCHEMA, path, value);
    if (parsed !== null) out[theme] = parsed;
  }
  return out;
}

// [LAW:one-source-of-truth] The schema emitter over the same declaration —
// shape only; which names are installed themes is the loader's to check, as
// for `globals.palette`.
export function themeDefaultsJson(): JsonNode {
  return {
    type: "object",
    additionalProperties: recordJson(THEME_DEFAULT_SCHEMA),
  };
}

// An absent globals block is the empty default (no issue); a non-object is a
// reported error that recovers to the empty default, since parseDslConfig throws
// once any issue exists so the recovery value never renders [LAW:no-silent-failure].
// `path` is explicit because the same schema validates the top-level `globals:`
// block and a preset's nested one, and a diagnostic must name where it actually is.
export function validateGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  if (raw === undefined) return {};
  return record(ctx, GLOBALS_SCHEMA, path, raw) ?? {};
}

// The preset-scoped twin: same interpreter, the schema that rejects `preset`.
export function validatePresetGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  return record(ctx, PRESET_GLOBALS_SCHEMA, path, raw) ?? {};
}

// [LAW:one-source-of-truth] The schema emitter derives from the SAME declaration
// the validator interprets — `globals` emit is `recordJson(GLOBALS_SCHEMA)`,
// symmetric to `validateGlobals` calling `record(GLOBALS_SCHEMA)`.
export function globalsJson(): JsonNode {
  return recordJson(GLOBALS_SCHEMA);
}

export function presetGlobalsJson(): JsonNode {
  return recordJson(PRESET_GLOBALS_SCHEMA);
}

// Edit mode's twin of the two above: same interpreter, same field table, the
// schema whose `preset` rejection names the editGlobals fragment.
export function validateEditGlobals(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Globals {
  return record(ctx, EDIT_GLOBALS_SCHEMA, path, raw) ?? {};
}

export function editGlobalsJson(): JsonNode {
  return recordJson(EDIT_GLOBALS_SCHEMA);
}

// [LAW:one-source-of-truth] THE membership check for "is this a real Globals
// field" — derived from GLOBALS_FIELDS, the same declaration
// validateGlobals/globalsJson interpret, so a `persist`/`reset` action's
// target key is checked against exactly the field set a hand-authored
// `globals: {...}` block would be. Used by cross-ref.ts (candybar-config-
// engine-71o.2) to catch a typo'd persist target at config-load time instead
// of a confusing click-time "invariant broken" error.
const GLOBALS_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(GLOBALS_FIELDS),
);
export function isGlobalsField(key: string): key is keyof Globals {
  return GLOBALS_FIELD_NAMES.has(key);
}

// [LAW:one-source-of-truth] Why a removed globals key is gone, for a reader
// that meets it outside a globals block — a persist or reset target.
export function removedGlobalPointer(key: string): string | undefined {
  return Object.hasOwn(REMOVED_GLOBALS, key) ? REMOVED_GLOBALS[key] : undefined;
}

export function listGlobalsFieldNames(): readonly string[] {
  return [...GLOBALS_FIELD_NAMES];
}

// [LAW:types-are-the-program] Every NUMERIC globals field with the value that
// renders when a config declares none — its row's floor — so a numeric field
// never silently seeds a stepper from `min` (the bug this table exists to
// prevent). A numeric field is one whose row ranges integers.
const NUMERIC_GLOBALS_FLOORS: ReadonlyMap<string, number> = new Map(
  Object.entries(GLOBAL_FIELDS).flatMap(([field, row]) =>
    "floor" in row && typeof row.floor === "number"
      ? [[field, row.floor] as const]
      : [],
  ),
);

// [LAW:single-enforcer] THE seed for a bounded stepper over a globals field:
// the value `globals` holds, or the field's floor when it holds none. Callers
// pass the globals the bar renders under the session's preset (step-config via
// configKeySeed, over presetGlobals), so a durable stepper never silently starts
// from `min` nor from a top-level value that preset shadows.
export function numericGlobalsSeeds(
  globals: Globals,
): ReadonlyMap<string, number> {
  const seeds = new Map<string, number>();
  for (const [field, floor] of NUMERIC_GLOBALS_FLOORS) {
    const declared = globals[field as keyof Globals];
    seeds.set(field, typeof declared === "number" ? declared : floor);
  }
  return seeds;
}
