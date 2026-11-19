// The settings a config has, by the session key each is stored under: every
// global setting and every placement setting, each with its owner, the one
// parse of its stored spelling, what it can hold, and the variable the bar
// wears it through.
//
// [LAW:one-source-of-truth] A setting has one identity here. The fold, the
// render, the step, the saves, the compile's read-back and the loader's key
// check all read this table, so a stored spelling is parsed one way wherever
// it is read, and a key a setting owns is known as one by every reader.

import {
  VALUED_FIELDS,
  valuedRow,
  type SessionField,
  type SettingName,
  type ValuedGlobals,
} from "./globals-fields.js";
import { SETTINGS, SETTING_NAMES } from "./setting-projections.js";
import {
  describeValues,
  parseSettingSpelling,
  settingVarDecls,
  type DslConfig,
  type SettingDecl,
  type SettingValue,
  type SettingVarDecl,
} from "./dsl-types.js";
import { presetNames } from "./presets.js";
import { namedTheme, type DecidedTheme } from "../themes/palette-resolvers.js";
import {
  EFFECT_NAMES,
  FOLLOW_BAR,
  memberOf,
  namedEffect,
  namedStyle,
  notInstalledTheme,
  type DecidedEffect,
  type DecidedStyle,
  type StoredPick,
} from "../themes/policy.js";

// What a setting can hold, as a report of a spelling outside it says it: the
// installed themes (a placement's also follows the bar), or a closed set of
// values in words.
export type SettingDomain =
  | { readonly kind: "theme"; readonly followsBar: boolean }
  | { readonly kind: "values"; readonly phrase: string };

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

// What a global setting holds once parsed: a selection's decided name, a
// preset's name, a valued field's value.
export type GlobalValue<N extends SettingName> = N extends "theme"
  ? DecidedTheme
  : N extends "style"
    ? DecidedStyle
    : N extends "effect"
      ? DecidedEffect
      : N extends "preset"
        ? string
        : N extends SessionField
          ? ValuedGlobals[N]
          : never;

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

// What a placement setting holds for the stored spelling `raw`: a pick its
// domain holds, else its saved value.
export function placementValue(
  setting: PlacementSetting,
  raw: string | null,
): SettingValue {
  const pick = pickOf(setting, raw);
  return pick.kind === "held" ? pick.value : setting.saved;
}

const values = (members: Parameters<typeof describeValues>[0]) =>
  ({ kind: "values", phrase: describeValues(members) }) as const;

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
  return {
    theme: global("theme", { kind: "theme", followsBar: false }, namedTheme),
    style: global("style", values(Object.keys(domains.styles)), (raw) =>
      namedStyle(raw, domains.styles),
    ),
    effect: global("effect", values(EFFECT_NAMES), namedEffect),
    preset: global(
      "preset",
      values(presetNames(domains.presets)),
      memberOf(domains.presets),
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
    parse: (raw) => parseSettingSpelling(decl.decl, raw) ?? null,
    decl: decl.decl,
    saved: decl.saved,
  };
}

// [LAW:one-source-of-truth] A config's table, derived once per config object:
// a fact of the config alone.
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

// Whether the session's stored spelling at `key` is a stale pick of a
// setting: one a save leaves stored, so it holds again when its domain does.
export function holdsStale(
  config: DslConfig,
  key: string,
  raw: string | null,
): boolean {
  const setting = settingTable(config).byKey.get(key);
  return setting !== undefined && pickOf(setting, raw).kind === "stale";
}

// A setting's stored spelling its domain no longer holds.
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

// [LAW:one-source-of-truth] THE sentence of a stale pick, from its data and
// the display name of the value the bar wears instead. A theme domain says it
// in the wording every installed-theme check uses.
export function staleMessage({ setting, stored }: StalePick, wears: string) {
  const { domain } = setting;
  const why =
    domain.kind === "theme"
      ? domain.followsBar
        ? `${notInstalledTheme(stored)}, and not "${FOLLOW_BAR}" (the bar's own theme)`
        : notInstalledTheme(stored)
      : `"${stored}" is not ${domain.phrase}`;
  return `${settingTitle(setting)}: ${why}, so the bar wears "${wears}" (the pick stays stored)`;
}
