// [LAW:one-source-of-truth] The ONE resolution of a session's globals: the
// precedence chain (staged › session pick › active preset's globals › the
// theme's default › floor) every renderer draws through.

import { LANES, perLane, type LaneSwitches } from "./lanes.js";
import { effectivePresetName, presetGlobals } from "./presets.js";
import { EDIT_MODE_ARRANGE, EDIT_MODE_KEY } from "./loader/edit-mode.js";
import type { DslConfig, Globals } from "./dsl-types.js";
import {
  VALUED_FIELDS,
  valuedRow,
  type SettingName,
  type ValuedField,
  type ValuedGlobals,
} from "./globals-fields.js";
import { SETTINGS, SETTING_NAMES } from "./setting-projections.js";
import {
  pickOf,
  settingTable,
  type GlobalValue,
  type StalePick,
} from "./setting-table.js";
import {
  resolveStyleSelection,
  type StyleSelection,
  resolveEffectSelection,
  type EffectSelection,
  effectiveGlobal,
  type StoredPick,
} from "../themes/policy.js";
import {
  resolveThemeSelection,
  type ThemeSelection,
} from "../themes/palette-resolvers.js";
import { themeDefaultsOf, underThemeDefault } from "./theme-defaults.js";

// [LAW:one-source-of-truth] Each of these is resolved exactly ONCE per render,
// here, before both the payload build and drawDsl's BuildLineOptions, so the
// value a trigger label displays and the value that actually shaped the render
// can never disagree.
//
// [LAW:types-are-the-program] Every valued field of the globals rows
// (src/config/globals-fields.ts) is here under its own name, typed by its
// row, so a setting declared there is resolved and carried with no edit to
// this file. The rest are the selections, whose folds differ by more than
// data.
export type EffectiveGlobals = ValuedGlobals & {
  // [LAW:types-are-the-program] The theme as far as it can be resolved HERE
  // (brandon-themes-dzl) — `style`'s twin one dimension over, and for the same
  // reason: a session pick, a staged fragment and a plain `globals.palette` all
  // resolve to a `decided` arm carrying the name AND the base palette it
  // denotes, while a `globals.palette` holding a TEMPLATE resolves to an
  // `expression` arm, because the store does not hold this render's values
  // until the view is bound. So the view finishes that one rung, and is
  // therefore also the one place `theme.effective` is published — which is why
  // the payload carries no `theme` field and the server hands drawDsl no
  // separate base palette.
  readonly theme: ThemeSelection;
  // [LAW:types-are-the-program] The style as far as it can be resolved HERE
  // (brandon-looks-pe6). A session pick, a staged fragment and a plain
  // `globals.style` all resolve to a `decided` arm; a `globals.style` holding a
  // TEMPLATE resolves to an `expression` arm, which the view finishes — so it
  // is also the one place `style.effective` is published.
  readonly style: StyleSelection;
  // The looping effect the bar wears, as far as it can be resolved here — the
  // style's twin, settled by the view under a rule for the same reason.
  readonly effect: EffectSelection;
  // The active PRESET name — effectivePresetName(sessionState.preset,
  // globals.preset, presets), collapsed to the floor if stale. Unlike every
  // other field here it is not itself a display value: it is the name of the
  // fragment whose `globals` were merged to PRODUCE the rest of this struct,
  // carried alongside so a menu label states the arrangement that actually
  // rendered [LAW:one-source-of-truth].
  readonly preset: string;
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.5 — does the config
  // FILE author a root for the active preset (candybar-config-dqe: a `+`/`-`
  // edit writes the file, so "customized" and "hand-written" are one fact by
  // design), resolved alongside `preset` because both come from the SAME
  // entry.state read, or a diagnostic could name the wrong preset after a
  // reload lands mid-render. Not itself a display value either.
  readonly presetCustomized: boolean;
  // [LAW:one-source-of-truth] The cell separator `plain` renders between
  // segments (globals.default_separator). `string | undefined`, not a resolved
  // string, precisely because its floor is NOT ours: rich-js's bundled `plain`
  // joiner owns its own glyph and pickJoiner reads undefined as "draw it as
  // bundled", so naming a floor here would be a second copy of a constant
  // that lives in rich-js.
  readonly separator: string | undefined;
  // Each setting whose stored pick would have decided the bar and that its
  // domain no longer holds.
  readonly stale: readonly StalePick[];
};

// [LAW:single-enforcer] A display's checkbox admits its feed through its
// effective configuration, however that configuration was authored.
export const laneSwitches = (effective: EffectiveGlobals): LaneSwitches =>
  perLane((lane) => effective[LANES[lane].switch.setting]);

export function editGlobalsOf(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): Partial<Globals> {
  return sessionPick(EDIT_MODE_KEY) === EDIT_MODE_ARRANGE
    ? config.editGlobals
    : {};
}

// [LAW:one-type-per-behavior] THE fold for one valued field: the staged
// fragment over the session's pick over the config default over the row's
// floor — every valued field is this with its own row, so the precedence
// cannot land on one field and miss another. A config-only field has no pick
// rung, so the session is not asked for one.
function resolveValued<K extends ValuedField>(
  field: K,
  staged: Partial<Globals>,
  pick: StoredPick<ValuedGlobals[K]>,
  globals: Globals,
): ValuedGlobals[K] {
  return effectiveGlobal(
    staged[field] as ValuedGlobals[K] | undefined,
    pick,
    globals[field] as ValuedGlobals[K] | undefined,
    valuedRow(field).floor,
  );
}

// Each global setting's stored pick, parsed once by the config's table.
type GlobalPicks = { readonly [N in SettingName]: StoredPick<GlobalValue<N>> };

function globalPicks(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): GlobalPicks {
  const { global } = settingTable(config);
  return Object.fromEntries(
    SETTING_NAMES.map((name) => [
      name,
      pickOf<unknown>(global[name], sessionPick(global[name].key)),
    ]),
  ) as GlobalPicks;
}

// A valued field's pick: a config-only field has no pick rung.
const UNSET: StoredPick<never> = { kind: "unset" };
const valuedPickOf = <K extends ValuedField>(
  picks: GlobalPicks,
  field: K,
): StoredPick<ValuedGlobals[K]> =>
  (picks as Partial<Record<ValuedField, StoredPick<ValuedGlobals[K]>>>)[
    field
  ] ?? UNSET;

// [LAW:one-source-of-truth] The active preset a session's picks resolve to —
// the first rung of the resolution below.
export function presetOf(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): string {
  const { preset } = settingTable(config).global;
  return effectivePresetName(
    pickOf(preset, sessionPick(preset.key)),
    config.globals.preset,
    config.presets,
  );
}

// [LAW:one-source-of-truth] THE resolution — one function, so the precedence
// chain uses the session’s pick and whether the active preset was customized.
// [LAW:no-mode-explosion] A fresh session supplies empty picks to this same resolver.
export function resolveEffectiveGlobals(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  presetCustomized: (preset: string) => boolean,
): EffectiveGlobals {
  // The preset resolves FIRST: every field below reads globals, and which
  // globals is exactly what the preset decides.
  const preset = presetOf(config, sessionPick);
  const declared = presetGlobals(config, preset);
  // [LAW:dataflow-not-control-flow] The staged fragment is a VALUE, and "edit
  // mode is off" is the EMPTY value — the identity fragment, exactly as
  // PRESET_FLOOR's is. Every field below is resolved by the same expression
  // whether or not edit mode is on; only the contents of `staged` differ. This
  // is the whole of "no render-walk branch on edit mode": there is no branch
  // here either, so there is none to leak downstream.
  const staged = editGlobalsOf(config, sessionPick);
  // The theme resolves before the look, because the look's config-default
  // rung is the THEME's default folded under the declared globals
  // (src/config/theme-defaults.ts): which theme decides which fragment.
  // [LAW:one-source-of-truth] Every pick is read under the key the settings
  // write it under, and parsed once, here: the value below and the report of a
  // stale one are the same parse.
  const picks = globalPicks(config, sessionPick);
  const theme = resolveThemeSelection(
    staged.palette,
    picks.theme,
    declared.palette,
  );
  const globals = underThemeDefault(
    declared,
    themeDefaultsOf(theme, config.themeDefaults),
  );
  // [LAW:no-silent-failure] A stale pick is reported only where it would have
  // decided: a staged value outranks the session's pick, so it hides the miss.
  const { global } = settingTable(config);
  const stale = SETTING_NAMES.flatMap((name): StalePick[] => {
    const pick = picks[name];
    return pick.kind === "stale" &&
      staged[SETTINGS[name].configKey] === undefined
      ? [{ setting: global[name], stored: pick.raw }]
      : [];
  });
  return {
    ...(Object.fromEntries(
      VALUED_FIELDS.map((field) => [
        field,
        resolveValued(field, staged, valuedPickOf(picks, field), globals),
      ]),
    ) as ValuedGlobals),
    preset,
    presetCustomized: presetCustomized(preset),
    theme,
    style: resolveStyleSelection(
      staged.style,
      picks.style,
      globals.style,
      config.styles,
    ),
    effect: resolveEffectSelection(staged.effect, picks.effect, globals.effect),
    stale,
    // [LAW:one-source-of-truth] The separator has no SessionState half, so its chain is `staged ??
    // config` — the same `??`, minus the rungs it does not have.
    separator: staged.default_separator ?? globals.default_separator,
  };
}
