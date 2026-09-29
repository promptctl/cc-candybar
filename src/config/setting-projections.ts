// The settings the daemon resolves once per render and publishes as an
// `.effective` projection (src/daemon/render-payload.ts), each with the two keys
// that write it: the SessionState key a pick (`set`) writes and the config field
// a save (src/daemon/setting-drafts.ts) or a `persist` writes.
//
// [LAW:one-source-of-truth] THE table. The settings menu mints its controls'
// keys from these rows (src/config/settings-menu.ts) and the render derives its
// read-back maps from them (src/render/action.ts), so a setting's triple is
// spelled here and nowhere else — a control cannot write a key whose current
// value the render does not know how to read back, and a save cannot write a
// field other than the one the pick it saves stands for.
// [LAW:one-way-deps] It lives under config/ and imports only config/'s own
// types: config/ sits below render/, which already imports from here, so both
// sides depend downhill.

import type { Globals } from "./dsl-types.js";

export interface SettingProjection {
  // The globals field a durable `persist` writes.
  readonly configKey: keyof Globals;
  // The SessionState key a `set` writes. It differs from `configKey` where
  // history made them differ (`palette` is `theme` in the session), which is
  // why each row spells both rather than deriving one from the other.
  readonly sessionKey: string;
  // The input variable holding the value the bar is rendering with, whichever
  // rung (staged, session, config, floor) produced it.
  readonly effectiveVar: string;
}

export const SETTINGS = {
  theme: {
    configKey: "palette",
    sessionKey: "theme",
    effectiveVar: "theme.effective",
  },
  // `preset` is a projection like the rest: the preset carousel sits on the
  // settings menu's always-visible first row, where "which arrangement am I
  // in" is the whole question the control answers.
  preset: {
    configKey: "preset",
    sessionKey: "preset",
    effectiveVar: "preset.effective",
  },
  look: {
    configKey: "look",
    sessionKey: "look",
    effectiveVar: "look.effective",
  },
  style: {
    configKey: "style",
    sessionKey: "style",
    effectiveVar: "style.effective",
  },
  progression: {
    configKey: "progression",
    sessionKey: "progression",
    effectiveVar: "progression.effective",
  },
  charset: {
    configKey: "charset",
    sessionKey: "charset",
    effectiveVar: "charset.effective",
  },
  colorCompatibility: {
    configKey: "colorCompatibility",
    sessionKey: "colorCompatibility",
    effectiveVar: "colorCompatibility.effective",
  },
  autoWrap: {
    configKey: "autoWrap",
    sessionKey: "autoWrap",
    effectiveVar: "autoWrap.effective",
  },
  padding: {
    configKey: "padding",
    sessionKey: "padding",
    effectiveVar: "padding.effective",
  },
} as const satisfies Record<string, SettingProjection>;

export const SETTING_PROJECTIONS: readonly SettingProjection[] =
  Object.values(SETTINGS);

// [LAW:one-source-of-truth] The current value of a setting is the one the bar
// is rendering with — whichever rung (staged, session, config, floor) produced
// it — so a `persist` and a `set` on a key in SETTING_PROJECTIONS both read
// back through its `.effective` projection. The settings menu mints its
// controls from the same table, so every one of them has a row here. A
// `persist` on a field with no row reads back through a var named after the
// field, which none is, so its current-selection mark is inert (readVar yields
// ""); a `set` on a key with no row reads back through the `state` variable
// over that key.
export const CONFIG_KEY_TO_EFFECTIVE_VAR: ReadonlyMap<string, string> = new Map(
  SETTING_PROJECTIONS.map((p) => [p.configKey, p.effectiveVar]),
);

// registerDslConfig seeds its key → read-back map from this, ahead of any
// `state` variable over the same key: an unpicked session has no pick, yet the
// bar still wears a theme (brandon-theme-picker-bgw.exj).
export const SESSION_KEY_TO_EFFECTIVE_VAR: ReadonlyMap<string, string> =
  new Map(SETTING_PROJECTIONS.map((p) => [p.sessionKey, p.effectiveVar]));

export type SettingName = keyof typeof SETTINGS;

// The setting whose SessionState key a step click names.
export const SESSION_KEY_TO_SETTING: ReadonlyMap<string, SettingName> = new Map(
  (Object.keys(SETTINGS) as SettingName[]).map((name) => [
    SETTINGS[name].sessionKey,
    name,
  ]),
);
