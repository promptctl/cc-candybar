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
//   bundled default  <  user config file  <  persisted overrides
//                    <  ACTIVE PRESET  <  session pick
//
// The preset's position is forced by its lifetime, not chosen. Everything to
// its left is resolved once per RenderCache entry (an entry serves many
// sessions: the user file and the overrides file are both read in buildState);
// everything from the preset rightward is resolved per render, because the pick
// is per session. The chain is therefore monotonic in "how late is this
// decided", which is why a preset overrides a persisted default (switching to a
// "compact" arrangement must actually change padding, even for a user who once
// persisted a padding they liked) while a session's own click still wins over
// the preset (a click is later still).

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
  return effectiveMemberName(
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

// [LAW:dataflow-not-control-flow] A preset's layout, as a total function of the
// name: a preset that declares no `root` stages the config's own root. That is
// the identity element of this projection, not a "has a root?" special case —
// which is exactly what makes the floor preset (the empty fragment) need no
// arm of its own.
export function presetRoot(config: DslConfig, name: string): LayoutNode {
  return presetByName(config.presets, name).root ?? config.root;
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
