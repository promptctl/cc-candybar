// [LAW:one-source-of-truth] The ONE resolution of a session's globals: the
// precedence chain (staged › session pick › active preset's globals › the
// theme's default › floor) every renderer draws through.

import { LANES, perLane, type LaneSwitches } from "./lanes.js";
import { effectivePresetName, presetGlobals } from "./presets.js";
import { EDIT_MODE_ARRANGE, EDIT_MODE_KEY } from "./loader/edit-mode.js";
import type { DslConfig, Globals } from "./dsl-types.js";
import {
  perValuedField,
  settingNameOf,
  valuedRow,
  type SessionField,
  type ValuedField,
  type ValuedGlobals,
} from "./globals-fields.js";
import {
  resolveStyleSelection,
  type StyleSelection,
  resolveEffectSelection,
  type EffectSelection,
  effectiveGlobal,
  readStored,
  spellSetting,
  type Folded,
  type Selection,
  type StaleMiss,
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
  // globals.preset, presets). Unlike every
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
  // [LAW:no-silent-failure] Each pick the session stores outside its
  // setting's domain, where the session's rung would have been in force: the
  // folds' own answer, so a staged value that outranks a pick hides it. The
  // draw reports each, naming what the bar wears in its place.
  readonly stale: ReadonlyArray<StaleMiss<FoldedName>>;
};

// The name each fold of the resolution publishes its value under.
export type FoldedName = ValuedField | "preset" | "theme" | "style" | "effect";

// [LAW:single-enforcer] A display's checkbox admits its feed through its
// effective configuration, however that configuration was authored.
export const laneSwitches = (effective: EffectiveGlobals): LaneSwitches =>
  perLane((lane) => effective[LANES[lane].switch.setting]);

// [LAW:one-type-per-behavior] THE fold for one valued field: the staged
// fragment over the session's pick over the config default over the row's
// floor — every valued field is this with its own row, so the precedence
// cannot land on one field and miss another. A config-only field has no pick
// rung, so the session is not asked for one.
function resolveValued<K extends ValuedField>(
  field: K,
  staged: Partial<Globals>,
  sessionPick: (key: string) => string | null,
  globals: Globals,
): Folded<ValuedGlobals[K]> {
  const row = valuedRow(field);
  return effectiveGlobal(
    staged[field] as ValuedGlobals[K] | undefined,
    readStored(
      row.kind === "session"
        ? sessionPick(settingNameOf(field as SessionField))
        : null,
      row.parse,
    ),
    globals[field] as ValuedGlobals[K] | undefined,
    row.floor,
  );
}

// [LAW:one-source-of-truth] The active preset a session's picks resolve to —
// the first rung of the resolution below.
export function presetOf(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): Folded<string> {
  return effectivePresetName(
    // [LAW:one-source-of-truth] Read under the key a preset pick is written
    // under.
    sessionPick(settingNameOf("preset")),
    config.globals.preset,
    config.presets,
  );
}

// [LAW:one-source-of-truth] A resolved value in the spelling its SessionState
// key uses — the spelling a pick writes (`spellSetting`). A selection chosen
// by RULE has no name until a render evaluates it, so it is `null`.
export function spelledSetting(
  e: { readonly [K in FoldedName]: EffectiveGlobals[K] },
  name: FoldedName,
): string | null {
  const value: string | number | boolean | Selection<unknown> = e[name];
  if (typeof value !== "object") return spellSetting(value);
  return value.kind === "decided" ? value.name : null;
}

// [LAW:one-source-of-truth] THE resolution — one function, so the precedence
// chain uses the session’s pick and whether the active preset was customized.
// [LAW:no-mode-explosion] A fresh session supplies empty picks to this same resolver.
export function resolveEffectiveGlobals(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  presetCustomized: (preset: string) => boolean,
): EffectiveGlobals {
  const { stale, take } = foldTaker();
  // The preset resolves FIRST: every field below reads the globals it picks.
  const preset = take("preset", presetOf(config, sessionPick));
  const declared = presetGlobals(config, preset);
  // [LAW:dataflow-not-control-flow] The staged fragment is a VALUE, and "edit
  // mode is off" is the EMPTY value — the identity fragment, no branch.
  const staged: Partial<Globals> =
    sessionPick(EDIT_MODE_KEY) === EDIT_MODE_ARRANGE ? config.editGlobals : {};
  // The theme resolves before the look: the look's config default is the
  // THEME's default under the declared globals (src/config/theme-defaults.ts).
  const theme = take(
    "theme",
    resolveThemeSelection(
      staged.palette,
      sessionPick(settingNameOf("palette")),
      declared.palette,
    ),
  );
  const globals = underThemeDefault(
    declared,
    themeDefaultsOf(theme, config.themeDefaults),
  );
  const style = resolveStyleSelection(
    staged.style,
    sessionPick(settingNameOf("style")),
    globals.style,
    config.styles,
  );
  const effect = resolveEffectSelection(
    staged.effect,
    sessionPick(settingNameOf("effect")),
    globals.effect,
  );
  return {
    ...perValuedField((field) =>
      take(field, resolveValued(field, staged, sessionPick, globals)),
    ),
    preset,
    presetCustomized: presetCustomized(preset),
    theme,
    style: take("style", style),
    effect: take("effect", effect),
    // [LAW:one-source-of-truth] The separator has no SessionState half, so
    // its chain is `staged ?? config` — the same `??`, minus the rungs.
    separator: staged.default_separator ?? globals.default_separator,
    stale,
  };
}

// [LAW:no-silent-failure] Takes each fold's value with what it passed over:
// a fold published untaken is a `Folded` where a value is due, a type error.
function foldTaker(): {
  readonly stale: Array<StaleMiss<FoldedName>>;
  readonly take: <T>(setting: FoldedName, folded: Folded<T>) => T;
} {
  const stale: Array<StaleMiss<FoldedName>> = [];
  return {
    stale,
    take: (setting, folded) => {
      if (folded.stale !== null) stale.push({ setting, stored: folded.stale });
      return folded.value;
    },
  };
}
