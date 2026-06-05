// [LAW:one-source-of-truth] The single point that consults DEFAULT_DSL_CONFIG to
// fill missing keys. A user file declares only what differs; the cascade here
// (shallow-merge globals, by-name merge variables/segments/actions, wholesale
// layout/root replacement) is the one place "absent means inherit" is decided.
// This file changes when the merge semantics change.

import { type DslConfig, type RawDslConfig } from "../dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "../default-dsl-config.js";
import { layoutRowsToNode } from "./layout.js";

/**
 * Merge a RawDslConfig on top of a default DslConfig. Pure function.
 *
 *   globals    : shallow merge per field (user wins per-field)
 *   variables  : merge by name (user wins per-name)
 *   segments   : merge by name (user wins per-name)
 *   root       : the canonical layout tree. Authored directly (`root`) wins;
 *                else the flat `layout` sugar is compiled to a tree
 *                (layoutRowsToNode); else the default's tree. `layout` replaces
 *                wholesale when present (including explicit `[]`, which compiles
 *                to an empty container = "render no segments"). Only when the
 *                user wrote NEITHER `root` nor `layout` does the default apply.
 *                [LAW:one-source-of-truth] The two authoring surfaces collapse
 *                to one `root` here; parseDslConfig rejects writing both.
 */
export function mergeWithDefault(
  raw: RawDslConfig,
  dflt: DslConfig = DEFAULT_DSL_CONFIG,
): DslConfig {
  return {
    globals: { ...dflt.globals, ...(raw.globals ?? {}) },
    variables: { ...dflt.variables, ...(raw.variables ?? {}) },
    segments: { ...dflt.segments, ...(raw.segments ?? {}) },
    root:
      raw.root !== undefined
        ? raw.root
        : raw.layout !== undefined
          ? layoutRowsToNode(raw.layout)
          : dflt.root,
    // [LAW:one-source-of-truth] actions merge by name, same cascade — a user
    // declares only the actions that differ from the bundled default (which
    // ships none).
    actions: { ...dflt.actions, ...(raw.actions ?? {}) },
    // [LAW:one-source-of-truth] helpers merge by name, same cascade — a user
    // overrides one formatter helper by re-declaring its name; the rest inherit
    // from the bundled default.
    helpers: { ...dflt.helpers, ...(raw.helpers ?? {}) },
  };
}
