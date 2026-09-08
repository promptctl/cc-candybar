// [LAW:one-source-of-truth] The one place "absent means inherit" is decided.
//
// [LAW:one-way-deps] `dflt` is a required parameter: defaulting it to
// DEFAULT_DSL_CONFIG, which is built on top of this function, would be a cycle.

import { type DslConfig, type RawDslConfig } from "../dsl-types.js";
import { EMPTY_ROWS, mergeRoot } from "../root.js";

/** Merge a RawDslConfig on top of a default DslConfig. Pure function. */
export function mergeWithDefault(
  raw: RawDslConfig,
  dflt: DslConfig,
): DslConfig {
  return {
    globals: { ...dflt.globals, ...(raw.globals ?? {}) },
    variables: { ...dflt.variables, ...(raw.variables ?? {}) },
    segments: { ...dflt.segments, ...(raw.segments ?? {}) },
    root: mergeRoot(raw.root ?? EMPTY_ROWS, dflt.root),
    actions: { ...dflt.actions, ...(raw.actions ?? {}) },
    looks: { ...dflt.looks, ...(raw.looks ?? {}) },
    presets: { ...dflt.presets, ...(raw.presets ?? {}) },
    editGlobals: { ...dflt.editGlobals, ...(raw.editGlobals ?? {}) },
    helpers: { ...dflt.helpers, ...(raw.helpers ?? {}) },
  };
}
