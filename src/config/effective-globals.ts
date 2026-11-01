// [LAW:one-source-of-truth] The ONE resolution of a session's globals: the
// precedence chain (staged › session pick › active preset's globals › the
// theme's default › floor) every renderer draws through. It sits below the
// renderer so drawDsl resolves an omitted selection through it rather
// than through a copy of its own (candybar-theme-colours-6fq5.0ub).

import { LANES, perLane, type LaneSwitches } from "./lanes.js";
import { effectivePresetName, presetGlobals } from "./presets.js";
import { EDIT_MODE_ARRANGE, EDIT_MODE_KEY } from "./loader/edit-mode.js";
import type { DslConfig, Globals } from "./dsl-types.js";
import {
  VALUED_FIELDS,
  valuedRow,
  type ValuedField,
  type ValuedGlobals,
} from "./globals-fields.js";
import {
  resolveStyleSelection,
  type StyleSelection,
  resolveEffectSelection,
  type EffectSelection,
  effectiveGlobal,
} from "../themes/policy.js";
import {
  resolveThemeSelection,
  type ThemeSelection,
} from "../themes/palette-resolvers.js";
import { themeDefaultsOf, underThemeDefault } from "./theme-defaults.js";

// [LAW:one-source-of-truth] Each of these is resolved exactly ONCE per render,
// here: by the daemon (draw-bar.ts, before both the payload build and drawDsl's
// BuildLineOptions), and by drawDsl itself for a caller that hands it no
// selection — so the value a trigger label displays and the value that
// actually shaped the render can never disagree.
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
  // until drawDsl pushes them. So drawDsl finishes that one rung, and is
  // therefore also the one place `theme.effective` is published — which is why
  // the payload carries no `theme` field and the server hands drawDsl no
  // separate base palette.
  readonly theme: ThemeSelection;
  // [LAW:types-are-the-program] The style as far as it can be resolved HERE
  // (brandon-looks-pe6). A session pick, a staged fragment and a plain
  // `globals.style` all resolve to a `decided` arm; a `globals.style` holding a
  // TEMPLATE resolves to an `expression` arm, which drawDsl finishes — so it
  // is also the one place `style.effective` is published.
  readonly style: StyleSelection;
  // The looping effect the bar wears, as far as it can be resolved here — the
  // style's twin, settled by drawDsl under a rule for the same reason.
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
};

// Which lanes a session's settings switch on — each lane's toggle as the
// resolution resolved it, on while its switch's setting holds the value that
// turns it on, and, for a switch that is `inTmux`, while the session's client
// reports it in a tmux pane.
// [LAW:single-enforcer] The one place "outside tmux ignores the renderer"
// is decided: the draw, the feed and a click's before/after all read lanes
// here, so no setup ever runs for a lane a session cannot have.
export const laneSwitches = (
  effective: EffectiveGlobals,
  inTmux: boolean,
): LaneSwitches =>
  perLane((lane) => {
    const { setting, on, inTmux: needsTmux } = LANES[lane].switch;
    return effective[setting] === on && (inTmux || !needsTmux);
  });

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
): ValuedGlobals[K] {
  const row = valuedRow(field);
  return effectiveGlobal(
    staged[field] as ValuedGlobals[K] | undefined,
    row.kind === "session" ? sessionPick(field) : null,
    globals[field] as ValuedGlobals[K] | undefined,
    row.floor,
    row.parse,
  );
}

// [LAW:one-source-of-truth] The active preset a session's picks resolve to —
// the first rung of the resolution below, and what a session's view declares
// its holds by (src/daemon/cache/render.ts openView).
export function presetOf(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
): string {
  return effectivePresetName(
    sessionPick("preset"),
    config.globals.preset,
    config.presets,
  );
}

// [LAW:one-source-of-truth] THE resolution — one function, so the precedence
// chain has one implementation rather than one per caller. It previously stood
// as two structurally identical struct literals (the daemon's, in draw-bar.ts,
// and `cc-candybar check`'s), which is two clocks: the check command's job is
// to render what the daemon would render, and a rung added to one copy is a
// rung silently missing from the other. The callers differ only in WHERE a
// session value comes from and whether the file authors the active preset's
// root, so both arrive as parameters and nothing else forks
// [LAW:dataflow-not-control-flow].
//
// `sessionPick` is the reader for one SessionState key. `check` passes a
// function returning null for every key — a fresh session that has never
// clicked — rather than a null store, so "no session" travels as a VALUE
// through the same chain a real session travels [LAW:no-mode-explosion].
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
  const staged: Partial<Globals> =
    sessionPick(EDIT_MODE_KEY) === EDIT_MODE_ARRANGE ? config.editGlobals : {};
  // The theme resolves before the look, because the look's config-default
  // rung is the THEME's default folded under the declared globals
  // (src/config/theme-defaults.ts): which theme decides which fragment.
  const theme = resolveThemeSelection(
    staged.palette,
    sessionPick("theme"),
    declared.palette,
  );
  const globals = underThemeDefault(
    declared,
    themeDefaultsOf(theme, config.themeDefaults),
  );
  return {
    ...(Object.fromEntries(
      VALUED_FIELDS.map((field) => [
        field,
        resolveValued(field, staged, sessionPick, globals),
      ]),
    ) as ValuedGlobals),
    preset,
    presetCustomized: presetCustomized(preset),
    theme,
    style: resolveStyleSelection(
      staged.style,
      sessionPick("style"),
      globals.style,
      config.styles,
    ),
    effect: resolveEffectSelection(
      staged.effect,
      sessionPick("effect"),
      globals.effect,
    ),
    // [LAW:one-source-of-truth] The separator has no SessionState half, so its chain is `staged ??
    // config` — the same `??`, minus the rungs it does not have.
    separator: staged.default_separator ?? globals.default_separator,
  };
}
