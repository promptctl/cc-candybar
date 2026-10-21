// The settings the daemon resolves once per render and publishes as an
// `.effective` projection (src/daemon/render-payload.ts), each with the two keys
// that write it: the SessionState key a pick (`set`) writes and the config field
// a save (src/daemon/setting-drafts.ts) or a `persist` writes.
//
// [LAW:one-source-of-truth] A PROJECTION of the globals rows
// (src/config/globals-fields.ts), never a table of its own: every row the bar
// controls is one setting here. The settings menu mints its controls' keys from
// it (src/config/settings-menu.ts) and the render derives its read-back maps
// from it (src/render/action.ts), so a control cannot write a key whose current
// value the render does not know how to read back, and a save cannot write a
// field other than the one the pick it saves stands for.
// [LAW:one-way-deps] It lives under config/ and imports only config/'s own
// modules: config/ sits below render/, which already imports from here, so both
// sides depend downhill.

import {
  CONTROLLED_FIELDS,
  GLOBAL_FIELDS,
  VALUED_FIELDS,
  type Control,
  type ControlledField,
  type GlobalField,
  type SettingName,
} from "./globals-fields.js";

export type { SettingName } from "./globals-fields.js";

// A globals field the render publishes an `.effective` projection of.
export interface ConfigProjection {
  // The globals field a durable `persist` writes.
  readonly configKey: GlobalField;
  // The input variable holding the value the bar is rendering with, whichever
  // rung (staged, session, config, floor) produced it.
  readonly effectiveVar: string;
}

// A projection a session can pick, so it has a control on the bar: its row's
// label, place and previews beside the keys.
export interface SettingProjection extends ConfigProjection, Control {
  readonly configKey: ControlledField;
  // The SessionState key a `set` writes — the setting's name.
  readonly sessionKey: SettingName;
}

// [LAW:one-source-of-truth] The one spelling of a published value's input
// variable: every `.effective` the payload carries is under the name its
// session key (or, for a config-only value, its field) has.
const effectiveVarOf = (name: string): string => `${name}.effective`;

const nameOf = (field: ControlledField): SettingName => {
  const row = GLOBAL_FIELDS[field];
  return (row.kind === "selection" ? row.sessionKey : field) as SettingName;
};

export const SETTINGS: Readonly<Record<SettingName, SettingProjection>> =
  Object.fromEntries(
    CONTROLLED_FIELDS.map((field) => {
      const name = nameOf(field);
      return [
        name,
        {
          configKey: field,
          sessionKey: name,
          effectiveVar: effectiveVarOf(name),
          ...GLOBAL_FIELDS[field].control,
        },
      ];
    }),
  ) as Record<SettingName, SettingProjection>;

export const SETTING_NAMES = Object.keys(SETTINGS) as readonly SettingName[];

export const SETTING_PROJECTIONS: readonly SettingProjection[] =
  Object.values(SETTINGS);

// The projections no session picks: the config file is their only writer
// (brandon-menu-ia-q30.5y4), by hand or through an authored `persist`.
const CONFIG_ONLY_PROJECTIONS: readonly ConfigProjection[] =
  VALUED_FIELDS.filter((field) => GLOBAL_FIELDS[field].kind === "config").map(
    (field) => ({ configKey: field, effectiveVar: effectiveVarOf(field) }),
  );

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

// [LAW:types-are-the-program] A record total over SETTINGS, one value per
// setting: the one place the totality `Object.fromEntries` cannot see is
// asserted, so every caller's record is checked as total by construction.
export function perSetting<T>(
  value: (name: SettingName) => T,
): Readonly<Record<SettingName, T>> {
  return Object.fromEntries(
    SETTING_NAMES.map((name) => [name, value(name)]),
  ) as Record<SettingName, T>;
}

// The setting whose SessionState key a step click names.
export const SESSION_KEY_TO_SETTING: ReadonlyMap<string, SettingName> = new Map(
  SETTING_NAMES.map((name) => [SETTINGS[name].sessionKey, name]),
);
