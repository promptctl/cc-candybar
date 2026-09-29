// [LAW:one-source-of-truth] brandon-save-undo-bwi.hpi — the session's UNSAVED
// settings. Every settings control writes the session; a pick is a DRAFT
// exactly while it differs from what the config file resolves on its own. That
// is derived here, never stored: there is no dirty flag to fall out of step
// with the file, so a hand edit that makes the file agree with a pick clears
// the draft the same instant it would clear the difference.
//
// One function, two readers: the render publishes the count (the `💾 save`
// cell exists while it is non-zero) and the `save` verb writes exactly the
// list it returns, computed at click time over the same session and config,
// so the button's count and the click's write cannot describe different sets.

import type { DslConfig } from "../config/dsl-types.js";
import {
  SETTINGS,
  type SettingProjection,
} from "../config/setting-projections.js";
import { BOOLEAN_FALSE, BOOLEAN_TRUE } from "../themes/policy.js";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "./render-payload.js";

export interface SettingDraft extends SettingProjection {
  // The session's pick, verbatim — the value a save writes to `configKey`.
  readonly value: string;
}

// [LAW:types-are-the-program] Each setting's saved value in the spelling its
// SessionState key uses, total over SETTINGS so a new setting is a compile
// error here until it says how it compares. A theme or look the file chooses
// by RULE has no name until a render evaluates it, so it is `null`: no pick
// equals it, and saving a pick replaces the rule with the name the user chose.
const SAVED_SPELLING: {
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

// Every setting the session picks a value for that the config file does not
// already resolve to. "What the file resolves" is the whole precedence chain
// with no session at all — the bar a fresh session opens on.
export function settingDrafts(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): readonly SettingDraft[] {
  const saved = resolveEffectiveGlobals(
    config,
    () => null,
    () => false,
  );
  return SETTING_ROWS.flatMap(([name, row]) => {
    const value = sessionPick(row.sessionKey);
    return value === null || value === SAVED_SPELLING[name](saved)
      ? []
      : [{ ...row, value }];
  });
}
