// [LAW:one-source-of-truth] THE settings of one config, keyed by the session
// key a pick is held at: one row for every globals setting and one for every
// placement's setting in every preset. Only a setting declares a domain — the
// installed themes, the config's styles and presets, the effect catalogue, a
// list of words, an integer range, the placement themes — and its row holds
// that domain and the one parse a pick crosses into it. The fold, the step
// click, the loader's checks and the stale warning all read a pick through
// its row, so none of them reads a raw spelling its own way.
//
// A plain `state` variable declares no domain: whatever a click wrote is its
// value, read as stored. One key has one owner, so a `state` variable over a
// setting's key is refused at load (loader/setting-keys.ts).
//
// [LAW:one-way-deps] Built from a loaded config, the one edit chrome produced
// (its draft slots are the placement rows), so it sits above the config types
// and the control generator and below the loader's checks and the render.

import {
  parseSettingSpelling,
  walkNodes,
  type DslConfig,
  type PlacementSlot,
  type SettingValue,
} from "./dsl-types.js";
import {
  GLOBAL_FIELDS,
  CONTROLLED_FIELDS,
  settingControlDomain,
  settingNameOf,
  type ControlledField,
  type SettingName,
} from "./globals-fields.js";
import { controlDeclOf, type ControlDomain } from "./setting-control.js";
import { presetMember, presetNames, presetRoot } from "./presets.js";
import {
  foldSetting,
  heldBy,
  installedTheme,
  namedEffect,
  namedStyle,
  type Folded,
} from "../themes/policy.js";

// [LAW:types-are-the-program] What a parse admits: a value of the setting's
// own type. Never null, which is the parse's "outside the domain".
export type Admitted = string | number | boolean | object;

// One setting: the key a pick is held at, how a message names it, what it
// can hold, and the parse a pick crosses into that domain.
export interface SettingRow {
  readonly key: string;
  readonly name: string;
  readonly domain: ControlDomain;
  readonly parse: (raw: string) => Admitted | null;
}

// A placement's setting: its row, beside the slot it was minted from — the
// preset and placement it belongs to and the value its file gives it, which
// is what lies beneath a pick.
export interface PlacementRow extends SettingRow, PlacementSlot {
  readonly parse: (raw: string) => SettingValue | null;
}

export interface SettingTable {
  // Every setting's row by its session key.
  readonly rows: ReadonlyMap<string, SettingRow>;
  // The globals settings, each by its name — which is its session key.
  readonly globals: Readonly<Record<SettingName, SettingRow>>;
  // The placement settings of every preset's layout, each once.
  readonly placements: readonly PlacementRow[];
}

// [LAW:parse-dont-validate] The parse of each globals setting, by its field:
// a selection's membership in this config's own domain, any other its row's
// parse — the same function the fold reads (effective-globals.ts), so the two
// cannot admit different spellings.
function globalParse(
  config: Pick<DslConfig, "styles" | "presets">,
  field: ControlledField,
): (raw: string) => Admitted | null {
  const row = GLOBAL_FIELDS[field];
  if (row.kind === "session") return row.parse;
  switch (row.sessionKey) {
    case "theme":
      return installedTheme;
    case "style":
      return (raw) => namedStyle(raw, config.styles);
    case "effect":
      return namedEffect;
    case "preset":
      return presetMember(config.presets);
  }
}

// A placement's row from the slot edit chrome minted for it.
export function placementRow(slot: PlacementSlot): PlacementRow {
  return {
    ...slot,
    name: `"${slot.setting}" of placement "${slot.id}"`,
    domain: controlDeclOf(slot.decl).domain,
    parse: (raw) => parseSettingSpelling(slot.decl, raw) ?? null,
  };
}

// [LAW:one-type-per-behavior] A placement setting's fold: the precedence
// every setting folds through, with no staged rung and the placement's own
// value beneath the pick.
export function placementFold(
  row: PlacementRow,
  raw: string | null,
): Folded<SettingValue> {
  return foldSetting(undefined, heldBy(raw, row.parse), row.beneath);
}

const TABLES = new WeakMap<DslConfig, SettingTable>();

// [LAW:one-source-of-truth] Derived from the config, never stored beside it:
// memoised by the config object it was read from.
export function settingTable(config: DslConfig): SettingTable {
  const known = TABLES.get(config);
  if (known !== undefined) return known;
  const globals = Object.fromEntries(
    CONTROLLED_FIELDS.map((field) => {
      const name: SettingName = settingNameOf(field);
      const row: SettingRow = {
        key: name,
        name,
        domain: settingControlDomain(field),
        parse: globalParse(config, field),
      };
      return [name, row];
    }),
  ) as Record<SettingName, SettingRow>;
  // A name label reads its placement's slots, so one slot can sit on two
  // nodes; the key names one value, so it is one row.
  const placements = [
    ...new Map(
      presetNames(config.presets).flatMap((preset) =>
        [...walkNodes(presetRoot(config, preset).node)].flatMap((node) =>
          node.kind === "segment"
            ? Object.values(node.drafts ?? {}).map(
                (slot) => [slot.key, placementRow(slot)] as const,
              )
            : [],
        ),
      ),
    ).values(),
  ];
  const table: SettingTable = {
    rows: new Map<string, SettingRow>([
      ...Object.values(globals).map((row) => [row.key, row] as const),
      ...placements.map((row) => [row.key, row] as const),
    ]),
    globals,
    placements,
  };
  TABLES.set(config, table);
  return table;
}
