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

// A globals field the render publishes an `.effective` projection of.
export interface ConfigProjection {
  // The globals field a durable `persist` writes.
  readonly configKey: keyof Globals;
  // The input variable holding the value the bar is rendering with, whichever
  // rung (staged, session, config, floor) produced it.
  readonly effectiveVar: string;
}

// A projection a session can pick, so it has a control on the bar.
export interface SettingProjection extends ConfigProjection {
  // The SessionState key a `set` writes. It differs from `configKey` where
  // history made them differ (`palette` is `theme` in the session), which is
  // why each row spells both rather than deriving one from the other.
  readonly sessionKey: string;
  // What the setting's control is called on the bar — a glyph where the
  // control shows its value beside it, a word where it does not.
  readonly label: string;
}

export const SETTINGS = {
  theme: {
    configKey: "palette",
    sessionKey: "theme",
    effectiveVar: "theme.effective",
    label: "🎨",
  },
  // `preset` is a projection like the rest: the preset carousel sits on the
  // settings menu's always-visible first row, where "which arrangement am I
  // in" is the whole question the control answers.
  preset: {
    configKey: "preset",
    sessionKey: "preset",
    effectiveVar: "preset.effective",
    label: "▦",
  },
  style: {
    configKey: "style",
    sessionKey: "style",
    effectiveVar: "style.effective",
    label: "◐",
  },
  endcaps: {
    configKey: "endcaps",
    sessionKey: "endcaps",
    effectiveVar: "endcaps.effective",
    label: "✦",
  },
  variation: {
    configKey: "variation",
    sessionKey: "variation",
    effectiveVar: "variation.effective",
    label: "🎼",
  },
  autoWrap: {
    configKey: "autoWrap",
    sessionKey: "autoWrap",
    effectiveVar: "autoWrap.effective",
    label: "wrap",
  },
  padding: {
    configKey: "padding",
    sessionKey: "padding",
    effectiveVar: "padding.effective",
    label: "padding",
  },
  updateNotice: {
    configKey: "updateNotice",
    sessionKey: "updateNotice",
    effectiveVar: "updateNotice.effective",
    label: "update notice",
  },
} as const satisfies Record<string, SettingProjection>;

export const SETTING_PROJECTIONS: readonly SettingProjection[] =
  Object.values(SETTINGS);

// [LAW:types-are-the-program] Every globals field with no row above, and why
// the bar offers no control for it (brandon-settings-coverage-g4p.zoj, the
// list Brandon confirmed). Keyed by exactly the fields SETTINGS leaves out, so
// a new globals field is a compile error until it has a row — and with it a
// control generated from its declared domain — or a reason here.
type ControlledField = (typeof SETTINGS)[keyof typeof SETTINGS]["configKey"];

export const UNCONTROLLED_GLOBALS: Readonly<
  Record<Exclude<keyof Globals, ControlledField>, string>
> = {
  default_empty_value: "free text: no control shape fits it",
  default_separator: "free text: no control shape fits it",
  menuGlyph: "free text: no control shape fits it",
  charset:
    "set in the config file: Brandon cut the control (brandon-menu-ia-q30.5y4)",
  colorCompatibility:
    "set in the config file: Brandon cut the control (brandon-menu-ia-q30.5y4)",
};

// The projections no session picks: the config file is their only writer
// (brandon-menu-ia-q30.5y4), by hand or through an authored `persist`. Each is
// an uncontrolled global, so a field here has no control by construction.
type UncontrolledField = keyof typeof UNCONTROLLED_GLOBALS;
const CONFIG_ONLY_PROJECTIONS: ReadonlyArray<
  ConfigProjection & {
    readonly configKey: UncontrolledField;
  }
> = [
  { configKey: "charset", effectiveVar: "charset.effective" },
  {
    configKey: "colorCompatibility",
    effectiveVar: "colorCompatibility.effective",
  },
];

// [LAW:no-silent-failure] The keys an authored `set` is refused on: a session
// write there would render nothing, since no rung reads it.
export const CONFIG_ONLY_KEYS: ReadonlySet<string> = new Set(
  CONFIG_ONLY_PROJECTIONS.map((p) => p.configKey),
);

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
  [...SETTING_PROJECTIONS, ...CONFIG_ONLY_PROJECTIONS].map((p) => [
    p.configKey,
    p.effectiveVar,
  ]),
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
