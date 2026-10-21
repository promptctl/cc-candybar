// [LAW:one-source-of-truth] The ONE resolution of a session's globals: the
// precedence chain (staged › session pick › active preset's globals › the
// theme's default › floor) every renderer draws through. It sits below the
// renderer so renderDsl resolves an omitted selection through it rather
// than through a copy of its own (candybar-theme-colours-6fq5.0ub).

import { LANES, LANE_FLOOR, perLane, type LaneSwitches } from "./lanes.js";
import { effectivePresetName, presetGlobals } from "./presets.js";
import { EDIT_MODE_ARRANGE, EDIT_MODE_KEY } from "./loader/edit-mode.js";
import type { DslConfig, Globals } from "./dsl-types.js";
import {
  effectiveAutoWrap,
  resolveStyleSelection,
  type StyleSelection,
  resolveEffectSelection,
  type EffectSelection,
  effectivePadding,
  effectiveEndcaps,
  effectiveVariation,
  effectiveShade,
  effectiveUpdateNotice,
  effectiveTransitions,
  effectiveGlobal,
  parseSessionBoolean,
  DEFAULT_COLOR_COMPATIBILITY,
  type ColorCompatibility,
  type Endcaps,
} from "../themes/policy.js";
import {
  resolveThemeSelection,
  type ThemeSelection,
} from "../themes/palette-resolvers.js";
import type { ShadeName, VariationName } from "../themes/decor.js";
import { themeDefaultsOf, underThemeDefault } from "./theme-defaults.js";

// [LAW:one-source-of-truth] The daemon resolves each of these exactly ONCE
// per render (server.ts, before both the payload build and renderDsl's
// BuildLineOptions), so the value a trigger label displays and the value
// that actually shaped the render can never disagree — the same reasoning
// theme/style already followed, generalized to every globals field a menu or
// stepper can persist. Those with a session pick compose it over the config
// default; `colorCompatibility` and `separator` have none and
// resolve from the config alone (see resolveEffectiveGlobals).
export interface EffectiveGlobals {
  // [LAW:types-are-the-program] The theme as far as it can be resolved HERE
  // (brandon-themes-dzl) — `style`'s twin one dimension over, and for the same
  // reason: a session pick, a staged fragment and a plain `globals.palette` all
  // resolve to a `decided` arm carrying the name AND the base palette it denotes,
  // while a `globals.palette` holding a TEMPLATE resolves to an `expression` arm,
  // because the store does not hold this render's values until renderDsl pushes
  // them. So renderDsl finishes that one rung, and is therefore also the one place
  // `theme.effective` is published — which is why the payload below carries no
  // `theme` field and the server hands renderDsl no separate base palette.
  readonly theme: ThemeSelection;
  // [LAW:types-are-the-program] The style as far as it can be resolved HERE
  // (brandon-looks-pe6). A session pick, a staged fragment and a plain
  // `globals.style` all resolve to a `decided` arm exactly as they always did; a
  // `globals.style` holding a TEMPLATE resolves to an `expression` arm, because
  // the store does not hold this render's values until renderDsl pushes them —
  // so renderDsl finishes that one rung, and is therefore also the one place
  // `style.effective` is published. That is why this struct carries no style NAME
  // and the payload below carries no `style` field.
  readonly style: StyleSelection;
  // The looping effect the bar wears, as far as it can be resolved here — the
  // style's twin, settled by renderDsl under a rule for the same reason.
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
  // design), resolved alongside `preset` (not a second lookup later) because
  // both come from the SAME entry.state read: the resolved name and the
  // authored-roots set must trace to one rebuild, or a diagnostic could name
  // the wrong preset after a reload lands mid-render. Not itself a display
  // value either — see `preset`'s own comment.
  readonly presetCustomized: boolean;
  readonly endcaps: Endcaps;
  // Which theme role each row of the closed bar wears — the render's
  // selection carries it into the walk (RenderSelection.variation).
  readonly variation: VariationName;
  // Which of its role's shades each cell of the closed bar wears — carried
  // into the walk beside the variation (RenderSelection.shade).
  readonly shade: ShadeName;
  // [LAW:one-source-of-truth] The cell separator `plain` renders between
  // segments (globals.default_separator). `string | undefined`, not a resolved
  // string, precisely because its floor is NOT ours: rich-js's bundled `plain`
  // joiner owns its own glyph and pickJoiner reads undefined as "draw it as
  // bundled", so naming a floor here would be a second copy of a constant that
  // lives in rich-js.
  // It has no SessionState half — the config global (as staged by whatever
  // fragment is on top) is its whole resolution.
  readonly separator: string | undefined;
  readonly colorCompatibility: ColorCompatibility;
  readonly autoWrap: boolean;
  readonly padding: number;
  // Whether the update notice may render for this session
  // (Globals.updateNotice) — a session pick over the config default, like
  // every other setting the menu controls. The per-version dismissal is a
  // separate thing, keyed on the update's identity.
  readonly updateNotice: boolean;
  // Whether placements fade in and dissolve out (Globals.transitions) — carried
  // into the walk by the render's selection (RenderSelection.transitions).
  readonly transitions: boolean;
  // Which animation lanes may subscribe to this session's frames (LANES).
  readonly lanes: LaneSwitches;
}

// [LAW:one-source-of-truth] THE resolution — one function, so the precedence
// chain has one implementation rather than one per caller. It previously stood
// as two structurally identical struct literals (the daemon's, in server.ts,
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
  const preset = effectivePresetName(
    sessionPick("preset"),
    config.globals.preset,
    config.presets,
  );
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
    endcaps: effectiveEndcaps(
      staged.endcaps,
      sessionPick("endcaps"),
      globals.endcaps,
    ),
    variation: effectiveVariation(
      staged.variation,
      sessionPick("variation"),
      globals.variation,
    ),
    shade: effectiveShade(staged.shade, sessionPick("shade"), globals.shade),
    // [LAW:one-source-of-truth] The fields with no SessionState half (this one,
    // colorCompatibility) resolve as `staged ?? config ?? floor` — the
    // same chain minus the rung they do not have, spelled with the same `??`
    // rather than a second mechanism.
    separator: staged.default_separator ?? globals.default_separator,
    autoWrap: effectiveAutoWrap(
      staged.autoWrap,
      sessionPick("autoWrap"),
      globals.autoWrap,
    ),
    padding: effectivePadding(
      staged.padding,
      sessionPick("padding"),
      globals.padding,
    ),
    updateNotice: effectiveUpdateNotice(
      staged.updateNotice,
      sessionPick("updateNotice"),
      globals.updateNotice,
    ),
    transitions: effectiveTransitions(
      staged.transitions,
      sessionPick("transitions"),
      globals.transitions,
    ),
    colorCompatibility:
      staged.colorCompatibility ??
      globals.colorCompatibility ??
      DEFAULT_COLOR_COMPATIBILITY,
    lanes: perLane((lane) => {
      const field = LANES[lane].setting;
      return effectiveGlobal(
        staged[field],
        sessionPick(field),
        globals[field],
        LANE_FLOOR,
        parseSessionBoolean,
      );
    }),
  };
}
