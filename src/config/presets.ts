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
import { applyLayoutOps, decodeLayoutOp } from "./layout-ops.js";

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

// [LAW:no-silent-failure] The persisted-overrides analogue of
// applySegmentPaletteOverrides' stale-segment skip (src/config/loader/
// merge.ts), one seam over: `configOverridesPath()` is ONE file shared by
// every project on the machine (candybar-config-engine-71o.2), but `presets`
// is a PER-CONFIG domain — the one other per-config domain besides `looks`.
// A `persist: "preset"` click writes a name valid for the config it was
// clicked against; loading a DIFFERENT project whose config never declared
// that name must not fail the whole render. validateConfig's cross-ref check
// (loader/cross-ref.ts) stays fatal for a hand-AUTHORED `globals.preset` —
// that is a typo in a file the author can see and fix — but a value that
// only exists because the overrides layer supplied it gets the SAME
// treatment a stale SessionState pick already gets from effectivePresetName:
// an undeclared name is not a pick at all, so the resolution moves on to the
// next rung of the precedence chain — visibly, never a throw. (For a stale
// SESSION pick that next rung is the config's own `globals.preset`, and only
// then the floor; for the field dropped here it is whatever the config file
// itself declares. Same rule, different starting rung —
// see effectiveGlobal in themes/policy.ts.) Dropping the field here (so it
// never reaches validateConfig) is what applies that rule to this layer too,
// instead of a fatal error replacing the whole bar.
export function sanitizePersistedPresetOverride(
  globalsOverride: Partial<Globals>,
  declaredPresets: Readonly<Record<string, PresetDecl>>,
): Partial<Globals> {
  const preset = globalsOverride.preset;
  if (preset === undefined || presetNames(declaredPresets).includes(preset)) {
    return globalsOverride;
  }
  // [LAW:no-defensive-null-guards] Not a broken-invariant throw: an
  // overrides file legitimately outlives any one config's preset names, so
  // this IS the expected shape, not a caller bug — a plain drop, mirroring
  // applySegmentPaletteOverrides' `continue` for the identical reason.
  const rest = { ...globalsOverride };
  delete rest.preset;
  return rest;
}

// [LAW:no-silent-failure] sanitizePersistedPresetOverride's twin for the
// SAME machine-global overrides file, one field over: `presets.<name>.
// rootOps` entries persist by NAME, and that name only has meaning against
// the config it was clicked against. Loading a DIFFERENT project's config
// — one that never declared "compact", say — would otherwise reach
// applyPresetRootOpsOverrides -> presetRoot -> presetByName, which THROWS
// for an undeclared name (correctly so for a hand-AUTHORED preset root: a
// typo in a file the author can see). A stale overrides entry is not that
// — it is the expected shape of a file that outlives any one project's
// preset names — so it gets the SAME treatment sanitizePersistedPresetOverride
// already gives `globals.preset`: dropped before replay ever sees it,
// never a fatal error replacing an unrelated project's entire bar
// (brandon-layout-edit-2gc.5 PR review).
export function sanitizePersistedPresetRootOps(
  presetRootOps: Readonly<Record<string, readonly string[]>>,
  declaredPresets: Readonly<Record<string, PresetDecl>>,
): Readonly<Record<string, readonly string[]>> {
  const known = new Set(presetNames(declaredPresets));
  const entries = Object.entries(presetRootOps).filter(([name]) =>
    known.has(name),
  );
  // [LAW:carrying-cost] Identity return when nothing was dropped — the
  // common case (this daemon serves one project, or every persisted name
  // happens to be declared) costs one Set build and no new allocation.
  if (entries.length === Object.keys(presetRootOps).length) {
    return presetRootOps;
  }
  return Object.fromEntries(entries);
}

// [LAW:one-source-of-truth] brandon-layout-edit-2gc.1's replay step — the
// SAME "patch an already-merged config" shape applySegmentPaletteOverrides
// (src/config/loader/merge.ts) uses one field over, run at the SAME point in
// RenderCache.buildState (after the globals/segment-palette overrides, before
// validateConfig): for every preset with an accumulated op log, resolve its
// CURRENT root the normal way (presetRoot — bundled/user root, or the
// preset's own declared fragment) and replay the ops on top, writing the
// result back as that preset's `root`. Every later reader (presetRoot,
// registerDslConfig's per-preset compile, validateConfig's cross-ref walk)
// sees the patched tree as if it had been authored that way — no second
// resolution path [LAW:locality-or-seam].
//
// [LAW:no-silent-failure] exception: an op whose target/anchor names a
// segment absent from the CURRENT tree is a no-op (layout-ops.ts's own
// documented policy) — a validated action can only ever name a segment the
// config declares at the time it was clicked, so a miss here only happens
// after a LATER edit (a config change, or an earlier op in the same list)
// already removed it. A malformed individual token (decodeLayoutOp -> null;
// can only arise from hand-edited or previous-version state, never from this
// process's own encodeLayoutOp) is filtered the same way, never applied.
// [LAW:one-source-of-truth] brandon-layout-edit-2gc.5's diagnostic seam — the
// ONE definition of "does this preset's rendered layout currently differ
// from what's literally declared in the config file", read from the SAME
// raw op-log record applyPresetRootOpsOverrides replays (never re-derived by
// diffing the replayed tree against a fresh presetRoot() call, which would
// be a second, weaker definition — a structural coincidence between two
// unrelated edits could equal zero net ops and still disagree with the raw
// log's own length). A name absent from the record (never edited) and a
// name present with an empty token list (edited down to nothing, e.g. by
// undo) are the SAME "not customized" — presence in the record only ever
// means "this reload's overrides file had an entry", not "and it's non-
// empty" [LAW:no-defensive-null-guards].
//
// Decodes each token the SAME way applyPresetRootOpsOverrides does, rather
// than trusting the raw token COUNT — a token list where every token
// decodes to null (malformed, or written by a previous protocol version)
// is exactly the case applyPresetRootOpsOverrides itself treats as "no ops
// to replay" (`ops.length === 0 → continue`, leaving the root untouched).
// Counting raw tokens would disagree with that: "customized" would read
// true over a tree that is, in fact, byte-identical to the literal
// declared root — the inverted form of the drift this diagnostic exists to
// catch.
//
// [LAW:carrying-cost] Verifies DECODE only, not whether the decoded op's
// target/anchor still resolves against the CURRENT tree — that check would
// need this to duplicate applyLayoutOps' own stale-target resolution
// (a real walk of the tree) just to COUNT, on every render, a fact only a
// LATER hand-authored config edit can produce (removing a segment a stored
// op still names — see the stale-op comment on applyPresetRootOpsOverrides
// above). A rare, later-edit-triggered false "customized" is the honest,
// documented cost of keeping this an O(tokens) check rather than an O(tree)
// one; the doc at docs/interaction-authoring.md's "Knowing when a preset's
// layout has been edited" section states this same limit.
export function presetIsCustomized(
  presetRootOps: Readonly<Record<string, readonly string[]>>,
  name: string,
): boolean {
  const tokens = presetRootOps[name];
  if (tokens === undefined) return false;
  return tokens.some((t) => decodeLayoutOp(t) !== null);
}

export function applyPresetRootOpsOverrides(
  config: DslConfig,
  presetRootOps: Readonly<Record<string, readonly string[]>>,
): DslConfig {
  const entries = Object.entries(presetRootOps).filter(
    ([, tokens]) => tokens.length > 0,
  );
  if (entries.length === 0) return config;
  const presets: Record<string, PresetDecl> = { ...config.presets };
  for (const [name, tokens] of entries) {
    const ops = tokens.map(decodeLayoutOp).filter((op) => op !== null);
    if (ops.length === 0) continue;
    const { node } = presetRoot(config, name);
    presets[name] = {
      ...presetByName(config.presets, name),
      root: applyLayoutOps(node, ops),
    };
  }
  return { ...config, presets };
}
