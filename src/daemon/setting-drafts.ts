// [LAW:one-source-of-truth] brandon-save-undo-bwi.hpi — the session's UNSAVED
// settings. Every settings control writes the session; a setting is a DRAFT
// exactly while the bar the session renders differs from the bar the config
// file renders on its own. That is derived here, never stored: there is no
// dirty flag to fall out of step with the file, so a save — or a hand edit —
// that makes the file agree with the session clears the draft the same instant
// it clears the difference, and a pick the render ignores (a preset or style
// the config no longer declares) is never one.
//
// One function, two readers: the render publishes the count (the `💾 save`
// cell exists while it is non-zero) and the `save` verb writes exactly the
// list it returns, computed at click time over the same session and config,
// so the button's count and the click's write cannot describe different sets.

import {
  parseSettingSpelling,
  settingOrderProblems,
  settingSpelling,
  settingsOf,
  THEME_DEFAULT_FIELDS,
  walkNodes,
  type DslConfig,
  type Globals,
  type RawDslConfig,
  type SettingDecl,
  type SettingValue,
  type ThemeDefaultField,
} from "../config/dsl-types.js";
import { isPresetGlobalsField } from "../config/loader/globals.js";
import {
  parsePersistTarget,
  persistPath,
  presetGlobalsKey,
  isThemeDefaultField,
  themeDefaultKey,
  type ConfigPath,
} from "../config/loader/persist-target.js";
import {
  effectivePresetName,
  presetByName,
  presetGlobals,
  presetNames,
  presetRoot,
} from "../config/presets.js";
import { BUNDLED_PRESETS } from "./bundled-presets.js";
import {
  SETTINGS,
  SETTING_PROJECTIONS,
  perSetting,
  type SettingName,
  type SettingProjection,
} from "../config/setting-projections.js";
import {
  BOOLEAN_FALSE,
  BOOLEAN_TRUE,
  listResolvablePaletteNames,
} from "../themes/policy.js";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
  type SettingCounts,
} from "./render-payload.js";

export interface SettingDraft extends SettingProjection {
  // What the session renders the setting as — the value a save writes.
  readonly value: string;
  // The persist key the value lands at: the layer that wins for this field
  // under the preset being saved.
  readonly target: string;
}

// [LAW:types-are-the-program] Each setting's resolved value in the spelling its
// SessionState key uses, total over SETTINGS so a new setting is a compile
// error here until it says how it compares. A theme or style chosen by RULE has
// no name until a render evaluates it, so it is `null`: it equals only the
// same rule, and saving a picked name replaces the rule with it.
const SPELLING: {
  readonly [K in keyof typeof SETTINGS]: (e: EffectiveGlobals) => string | null;
} = {
  theme: (e) => (e.theme.kind === "decided" ? e.theme.name : null),
  preset: (e) => e.preset,
  style: (e) => (e.style.kind === "decided" ? e.style.name : null),
  endcaps: (e) => e.endcaps,
  variation: (e) => e.variation,
  shade: (e) => e.shade,
  autoWrap: (e) => (e.autoWrap ? BOOLEAN_TRUE : BOOLEAN_FALSE),
  padding: (e) => String(e.padding),
  updateNotice: (e) => (e.updateNotice ? BOOLEAN_TRUE : BOOLEAN_FALSE),
};

const SETTING_ROWS = Object.entries(SETTINGS) as ReadonlyArray<
  [keyof typeof SETTINGS, SettingProjection]
>;

// Only the settings' own keys: edit mode's staged globals are chrome, never
// something a save writes.
const SETTING_KEYS: ReadonlySet<string> = new Set(
  SETTING_PROJECTIONS.map((p) => p.sessionKey),
);

const NOT_CUSTOMIZED = (): boolean => false;

// The bar the session renders: its own picks over the config, and nothing
// else it holds — edit mode's staged globals are chrome.
function sessionGlobals(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): EffectiveGlobals {
  return resolveEffectiveGlobals(
    config,
    (key) => (SETTING_KEYS.has(key) ? sessionPick(key) : null),
    NOT_CUSTOMIZED,
  );
}

// [LAW:one-source-of-truth] The settings other settings resolve THROUGH, in
// the order the resolution reads them: the preset chooses the globals every
// later field reads, and the theme chooses the theme default the look falls
// back to (src/config/theme-defaults.ts). A setting is measured against the
// file under the session's picks of every selector resolved BEFORE it — what
// a fresh session would draw once those picks were saved too — so picking a
// theme does not turn that theme's own default look into drafts, and a pick
// equal to it is none. A selector is measured without its own pick, or it
// could never differ.
const SELECTORS: readonly SettingName[] = ["preset", "theme"];

// The file's bar under the session's picks of the first `depth` selectors.
function fileThrough(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  depth: number,
): EffectiveGlobals {
  const held = new Set<string>(
    SELECTORS.slice(0, depth).map((name) => SETTINGS[name].sessionKey),
  );
  return resolveEffectiveGlobals(
    config,
    (key) => (held.has(key) ? sessionPick(key) : null),
    NOT_CUSTOMIZED,
  );
}

// [LAW:dataflow-not-control-flow] Each setting's base, as one lookup: the
// selectors' own depth, every other setting under all of them.
function baseOf(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): (name: SettingName) => EffectiveGlobals {
  const bases = Array.from({ length: SELECTORS.length + 1 }, (_, depth) =>
    fileThrough(config, sessionPick, depth),
  );
  return (name) => {
    const depth = SELECTORS.indexOf(name);
    return bases[depth === -1 ? SELECTORS.length : depth]!;
  };
}

// [LAW:one-source-of-truth] THE comparison a draft and a saved preset are both
// made of: each of `rows` whose value the session renders differs from the
// value `baseOf` it resolves to, and names a value at all (a theme or style
// chosen by rule has none to write). `targetOf` says where each would land.
function differing(
  rows: ReadonlyArray<[SettingName, SettingProjection]>,
  session: EffectiveGlobals,
  baseOf: (name: SettingName) => EffectiveGlobals,
  targetOf: (row: SettingProjection) => string,
): readonly SettingDraft[] {
  return rows.flatMap(([name, row]) => {
    const value = SPELLING[name](session);
    return value === null || value === SPELLING[name](baseOf(name))
      ? []
      : [{ ...row, value, target: targetOf(row) }];
  });
}

// [LAW:one-source-of-truth] The value the session's own layer resolves a
// setting to, in its SessionState spelling — the layer a step click writes, so
// the value it steps from while the session holds no pick. It is the same
// resolution a draft is measured against: under a preset that pins the field
// it is the preset's value, never top-level globals the preset shadows. Edit
// mode's staged fragment is chrome over that layer, not part of it.
export function sessionSettingValue(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  name: SettingName,
): string | null {
  return SPELLING[name](sessionGlobals(config, sessionPick));
}

// Every setting the session renders differently from the config file. The
// preset is the layer every other field resolves through, so the preset
// compares against the file alone and every other field against the file
// under the preset the save lands — the bar a fresh session opens on after
// it — and lands in that preset's own globals when its fragment names the
// field, where a top-level value would be shadowed.
export function settingDrafts(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): readonly SettingDraft[] {
  const session = sessionGlobals(config, sessionPick);
  return differing(SETTING_ROWS, session, baseOf(config, sessionPick), (row) =>
    landingKey(config, session.preset, row.configKey),
  );
}

// [LAW:one-source-of-truth] THE layer a written globals field lands at under
// `preset`: that preset's own globals when its fragment names the field — a
// top-level value there is shadowed, so the click would land and the bar never
// change — else top-level globals.
function landingKey(
  config: DslConfig,
  preset: string,
  field: keyof Globals,
): string {
  return field in (presetByName(config.presets, preset).globals ?? {})
    ? presetGlobalsKey(preset, field)
    : field;
}

// Where a durable click on `key` lands for this session, and the globals the
// file renders there — what a stepper steps from while the landing key is
// unset. A globals field lands in the layer that wins under the preset the
// session renders, as a save's does; every other persist key names its own
// place.
export interface DurableLanding {
  readonly key: string;
  readonly globals: Globals;
}

export function durableLanding(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  key: string,
): DurableLanding {
  const preset = effectivePresetName(
    sessionPick(SETTINGS.preset.sessionKey),
    config.globals.preset,
    config.presets,
  );
  const target = parsePersistTarget(key);
  return {
    key:
      target?.scope === "globals"
        ? landingKey(config, preset, target.field)
        : key,
    globals: presetGlobals(config, preset),
  };
}

// ─── A placement's settings (brandon-segment-settings-i4n.g64) ─────────────

// One placement setting the session renders differently from the file: the
// value configure mode's control wrote, and where a save puts it — the
// placement `id` in the layout `preset` renders.
export interface PlacementDraft {
  readonly preset: string;
  readonly id: string;
  readonly setting: string;
  // The session key the value is held at — what a save releases.
  readonly key: string;
  readonly value: SettingValue;
}

// Every placement setting the session holds a pick for that differs from the
// value the file gives that placement, in the preset the session renders — a
// pick in another preset is one the render ignores, so it is no draft. A pick
// the declaration no longer admits parses to nothing, and is no draft either:
// the render shows the file's value for it.
export function placementDrafts(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): readonly PlacementDraft[] {
  const { preset } = sessionGlobals(config, sessionPick);
  return slotsOf(config, preset).flatMap(
    ({ id, setting, key, decl, saved }) => {
      const pick = sessionPick(key);
      const value =
        pick === null ? undefined : parseSettingSpelling(decl, pick);
      return value === undefined ||
        settingSpelling(value) === settingSpelling(saved)
        ? []
        : [{ preset, id, setting, key, value }];
    },
  );
}

// [LAW:single-enforcer] What unsaved picks about to land would break between
// a placement's settings (`settingOrderProblems`, the relation the loader
// holds the file to): each placement a write touches, in whichever preset's
// layout holds it, resolved as the written value over the session's pick over
// the file's value. A write to a key no slot holds touches no placement.
export function placementPickProblems(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  writes: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): readonly string[] {
  const written = new Map(writes.map((w) => [w.key, w.value]));
  return presetNames(config.presets).flatMap((preset) => {
    const slots = slotsOf(config, preset);
    const touched = new Set(
      slots.filter((s) => written.has(s.key)).map((s) => s.id),
    );
    return [...touched].flatMap((id) => {
      const own = slots.filter((s) => s.id === id);
      const decls = Object.fromEntries(own.map((s) => [s.setting, s.decl]));
      const values = Object.fromEntries(
        own.map((s) => {
          const pick = written.get(s.key) ?? sessionPick(s.key);
          const value =
            pick === null ? undefined : parseSettingSpelling(s.decl, pick);
          return [s.setting, value ?? s.saved];
        }),
      );
      return settingOrderProblems(decls, values).map(
        ({ message }) => `placement "${id}": ${message}`,
      );
    });
  });
}

// Every draft slot in one preset's layout, with what the file gives it. A
// fact of the config alone, which never changes under a config object — so
// it is read once per (config, preset), and a render's count reads only the
// session. [LAW:one-source-of-truth] Derived from the compiled tree, never
// stored beside it: the memo is keyed by the config it was derived from.
interface DraftSlotFact {
  readonly id: string;
  readonly setting: string;
  readonly key: string;
  readonly decl: SettingDecl;
  readonly saved: SettingValue;
}
const SLOTS = new WeakMap<DslConfig, Map<string, readonly DraftSlotFact[]>>();
function slotsOf(config: DslConfig, preset: string): readonly DraftSlotFact[] {
  const byPreset = SLOTS.get(config) ?? new Map();
  SLOTS.set(config, byPreset);
  const known = byPreset.get(preset);
  if (known !== undefined) return known;
  // One fact per slot: a name label reads its placement's `theme` slot, so a
  // slot can be held by two nodes, which resolve it identically.
  const facts = [...walkNodes(presetRoot(config, preset).node)].flatMap(
    (node) =>
      node.kind !== "segment" || node.drafts === undefined
        ? []
        : Object.entries(node.drafts).map(([setting, { id, key }]) => {
            const decl = settingsOf(config.segments[node.name]!)[setting]!;
            return {
              id,
              setting,
              key,
              decl,
              saved: node.settings?.[setting] ?? decl.default,
            };
          }),
  );
  const slots = [...new Map(facts.map((f) => [f.key, f])).values()];
  byPreset.set(preset, slots);
  return slots;
}

// Save as preset (brandon-save-undo-bwi.o6u): the bar the session renders, as
// a new preset — a copy of the preset it is in (`from`: its arrangement and
// its globals, rules included, which the writer copies) with every display
// setting the session picked differently laid over it. Drafts are included:
// the session's picks are what it renders. The name is the writer's to
// choose, from the file it writes.
export interface PresetSnapshot {
  readonly from: string;
  readonly globals: Globals;
  readonly picks: readonly SettingDraft[];
  readonly placements: readonly PlacementDraft[];
}

export function presetSnapshot(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): PresetSnapshot {
  const session = sessionGlobals(config, sessionPick);
  return {
    from: session.preset,
    globals: presetByName(config.presets, session.preset).globals ?? {},
    // [LAW:types-are-the-program] A preset cannot select a preset: its
    // globals schema refuses `preset`, so the row is not offered.
    picks: differing(
      SETTING_ROWS.filter(([n]) => n !== "preset"),
      session,
      baseOf(config, sessionPick),
      (row) => row.configKey,
    ),
    placements: placementDrafts(config, sessionPick),
  };
}

// ─── A theme's default look (candybar-theme-colours-6fq5.ix8) ──────────────

// [LAW:types-are-the-program] What `⤓ default for <theme>` would save: the
// active theme's name and the look its rung would hold, every field a NAME —
// or nothing, because a rule chose the theme (a `globals.palette` holding a
// template has no answer until a render evaluates it, and a theme's default
// is keyed by name). A style rule cannot reach the look: it lives in the
// config's globals, which outrank the rung, so that field is the rung's own.
export type ThemeDefaultSave =
  | { readonly kind: "rule" }
  | {
      readonly kind: "look";
      readonly theme: string;
      readonly look: Readonly<Record<ThemeDefaultField, string>>;
      // Whether the look differs from what the theme's default already
      // resolves to — a save would change the file.
      readonly differs: boolean;
    };

// The look a config declaring nothing but `theme` would draw: the theme's
// own default over the floors — the bar every session opens on once the look
// is that theme's default and nothing above the rung says otherwise.
function themeOwnLook(config: DslConfig, theme: string): EffectiveGlobals {
  return resolveEffectiveGlobals(
    { ...config, globals: { palette: theme }, presets: {} },
    () => null,
    NOT_CUSTOMIZED,
  );
}

// [LAW:one-source-of-truth] One reading, two readers: the render publishes
// `theme` and `differs` (the control names the theme a click would write, and
// shows exactly while a save would change something) and the verb writes
// `look`, both over the same session and config, so the control and its click
// cannot describe different looks. Edit mode's staged globals are chrome and
// never part of the look saved.
//
// The look is what the theme's rung can show: a field the config's globals
// declare — the file's own, or the active preset's — outranks the rung
// (src/config/theme-defaults.ts), so whatever the session draws there is not
// the theme's to keep, and the entry keeps the theme's own value. Without
// that, a preset's pin (the bundled `zen` preset's `style: "dim"`) would leak
// into a default every preset wears, and a file's `globals.shade` would offer
// a save on every theme that could never take effect.
export function themeDefaultSave(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): ThemeDefaultSave {
  const session = sessionGlobals(config, sessionPick);
  const theme = SPELLING.theme(session);
  if (theme === null) return { kind: "rule" };
  const own = themeOwnLook(config, theme);
  const declared = presetGlobals(config, session.preset);
  const look = Object.fromEntries(
    THEME_DEFAULT_FIELDS.map((f) => [
      f,
      SPELLING[f](declared[f] === undefined ? session : own),
    ]),
  ) as Record<ThemeDefaultField, string>;
  return {
    kind: "look",
    theme,
    look,
    differs: THEME_DEFAULT_FIELDS.some((f) => look[f] !== SPELLING[f](own)),
  };
}

// [LAW:one-source-of-truth] What a `reset` of one config key clears: every
// layer between the bundled default and the bar. A setting lives in up to four
// places: the session's pick, the file's top-level `globals.<field>`, a
// preset's own fragment (`presets.<p>.globals.<field>`, where a save lands when
// that preset names the field), and — for a look field — each theme's default
// (`themeDefaults.<theme>.<field>`, where `⤓ default for <theme>` lands). Reset
// clears all of them, so the bar returns to the bundled default under whichever
// bundled preset and theme are showing. A fragment is
// cleared only for a preset the BUNDLED default declares: there the file's
// entry is a delta over the bundled one, while a preset the user authored is
// the user's own content, its pin included — even one a save overwrote, since
// the bundled default has no value for a preset it does not declare, and
// deleting the pin would rewrite (or, as the last field, prune away) the
// preset itself. Any other key — a segment's palette pin, a preset root — is
// one path in the file and no session key.
export interface ResetLayers {
  readonly sessionKeys: readonly string[];
  readonly fileKeys: readonly string[];
}

export function resetLayers(key: string): ResetLayers {
  const settings = SETTING_PROJECTIONS.filter((p) => p.configKey === key);
  return {
    sessionKeys: settings.map((p) => p.sessionKey),
    fileKeys: [
      key,
      ...(isPresetGlobalsField(key)
        ? BUNDLED_PRESETS.map((preset) => presetGlobalsKey(preset, key))
        : []),
      ...(isThemeDefaultField(key)
        ? listResolvablePaletteNames().map((theme) =>
            themeDefaultKey(theme, key),
          )
        : []),
    ],
  };
}

// The config keys whose reset would change the config FILE: some layer
// `resetLayers` names holds a value in the file as written. Read off the raw
// parse, because the merged config cannot tell a file's value from the
// bundled default's.
export function fileHeldSettings(raw: RawDslConfig): ReadonlySet<string> {
  return new Set(
    SETTING_PROJECTIONS.map((p) => p.configKey).filter((key) =>
      resetLayers(key).fileKeys.some((fileKey) =>
        holds(raw, filePath(fileKey)),
      ),
    ),
  );
}

// [LAW:one-source-of-truth] What the menu's save cell counts and its controls
// mark: every draft a save writes, settings and placements alike, and, per
// setting, whether its reset would change anything — the session holds a
// draft for it or the file holds a value for it (`fileHeld`, from
// fileHeldSettings over the file's raw parse), exactly the layers the reset
// clears (brandon-menu-ia-q30.nk8). A value the active preset pins is neither,
// so it is not marked: a reset could not move it.
export function settingCounts(
  config: DslConfig,
  fileHeld: ReadonlySet<string>,
  sessionPick: (key: string) => string | null,
): SettingCounts {
  const drafts = settingDrafts(config, sessionPick);
  const drafted = new Set(drafts.map((d) => d.configKey));
  const resettable = perSetting(
    (name) =>
      drafted.has(SETTINGS[name].configKey) ||
      fileHeld.has(SETTINGS[name].configKey),
  );
  const themeDefault = themeDefaultSave(config, sessionPick);
  return {
    unsaved: drafts.length + placementDrafts(config, sessionPick).length,
    resettable,
    themeDefault:
      themeDefault.kind === "look" && themeDefault.differs
        ? { differs: true, theme: themeDefault.theme }
        : { differs: false },
  };
}

// A reset layer's key as the steps the file is navigated by — the same parse
// a reset's delete goes through. `resetLayers` names only value paths, so a
// key that parses to anything else is a programming error.
function filePath(fileKey: string): ConfigPath {
  const target = parsePersistTarget(fileKey);
  if (target === null || target.scope === "preset-root") {
    throw new Error(`reset layer "${fileKey}" is not a value path`);
  }
  return persistPath(target);
}

function holds(doc: unknown, path: ConfigPath): boolean {
  const [step, ...rest] = path;
  if (step === undefined) return doc !== undefined;
  return (
    typeof doc === "object" &&
    doc !== null &&
    holds((doc as Record<string, unknown>)[step], rest)
  );
}
