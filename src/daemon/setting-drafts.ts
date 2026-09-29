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

import type { DslConfig, Globals } from "../config/dsl-types.js";
import { isPresetGlobalsField } from "../config/loader/globals.js";
import { presetGlobalsKey } from "../config/loader/persist-target.js";
import { presetByName } from "../config/presets.js";
import { BUNDLED_PRESETS } from "./bundled-presets.js";
import {
  SETTINGS,
  SETTING_PROJECTIONS,
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

export type SettingName = keyof typeof SETTINGS;

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

// [LAW:one-source-of-truth] The value the session renders a setting as, in its
// SessionState spelling: the value a click that steps the setting starts from
// while the session holds no pick for it. It is the same resolution a draft is
// measured against, so under a preset that pins the field the stepper starts
// from the preset's value — the one the bar and its control are showing — and
// never from top-level globals the preset shadows.
export function sessionSettingValue(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  name: SettingName,
): string | null {
  return SPELLING[name](sessionGlobals(config, sessionPick));
}

// The setting whose SessionState key is `key`, if `key` belongs to one.
export function settingOfSessionKey(key: string): SettingName | undefined {
  return SETTING_ROWS.find(([, row]) => row.sessionKey === key)?.[0];
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
