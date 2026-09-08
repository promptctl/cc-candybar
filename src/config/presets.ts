// [LAW:one-source-of-truth] The preset RESOLUTION seam: which preset is active, what
// layout it stages, what globals it carries, answered from one map.
// [LAW:one-type-per-behavior] Selection rides the same per-config-member seam looks does.
// Precedence, ordered by how late each rung is decided — the one place it is written:
//   bundled default  <  CONFIG FILE  <  ACTIVE PRESET  <  session pick  <  EDIT MODE
// [LAW:dataflow-not-control-flow] Edit mode's rung is written nowhere, so leaving it restores the previous look.

// [LAW:one-way-deps] Type-only, so option-domain.ts can import from here without a runtime cycle.
import type {
  ContainerNode,
  DslConfig,
  Globals,
  PresetDecl,
} from "./dsl-types.js";
import { EMPTY_ROWS, mergeRoot, restages, rootNode } from "./root.js";
import { effectiveMemberName } from "../themes/policy.js";

// [LAW:one-source-of-truth] The floor preset's name, spelled once.
export const PRESET_FLOOR = "default";

// [LAW:dataflow-not-control-flow] The empty fragment is a value the lookup starts from, not a case it handles.
const FLOOR_FRAGMENT: PresetDecl = {};

// [LAW:one-source-of-truth] THE preset domain: menu, admitted click and compiled layouts are one set.
export function presetNames(
  presets: Readonly<Record<string, unknown>>,
): readonly string[] {
  return [...new Set([PRESET_FLOOR, ...Object.keys(presets)])];
}

// [LAW:one-type-per-behavior] The shared per-config-member resolver, one dimension over:
// a stale name collapses to the floor, republished so label and layout agree [LAW:no-silent-failure].
export function effectivePresetName(
  sessionPreset: string | null,
  globalsPreset: string | undefined,
  declaredPresets: Readonly<Record<string, PresetDecl>>,
): string {
  // [LAW:types-are-the-program] A globals fragment cannot select a preset, so no staged rung resolves here.
  return effectiveMemberName(
    undefined,
    sessionPreset,
    globalsPreset,
    PRESET_FLOOR,
    declaredPresets,
  );
}

// [LAW:single-enforcer] The one place an effective preset NAME becomes a fragment.
// [LAW:no-defensive-null-guards] The throw is the loud failure for a caller that skipped
// the resolution, never a fallback that renders one arrangement under another's label.
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

// A preset's layout AND the config path it was authored at, as a total function of the
// name. [LAW:one-source-of-truth] Both come from ONE decision, so they cannot drift.
export function presetRoot(
  config: DslConfig,
  name: string,
): { readonly node: ContainerNode; readonly path: string } {
  // [LAW:dataflow-not-control-flow] One merge for every preset; the empty fragment is the identity.
  const fragment = presetByName(config.presets, name).root ?? EMPTY_ROWS;
  return {
    node: rootNode(mergeRoot(fragment, config.root)),
    path: restages(fragment) ? `presets.${name}.root` : "root",
  };
}

// [LAW:dataflow-not-control-flow] Shallow-merged per field: naming `padding` says nothing about `charset`.
export function presetGlobals(config: DslConfig, name: string): Globals {
  return { ...config.globals, ...presetByName(config.presets, name).globals };
}
