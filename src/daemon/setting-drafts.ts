// [LAW:one-source-of-truth] brandon-save-undo-bwi.hpi — the session's UNSAVED
// settings. Every settings control writes the session; a setting is a DRAFT
// exactly while the bar the session renders differs from the bar the config
// file renders on its own. That is derived here, never stored: there is no
// dirty flag to fall out of step with the file, so a save — or a hand edit —
// that makes the file agree with the session clears the draft the same instant
// it clears the difference, and a pick the render ignores (a preset or look
// the config no longer declares) is never one.
//
// One function, two readers: the render publishes the count (the `💾 save`
// cell exists while it is non-zero) and the `save` verb writes exactly the
// list it returns, computed at click time over the same session and config,
// so the button's count and the click's write cannot describe different sets.

import {
  parseSettingSpelling,
  settingSpelling,
  settingsOf,
  walkNodes,
  type DslConfig,
  type Globals,
  type SettingDecl,
  type SettingValue,
} from "../config/dsl-types.js";
import { isPresetGlobalsField } from "../config/loader/globals.js";
import { presetGlobalsKey } from "../config/loader/persist-target.js";
import { presetByName, presetRoot } from "../config/presets.js";
import { BUNDLED_PRESETS } from "./bundled-presets.js";
import {
  SETTINGS,
  SETTING_PROJECTIONS,
  type SettingName,
  type SettingProjection,
} from "../config/setting-projections.js";
import { BOOLEAN_FALSE, BOOLEAN_TRUE } from "../themes/policy.js";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
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
// error here until it says how it compares. A theme or look chosen by RULE has
// no name until a render evaluates it, so it is `null`: it equals only the
// same rule, and saving a picked name replaces the rule with it.
const SPELLING: {
  readonly [K in keyof typeof SETTINGS]: (e: EffectiveGlobals) => string | null;
} = {
  theme: (e) => (e.theme.kind === "decided" ? e.theme.name : null),
  preset: (e) => e.preset,
  look: (e) => (e.look.kind === "decided" ? e.look.name : null),
  style: (e) => e.style,
  progression: (e) => e.progression,
  charset: (e) => e.charset,
  colorCompatibility: (e) => e.colorCompatibility,
  autoWrap: (e) => (e.autoWrap ? BOOLEAN_TRUE : BOOLEAN_FALSE),
  padding: (e) => String(e.padding),
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

// [LAW:one-source-of-truth] THE comparison a draft and a saved preset are both
// made of: each of `rows` whose value the session renders differs from the
// value `baseOf` it resolves to, and names a value at all (a theme or look
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
  const file = resolveEffectiveGlobals(config, () => null, NOT_CUSTOMIZED);
  const landed = resolveEffectiveGlobals(
    config,
    (key) => (key === SETTINGS.preset.sessionKey ? session.preset : null),
    NOT_CUSTOMIZED,
  );
  const fragment = presetByName(config.presets, session.preset).globals ?? {};
  return differing(
    SETTING_ROWS,
    session,
    (name) => (name === "preset" ? file : landed),
    (row) =>
      row.configKey in fragment
        ? presetGlobalsKey(session.preset, row.configKey)
        : row.configKey,
  );
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
  const from = resolveEffectiveGlobals(
    config,
    (key) => (key === SETTINGS.preset.sessionKey ? session.preset : null),
    NOT_CUSTOMIZED,
  );
  return {
    from: session.preset,
    globals: presetByName(config.presets, session.preset).globals ?? {},
    // [LAW:types-are-the-program] A preset cannot select a preset: its
    // globals schema refuses `preset`, so the row is not offered.
    picks: differing(
      SETTING_ROWS.filter(([n]) => n !== "preset"),
      session,
      () => from,
      (row) => row.configKey,
    ),
    placements: placementDrafts(config, sessionPick),
  };
}

// [LAW:one-source-of-truth] What a `reset` of one config key clears: every
// layer between the bundled default and the bar. A setting lives in three
// places: the session's pick, the file's top-level `globals.<field>`, and a
// preset's own fragment (`presets.<p>.globals.<field>`, where a save lands when
// that preset names the field). Reset clears all three, so the bar returns to
// the bundled default under whichever bundled preset is showing. A fragment is
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
    ],
  };
}
