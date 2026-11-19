// The settings a config has, by the session key each is stored under: every
// global setting and every placement setting, each with its owner, the one
// parse of its stored spelling, what it can hold, and the variable the bar
// wears it through.
//
// [LAW:one-source-of-truth] A setting has one identity here. The fold, the
// render, the step, the saves, the compile's read-back and the loader's key
// and `set` checks all read this table, so a stored spelling is parsed one way
// wherever it is read, and a key a setting owns is known as one by every
// reader.

import {
  VALUED_FIELDS,
  valuedRow,
  type SessionField,
  type SettingName,
  type ValuedGlobals,
} from "./globals-fields.js";
import { SETTINGS, SETTING_NAMES } from "./setting-projections.js";
import {
  parseSettingSpelling,
  settingVarDecls,
  type DomainValues,
  type DslConfig,
  type SettingDecl,
  type SettingValue,
  type SettingVarDecl,
} from "./dsl-types.js";
import { presetNames } from "./presets.js";
import { namedTheme, type DecidedTheme } from "../themes/palette-resolvers.js";
import {
  EFFECT_NAMES,
  effectiveGlobal,
  namedEffect,
  namedStyle,
  type DecidedEffect,
  type DecidedStyle,
  type Folded,
  type StoredPick,
} from "../themes/policy.js";

// What a setting can hold, as data: the installed themes (a placement's also
// follows the bar), or a closed set of values.
export type SettingDomain =
  | { readonly kind: "theme"; readonly followsBar: boolean }
  | { readonly kind: "values"; readonly members: DomainValues };

interface SettingBase<T> {
  // The SessionState key a pick is stored under.
  readonly key: string;
  readonly domain: SettingDomain;
  // The variable the bar wears the setting through, the one its controls
  // read back.
  readonly wears: string;
  // [LAW:parse-dont-validate] A stored spelling to a value the domain holds,
  // or null for one it does not.
  readonly parse: (raw: string) => T | null;
}

// [LAW:types-are-the-program] What each global setting holds once parsed: a
// session setting its field's value, a selection its decided name. Indexed by
// every setting name (`GlobalValue`), so a setting this does not name — a new
// selection row — is a compile error there, not a value no parse produces.
export type GlobalValues = {
  readonly [F in SessionField]: ValuedGlobals[F];
} & {
  readonly theme: DecidedTheme;
  readonly style: DecidedStyle;
  readonly effect: DecidedEffect;
  readonly preset: string;
};
export type GlobalValue<N extends SettingName> = GlobalValues[N];

export interface GlobalSetting<
  N extends SettingName = SettingName,
> extends SettingBase<GlobalValue<N>> {
  readonly kind: "global";
  readonly name: N;
}

export interface PlacementSetting extends SettingBase<SettingValue> {
  readonly kind: "placement";
  readonly preset: string;
  readonly id: string;
  readonly name: string;
  readonly decl: SettingDecl;
  // What the placement draws while the session holds no pick it can hold.
  readonly saved: SettingValue;
}

export type ConfigSetting = GlobalSetting | PlacementSetting;

export type GlobalSettings = {
  readonly [N in SettingName]: GlobalSetting<N>;
};

export interface SettingTable {
  readonly global: GlobalSettings;
  // Every placement setting of every preset's layout.
  readonly placements: readonly PlacementSetting[];
  readonly byKey: ReadonlyMap<string, ConfigSetting>;
}

// [LAW:parse-dont-validate] THE parse of a setting's stored spelling, for
// global and placement settings alike.
export function pickOf<T>(
  setting: SettingBase<T>,
  raw: string | null,
): StoredPick<T> {
  if (raw === null) return { kind: "unset" };
  const value = setting.parse(raw);
  return value === null ? { kind: "stale", raw } : { kind: "held", value };
}

// [LAW:one-type-per-behavior] A placement setting's fold: the global fold
// with no staged rung and its saved value beneath, so a placement answers
// which rung decided as a global setting does.
export function placementFold(
  setting: PlacementSetting,
  raw: string | null,
): Folded<SettingValue> {
  return effectiveGlobal(
    undefined,
    pickOf(setting, raw),
    setting.saved,
    setting.saved,
  );
}

const values = (members: DomainValues): SettingDomain => ({
  kind: "values",
  members,
});

// The global settings of a config whose own domains are `styles` and
// `presets`.
export function globalSettings(
  domains: Pick<DslConfig, "styles" | "presets">,
): GlobalSettings {
  const global = <N extends SettingName>(
    name: N,
    domain: SettingDomain,
    parse: (raw: string) => GlobalValue<N> | null,
  ): GlobalSetting<N> => ({
    kind: "global",
    name,
    key: SETTINGS[name].sessionKey,
    domain,
    wears: SETTINGS[name].effectiveVar,
    parse,
  });
  const valued = VALUED_FIELDS.flatMap((field) => {
    const row = valuedRow(field);
    if (row.kind !== "session") return [];
    const { domain } = row;
    return [
      global(
        field as SessionField,
        values(
          typeof domain === "object" && "from" in domain
            ? domain.from.map(String)
            : domain,
        ),
        row.parse as (raw: string) => GlobalValue<SessionField> | null,
      ),
    ];
  });
  // [LAW:one-source-of-truth] The floor preset is always a member
  // (`presetNames`), so the parse and the domain read one list.
  const presets = presetNames(domains.presets);
  return {
    theme: global("theme", { kind: "theme", followsBar: false }, namedTheme),
    style: global("style", values(Object.keys(domains.styles)), (raw) =>
      namedStyle(raw, domains.styles),
    ),
    effect: global("effect", values(EFFECT_NAMES), namedEffect),
    preset: global("preset", values(presets), (raw) =>
      presets.includes(raw) ? raw : null,
    ),
    ...Object.fromEntries(valued.map((s) => [s.name, s])),
  } as GlobalSettings;
}

// The placement setting a setting variable `variable` holds.
export function placementSetting(
  variable: string,
  decl: SettingVarDecl,
): PlacementSetting {
  return {
    kind: "placement",
    preset: decl.preset,
    id: decl.id,
    name: decl.setting,
    key: decl.key,
    domain:
      decl.decl.domain === "theme"
        ? { kind: "theme", followsBar: true }
        : values(decl.decl.domain),
    wears: variable,
    parse: (raw) => parseSettingSpelling(decl.decl, raw),
    decl: decl.decl,
    saved: decl.saved,
  };
}

// [LAW:one-source-of-truth] A config's table, derived once per config object:
// a fact of the config alone.
// [LAW:no-shared-mutable-globals] Keyed by config objects, which no pass
// changes once built: each synthesis returns a new config (edit chrome
// mints the placement settings into a new one), so a table built before it
// is that earlier config's, and can never miss what a later pass adds.
const TABLES = new WeakMap<DslConfig, SettingTable>();
export function settingTable(config: DslConfig): SettingTable {
  const known = TABLES.get(config);
  if (known !== undefined) return known;
  const global = globalSettings(config);
  const placements = [...settingVarDecls(config)].map(([variable, decl]) =>
    placementSetting(variable, decl),
  );
  const table: SettingTable = {
    global,
    placements,
    byKey: new Map<string, ConfigSetting>([
      ...SETTING_NAMES.map((name): [string, ConfigSetting] => [
        global[name].key,
        global[name],
      ]),
      ...placements.map((s): [string, ConfigSetting] => [s.key, s]),
    ]),
  };
  TABLES.set(config, table);
  return table;
}

// A setting's stored spelling its domain no longer holds, where that pick
// would have decided.
export interface StalePick {
  readonly setting: ConfigSetting;
  readonly stored: string;
}

// The setting as a message names it.
export function settingTitle(setting: ConfigSetting): string {
  return setting.kind === "global"
    ? `setting "${setting.name}"`
    : `placement "${setting.id}" setting "${setting.name}"`;
}
