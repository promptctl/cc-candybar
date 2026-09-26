// The settings the daemon resolves once per render and publishes as an
// `.effective` projection (src/daemon/render-payload.ts), each with the two keys
// that write it: the config field a `persist` writes and the SessionState key a
// `set` writes.
//
// [LAW:one-source-of-truth] THE table. The settings menu mints its controls'
// keys from these rows (src/config/settings-menu.ts) and the render derives its
// read-back maps from them (src/render/action.ts), so a setting's triple is
// spelled here and nowhere else — a dual control cannot write a key whose
// current value the render does not know how to read back.
// [LAW:one-way-deps] It lives under config/ and imports nothing: config/ sits
// below render/, which already imports from here, so both sides depend downhill.

export interface SettingProjection {
  // The globals field a durable `persist` writes.
  readonly configKey: string;
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
