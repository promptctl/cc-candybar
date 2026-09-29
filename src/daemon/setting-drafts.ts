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

import type { DslConfig } from "../config/dsl-types.js";
import { presetGlobalsKey } from "../config/loader/persist-target.js";
import { presetByName } from "../config/presets.js";
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
  const session = resolveEffectiveGlobals(
    config,
    (key) => (SETTING_KEYS.has(key) ? sessionPick(key) : null),
    NOT_CUSTOMIZED,
  );
  const file = resolveEffectiveGlobals(config, () => null, NOT_CUSTOMIZED);
  const landed = resolveEffectiveGlobals(
    config,
    (key) => (key === SETTINGS.preset.sessionKey ? session.preset : null),
    NOT_CUSTOMIZED,
  );
  const fragment = presetByName(config.presets, session.preset).globals ?? {};
  return SETTING_ROWS.flatMap(([name, row]) => {
    const value = SPELLING[name](session);
    const saved = SPELLING[name](name === "preset" ? file : landed);
    return value === null || value === saved
      ? []
      : [
          {
            ...row,
            value,
            target:
              row.configKey in fragment
                ? presetGlobalsKey(session.preset, row.configKey)
                : row.configKey,
          },
        ];
  });
}
