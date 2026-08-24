// [LAW:one-source-of-truth] The single point that merges a raw user config
// onto a default DslConfig to fill missing keys. A user file declares only
// what differs; the cascade here (shallow-merge globals, by-name merge
// variables/segments/actions, wholesale root replacement) is the one place
// "absent means inherit" is decided. This file changes when the merge
// semantics change.
//
// [LAW:one-way-deps] `dflt` is a required parameter — this module is generic
// merge machinery and does not know about DEFAULT_DSL_CONFIG, the specific
// bundled instance built ON TOP of it (default-dsl-config.ts imports this
// function to synthesize itself). A default param pointing back at
// DEFAULT_DSL_CONFIG would make this generic module depend on its own
// specific consumer, a cycle. Callers who want "the bundled default" import
// DEFAULT_DSL_CONFIG from default-dsl-config.ts and pass it explicitly.

import {
  type DslConfig,
  type RawDslConfig,
  type SegmentDecl,
} from "../dsl-types.js";

/**
 * Merge a RawDslConfig on top of a default DslConfig. Pure function.
 *
 *   globals    : shallow merge per field (user wins per-field)
 *   variables  : merge by name (user wins per-name)
 *   segments   : merge by name (user wins per-name)
 *   root       : the canonical layout tree. Authored via the A-grammar (`root`)
 *                replaces wholesale; absent → default's tree.
 *                [LAW:one-source-of-truth] `layout:` is rejected at parse time
 *                with a migration error (removed in 2de.19), so only `root`
 *                ever reaches this function.
 */
export function mergeWithDefault(
  raw: RawDslConfig,
  dflt: DslConfig,
): DslConfig {
  return {
    globals: { ...dflt.globals, ...(raw.globals ?? {}) },
    variables: { ...dflt.variables, ...(raw.variables ?? {}) },
    segments: { ...dflt.segments, ...(raw.segments ?? {}) },
    root: raw.root !== undefined ? raw.root : dflt.root,
    // [LAW:one-source-of-truth] actions merge by name, same cascade — a user
    // declares only the actions that differ from the bundled default (which
    // ships none).
    actions: { ...dflt.actions, ...(raw.actions ?? {}) },
    // [LAW:one-source-of-truth] looks merge by name, same cascade — a user
    // overrides one adaptation by re-declaring its name; the bundled stdlib
    // (incl. the "none" identity floor) survives every merge by construction.
    looks: { ...dflt.looks, ...(raw.looks ?? {}) },
    // [LAW:one-source-of-truth] presets merge by name, same cascade — a user
    // overrides one arrangement by re-declaring its name; the bundled stdlib
    // (incl. the "default" empty-fragment floor effectivePresetName collapses
    // to) survives every merge by construction, exactly as looks' "none" does.
    presets: { ...dflt.presets, ...(raw.presets ?? {}) },
    // [LAW:one-source-of-truth] helpers merge by name, same cascade — a user
    // overrides one formatter helper by re-declaring its name; the rest inherit
    // from the bundled default.
    helpers: { ...dflt.helpers, ...(raw.helpers ?? {}) },
  };
}

// [LAW:one-source-of-truth] The segment-scoped half of the config-overrides
// layer's merge (candybar-config-engine-71o.6) — the SAME "changes the
// DEFAULT, never the hand-authored file" precedence mergeWithDefault's
// `globals` cascade already applies, but patches ONE field (`palette`)
// inside an already-merged segment rather than replacing the segment
// wholesale. mergeWithDefault's `segments` cascade is deliberately per-name
// WHOLESALE replacement (a user overriding a segment restates it in full,
// same as any other by-name merge in this file) — routing a one-field
// override through that cascade would silently drop every other field the
// segment declares (template, bg, fg, when, vars...). This runs AFTER
// mergeWithDefault, directly against the already-merged config, so it never
// fights that cascade; it is its own, later, narrower merge step.
//
// [LAW:no-silent-failure] exception: a stale override naming a segment the
// config no longer declares is not a load-time error — the CONFIG, not the
// override, is the source of truth for which segments exist. Skipping it is
// a no-op, not a swallowed failure: a fresh `persist` write can only ever
// name a segment the config declares (cross-ref checks that at load time),
// so a dangling entry here only happens after a later config edit removed
// the segment, and there is nothing left for the override to apply to.
//
// [LAW:no-defensive-null-guards] exception: `Object.assign(Object.create(null),
// ...)` instead of `{ ...config.segments }` — the SAME null-prototype hygiene
// as the config-overrides-store.ts accumulators above (segment names come
// from user config and this loop WRITES via bracket assignment, `segments[name]
// = ...`, not a pure spread). Pure object spread never risks this (it defines
// every key directly, never invoking an inherited setter), but a stale
// override naming a since-removed segment `__proto__` hits exactly the
// "no own property yet, so the read returns the inherited accessor and the
// write invokes its setter" case a plain accumulator does not guard against.
export function applySegmentPaletteOverrides(
  config: DslConfig,
  overrides: Readonly<Record<string, string>>,
): DslConfig {
  const entries = Object.entries(overrides);
  if (entries.length === 0) return config;
  const segments: Record<string, SegmentDecl> = Object.assign(
    Object.create(null) as Record<string, SegmentDecl>,
    config.segments,
  );
  for (const [name, palette] of entries) {
    const seg = segments[name];
    if (seg === undefined) continue;
    segments[name] = { ...seg, palette };
  }
  return { ...config, segments };
}
