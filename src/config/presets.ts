// [LAW:one-source-of-truth] The preset RESOLUTION seam: the three questions a
// render asks about presets — which one is active, what layout does it stage,
// what display globals does it carry — answered in one place, from one map.
//
// A preset is to configuration what a look is to a theme, and that is the
// implementation instruction, not an analogy: the selection rides the SAME
// per-config-member seam looks rides (effectiveMemberName in themes/policy.ts),
// the domain is threaded as DATA through the same perConfigDomainsFor the click
// gate and the rendered options both read, and an unknown name collapses to the
// same kind of always-present floor. Nothing here is parallel machinery
// [LAW:one-type-per-behavior].
//
// WHERE THE PRESET LAYER SITS — the five-layer precedence chain, documented in
// full in docs/interaction-authoring.md ("persist / reset"), which is the ONE
// place it is written down:
//
//   bundled default  <  CONFIG FILE  <  ACTIVE PRESET  <  session pick
//                    <  EDIT MODE
//
// The preset's position is forced by its lifetime, not chosen. Everything to
// its left is resolved once per RenderCache entry (an entry serves many
// sessions: the config file is read in buildState — and it is the ONE durable
// store, candybar-config-dqe, so a `persist` click edits that same file);
// everything from the preset rightward is resolved per render, because the pick
// is per session. The chain is therefore monotonic in "how late is this
// decided", which is why a preset overrides the file's default (switching to a
// "compact" arrangement must actually change padding, even for a user who once
// persisted a padding they liked) while a session's own click still wins over
// the preset (a click is later still).
//
// The same rule places the last rung (candybar-settings-ui-aok.5): edit mode's
// `editGlobals` fragment is decided later than ANY session pick — a user picks
// a style, and only afterwards enters edit mode — so it is the new rightmost
// layer, and a session pick of "capsule" cannot survive into a mode whose whole
// job is to stop segments reading as one continuous strip. It differs from
// every rung to its left in LIFETIME rather than in kind: nothing writes it to
// SessionState or the config file, so leaving edit mode restores the
// previous look with no save/restore path — the session's own pick was never
// overwritten, only out-ranked [LAW:dataflow-not-control-flow]. The rung itself
// is the `staged` parameter of effectiveGlobal (themes/policy.ts); this comment
// is the ONE place the order is written down.

// [LAW:one-way-deps] Type-only, so nothing is emitted and option-domain.ts (a
// leaf that deliberately never imports dsl-types.ts) can import PRESET_NAMES
// from here without a runtime cycle.
import type {
  DslConfig,
  Globals,
  LayoutNode,
  PresetDecl,
} from "./dsl-types.js";
import { effectiveMemberName } from "../themes/policy.js";

// [LAW:one-source-of-truth] The floor preset's name, spelled once. `looks` has
// `"none"` (the identity adaptation); presets have `"default"` (the identity
// fragment — the empty PresetDecl, i.e. the config's own root and globals
// unchanged). The bundled default declares it and merge-by-name cannot remove
// it, so every merged DslConfig carries it by construction.
export const PRESET_FLOOR = "default";

// [LAW:dataflow-not-control-flow] The floor's fragment is the EMPTY one — no
// alternative root, no globals delta — which is exactly what "no preset chosen"
// already means. It is a value the lookup below starts from rather than a case
// the lookup handles, so the floor resolves whether or not any config declares
// it. The bundled default declares `default: {}` for a different job: to put the
// floor in the DOMAIN, so a `{{ menu }}` lists it and the derived click gate
// admits a click that returns to it. Domain membership and resolvability are two
// guarantees, and this one does not lean on the other.
const FLOOR_FRAGMENT: PresetDecl = {};

// [LAW:one-source-of-truth] THE preset domain: every arrangement selectable in
// this config — the declared alternatives with the floor always among them. The
// three readers that each need "the preset names" (perConfigDomainsFor, which
// feeds the rendered options AND the derived click gate; registerDslConfig's
// per-preset compile; the `presets` template binding) call this rather than
// spelling `Object.keys(config.presets)` themselves, so the menu you can see,
// the click the wire admits, and the layouts that were compiled are the same
// set by construction — a click returning to the floor cannot be rejected by a
// gate that forgot the floor was selectable.
//
// This is deliberately STRONGER than the looks seam it otherwise mirrors, where
// "none" is in the domain only because the bundled stdlib ships it. The floor's
// membership is a fact about the resolution, not about any config, so it is
// stated here once rather than depending on a merge going right.
export function presetNames(
  presets: Readonly<Record<string, unknown>>,
): readonly string[] {
  return [...new Set([PRESET_FLOOR, ...Object.keys(presets)])];
}

// [LAW:one-type-per-behavior] The preset domain's instance of the shared
// per-config-member resolver — the same call shape effectiveLookName makes, one
// dimension over. A stale or deleted name collapses to PRESET_FLOOR rather than
// throwing, and the caller publishes this RESOLVED name as `preset.effective`
// so the bar's label and the bar's layout can never disagree
// [LAW:no-silent-failure].
export function effectivePresetName(
  sessionPreset: string | null,
  globalsPreset: string | undefined,
  declaredPresets: Readonly<Record<string, PresetDecl>>,
): string {
  // [LAW:types-are-the-program] No staged rung, and the absence is enforced
  // rather than assumed: every globals fragment that could stage one — a
  // preset's own `globals`, edit mode's `editGlobals` — has `preset` swapped for
  // a rejection in its schema (loader/globals.ts), so "a fragment selected a
  // preset" is unrepresentable and there is nothing here to resolve against.
  // Which preset is active keeps exactly one authority.
  return effectiveMemberName(
    undefined,
    sessionPreset,
    globalsPreset,
    PRESET_FLOOR,
    declaredPresets,
  );
}

// [LAW:single-enforcer] The one place an effective preset NAME becomes the
// fragment a render reads — a declared preset, or the floor's identity fragment
// layered under them so the floor never depends on being declared. By the time
// a name reaches here it must be one of those: effectivePresetName collapses
// unknown names to the floor.
// [LAW:no-defensive-null-guards] the throw is the loud failure for that broken
// invariant (a caller that skipped the resolution and passed a raw session
// string), never a silent empty-fragment fallback that would render one
// arrangement while the bar's label named another — the exact contract
// lookKeyByName holds for looks.
export function presetByName(
  presets: Readonly<Record<string, PresetDecl>>,
  name: string,
): PresetDecl {
  const preset = { [PRESET_FLOOR]: FLOOR_FRAGMENT, ...presets }[name];
  if (preset === undefined) {
    throw new Error(
      `Preset "${name}" is not declared in this config — effectivePresetName ` +
        `collapses unknown names to "${PRESET_FLOOR}", which always resolves; ` +
        `a miss here means a raw name reached this function without going ` +
        `through that resolution`,
    );
  }
  return preset;
}

// A preset's layout AND the config path that layout was authored at, as a total
// function of the name: a preset that declares no `root` stages the config's own
// root, which lives at `root` and not under this preset's name.
//
// [LAW:one-source-of-truth] Both halves come from ONE decision on purpose. The
// fallback used to be resolved here while the diagnostic path was spelled
// separately at the compile site as `presets.<name>.root`, so the two disagreed
// for exactly the configs that never opted into presets at all: a plain config
// with no `presets:` block reported its own root's template errors under
// `presets.default.root`, naming a node the author never wrote. Returning the
// tree together with where it came from makes that drift unrepresentable rather
// than merely fixed [FRAMING:representation].
export function presetRoot(
  config: DslConfig,
  name: string,
): { readonly node: LayoutNode; readonly path: string } {
  // [LAW:dataflow-not-control-flow] A projection returning DATA, not a branch
  // around an operation: both arms yield the same shape, and the discriminator
  // (did this preset declare a root?) is a fact the fragment already carries.
  const own = presetByName(config.presets, name).root;
  return own === undefined
    ? { node: config.root, path: "root" }
    : { node: own, path: `presets.${name}.root` };
}

// [LAW:dataflow-not-control-flow] A preset's display globals, as a total
// function of the name: the config's globals with the preset's shallow-merged
// over them, per field — the SAME per-field cascade mergeWithDefault applies to
// `globals` everywhere else in the loader, so a preset naming `padding` says
// nothing about `charset`. The empty fragment yields the config's globals
// unchanged, so again no floor-shaped branch.
export function presetGlobals(config: DslConfig, name: string): Globals {
  return { ...config.globals, ...presetByName(config.presets, name).globals };
}
