// [LAW:single-enforcer] registerDslConfig + renderDsl are THE two spine
// functions the daemon calls verbatim. No parallel registration path, no
// alternate render path. bzh.2 reuses these; it does not reimplement them.
//
// [LAW:one-source-of-truth] registerDslConfig is the single JSON-shape →
// runtime translation. Every VariableDecl kind maps to exactly one
// SourceRegistry.declare* call here, and template pre-compilation happens
// exactly once (at registration, not per render).
//
// [LAW:dataflow-not-control-flow] Both functions execute unconditionally;
// the input values (kind discriminators, layout length, palette presence)
// govern output, not whether operations run.

import type { RichText, Palette, ThemeKey } from "@promptctl/rich-js";
import { ColorSpec, Style, lighten, IDENTITY } from "@promptctl/rich-js";
import type { Engine, Template } from "@promptctl/go-template-js";
import type {
  ValidatedConfig,
  VariableDecl,
  CacheDecl,
  LayoutNode,
} from "../config/dsl-types.js";
import { HUE_STEP_VAR } from "../config/dsl-types.js";
import { perConfigDomainsFor } from "../config/option-domain.js";
import { PRESET_FLOOR, presetNames, presetRoot } from "../config/presets.js";
import type { VariableStore } from "../var-system/store.js";
import type { SourceRegistry } from "../var-system/sources.js";
import {
  parseDuration,
  type CachePolicy,
  type GitField,
} from "../var-system/sources.js";
import type { BuildLineOptions } from "../render/strip.js";
import { DEFAULT_PADDING, renderStripCells } from "../render/strip.js";
import { paletteForThemeName } from "../themes/index.js";
import { buildScope } from "../template-engine/scope.js";
import {
  createCcCandybarEngine,
  evaluateWhen,
  resolveSegmentColors,
} from "../template-engine/index.js";
import {
  compileActions,
  actionFuncs,
  type ActionRuntime,
} from "../render/action.js";
import { pickerFuncs } from "../render/picker.js";
import {
  menuFuncs,
  collectMenuDrops,
  type MenuRuntime,
} from "../render/menu.js";
import {
  createActiveSegmentRef,
  type ActiveSegmentRef,
} from "../render/active-segment.js";
import { segmentColorFuncs } from "../render/segment-color.js";
// [LAW:one-way-deps] The node-type registry sits below this driver: it owns the
// compiled node shapes + each kind's compile/render, dispatched via nodeType().
// render.ts threads the recursion (compileChild/renderChild) + the hue counter in
// as capabilities; it never re-switches on node kind.
import {
  nodeType,
  type CompiledNode,
  type CompiledSegment,
  type CompiledSegments,
  type RenderedLines,
  type NodeCompileCtx,
  type NodeRenderCtx,
} from "./node-registry.js";

// ─── Compiled config ───────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The full compiled artifact registerDslConfig
// produces: every segment's compiled templates AND the compiled layout tree
// (nodes with parsed `when`). renderDsl needs both; bundling them keeps the
// daemon cache holding one value, not two that could fall out of sync. The
// compiled node + segment shapes live in node-registry (the render layer that
// owns node behavior); this driver only assembles + walks them.
export interface CompiledConfig {
  readonly segments: CompiledSegments;
  // [LAW:dataflow-not-control-flow] EVERY preset's layout, compiled up front and
  // keyed by preset name — the render selects one by name rather than compiling
  // per session. This is the same move `looks` makes one level down (every
  // look's ThemeKey is resolved at load; the render picks one), and it is what
  // lets a per-SESSION preset pick ride a per-ENTRY compilation: one RenderCache
  // entry serves many sessions, so nothing session-shaped may be compiled here.
  // Total over `presetNames` — every selectable name, floor included — so the
  // lookup needs no absent case. A preset declaring no `root` of its own maps
  // to the config's own compiled root: the identity element, not a special
  // case.
  readonly roots: ReadonlyMap<string, CompiledNode>;
  // [LAW:locality-or-seam] The menu runtime the engine's `menu` func closes over.
  readonly menuRuntime: MenuRuntime;
  // [LAW:one-source-of-truth] The single "which segment is rendering" record
  // every segment-scoped template function reads — the menu's identity, the
  // `color` func's palette, the `bgOf` func's background. Surfaced here so the
  // walk can publish into it. One instance per compiled config; mutated
  // synchronously within a single renderDsl walk (renders are sequential +
  // synchronous, so no cross-render leak) — the spatial cousin of the hue
  // cursor, one owner. [LAW:no-ambient-temporal-coupling]
  readonly activeSegment: ActiveSegmentRef;
  // [LAW:types-are-the-program] Variable declaration failures that did NOT
  // prevent the config from loading (type mismatches, bad defaults). The
  // affected variables are absent from the store; segments that reference them
  // render as error cells. Non-empty means "partial load" — the config is
  // usable but degraded.
  readonly loadWarnings: readonly string[];
}

// ─── CacheDecl → CachePolicy ─────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] One arm per CacheDecl variant; the in-check
// is the discriminator, not control flow. Adding a new variant requires one
// new arm here and a matching CacheDecl arm in dsl-types.
function toCachePolicy(cache: CacheDecl): CachePolicy {
  if ("ttl" in cache)
    return { kind: "ttl", durationMs: parseDuration(cache.ttl) };
  if ("watch_file" in cache)
    return { kind: "watch_file", path: cache.watch_file };
  if ("depends_on" in cache)
    return { kind: "depends_on", varNames: cache.depends_on };
  if ("key" in cache) return { kind: "key", template: cache.key };
  if ("never" in cache) return { kind: "never" };
  throw new Error(
    `Unknown CacheDecl discriminator — loader invariant violated: ${JSON.stringify(cache)}`,
  );
}

// ─── Single variable declaration ──────────────────────────────────────────────

// [LAW:single-enforcer] One function dispatches every VariableDecl kind to its
// SourceRegistry method. No other code path declares variables.
function declareOne(
  registry: SourceRegistry,
  name: string,
  decl: VariableDecl,
  cwd: string,
): void {
  switch (decl.kind) {
    case "literal":
      registry.declareLiteral(name, decl.value as string | number | boolean);
      break;

    case "input":
      // [LAW:types-are-the-program] The loader validated that `decl.type` is
      // one of "string"|"number"|"boolean" and that `decl.default` (if
      // present) matches that type. Absent type defaults to "string" — every
      // existing declaration that omits the field reads a string at the
      // resolved payload path.
      registry.declareInput(
        name,
        decl.path,
        decl.type ?? "string",
        decl.default,
      );
      break;

    case "env":
      registry.declareEnv(name, decl.name, decl.default);
      break;

    case "file":
      registry.declareFile(name, decl.path, {
        readMode: decl.readMode,
        regex: decl.regex,
        cache: toCachePolicy(decl.cache),
        varDefault: decl.default,
      });
      break;

    case "shell":
      registry.declareShell(name, decl.command, {
        regex: decl.regex,
        cache: toCachePolicy(decl.cache),
        varDefault: decl.default,
      });
      break;

    case "template":
      registry.declareTemplate(name, decl.template, {
        varDefault: decl.default,
      });
      break;

    case "time":
      // [LAW:types-are-the-program] TimeVarDecl.cache is ttl-only by
      // construction — the loader rejects every other CacheDecl form at load
      // (the runtime honors no other invalidation on a clock-driven var), so
      // the mapping here is total, not a silent coercion.
      registry.declareTime(name, {
        format: decl.layout,
        ttlMs: decl.cache ? parseDuration(decl.cache.ttl) : undefined,
        varDefault: decl.default,
      });
      break;

    case "git":
      registry.declareGit(name, {
        field: decl.field as GitField,
        cwd,
        varDefault: decl.default,
      });
      break;

    case "state":
      registry.declareState(name, {
        key: decl.key,
        ...(decl.default !== undefined && { varDefault: decl.default }),
      });
      break;
  }
}

// ─── Helper preamble ─────────────────────────────────────────────────────────

// [LAW:single-enforcer] Compile the config's shared helper templates into ONE
// output-neutral preamble: each name→body becomes a `{{ define "name" }}body{{ end }}`
// block, concatenated with no interstitial text so the preamble emits nothing.
// Prepended to every template this config parses, the defines resolve a
// `{{ template "name" .arg }}` call locally — go-template-js scopes defines to a
// single parse unit, so the define and the call MUST share one parse.
// [LAW:no-silent-fallbacks] Each body is parsed in ISOLATION first, so a malformed
// helper surfaces a per-helper diagnostic rather than a confusing error blamed on
// the first segment that happens to call it.
// [LAW:dataflow-not-control-flow] Empty helpers ⇒ "" ⇒ `engine.parse("" + src)`
// is byte-identical to `engine.parse(src)`: existing configs are unaffected with
// no special-case branch.
function compileHelperPreamble(
  engine: Engine<RichText>,
  helpers: Readonly<Record<string, string>>,
): string {
  let preamble = "";
  for (const [name, body] of Object.entries(helpers)) {
    const define = `{{ define "${name}" }}${body}{{ end }}`;
    try {
      engine.parse(define);
    } catch (e) {
      throw new Error(
        `Template parse error in helpers.${name}: ${(e as Error).message}`,
        { cause: e },
      );
    }
    preamble += define;
  }
  return preamble;
}

// ─── registerDslConfig ────────────────────────────────────────────────────────

/**
 * Translate a validated DslConfig into the live VariableStore + SourceRegistry
 * and pre-parse all segment templates.
 *
 * Walks config.variables (global vars) and each segment's vars sub-block
 * (namespaced as segName.varName) and calls the matching SourceRegistry
 * declare* method for each VariableDecl. Also pre-parses every segment's
 * when/template/bg/fg strings once — renderDsl only evaluates.
 *
 * Call once per config (at startup or hot-reload). The daemon calls this;
 * the render loop calls renderDsl with the returned CompiledConfig.
 *
 * HOT-RELOAD: pass a fresh VariableStore + SourceRegistry on each call.
 * defineBox/defineComputed throws if a variable name is already declared in
 * the same store — there is no reset or un-declare path. Callers must call
 * registry.dispose() on the old registry (to stop timers, watchers, and git
 * subscriptions) and then construct new store/registry instances before calling
 * again. Dropping the old registry without dispose() leaks resources and may
 * keep the process alive.
 *
 * [LAW:one-source-of-truth] THE JSON-shape→runtime translation. No other
 * module re-derives this mapping.
 * [LAW:dataflow-not-control-flow] The kind discriminator in declareOne selects
 * the declare* call; no special-casing beyond the closed source-kind set.
 *
 * [LAW:one-source-of-truth] Segment-local vars: stored under the namespaced
 * key segName.varName, referenced from templates ONLY via that namespaced
 * form. The scope proxy resolves keys literally present in the store, and the
 * loader's cross-ref validator enforces the identical rule at load time (a
 * bare own-segment ref is a load diagnostic naming the namespaced form).
 * Validator and runtime share one definition of what a template may
 * reference; bare-name aliasing is deliberately NOT a thing — it would make a
 * ref's meaning depend on which segment is rendering instead of on the ref
 * string alone.
 */
export function registerDslConfig(
  config: ValidatedConfig,
  registry: SourceRegistry,
  opts?: { cwd?: string; clock?: () => Date },
): CompiledConfig {
  const cwd = opts?.cwd ?? process.cwd();

  // [LAW:locality-or-seam] One engine per config load, carrying THIS config's
  // action runtime. Engine creation amortizes across all of this config's segment
  // templates (parse-once); per-config (not per-render) is the right granularity
  // because the action set is config-scoped. The runtime holder is populated below
  // — the `action`/`picker` funcs reference the engine, and the compiled actions
  // reference the engine, so the holder breaks that cycle.
  // [LAW:one-source-of-truth] The action runtime reads through the SAME store the
  // registry declares into and the renderer reads back — sourced from the registry
  // itself, not a redundant opts field a caller could forget (or pass a divergent
  // store for). Every config has a registry, so the action store is never null.
  const actionRuntime: ActionRuntime = {
    store: registry.variableStore,
    compiled: new Map(),
    // [LAW:types-are-the-program] Always present — renderDsl republishes the live
    // style each render; "powerline" is the registration-time default so a
    // compile-only path (no render) still has a valid value.
    stripStyle: "powerline",
    // Same contract as stripStyle: renderDsl republishes the live resolved
    // globals.padding each render; the constant is only the compile-only floor.
    padding: DEFAULT_PADDING,
  };
  // [LAW:one-way-deps] Inject action + picker feature funcs as data — the engine
  // stays generic. The picker shares the ACTION runtime (it resolves its
  // apply/page actions from the same compiled table), so they read one source.
  // [LAW:single-enforcer] Forward the caller's clock (the daemon's `() => new
  // Date()`, a test's frozen clock) to the one engine. Omitted ⇒ undefined ⇒
  // createCcCandybarEngine applies its single default; no second default literal.
  // [LAW:one-source-of-truth] ONE record for "which segment is rendering", read
  // by every segment-scoped template function: `{{ menu }}` takes its identity
  // from the name, `{{ color }}` its palette, `{{ bgOf }}` its background. A
  // per-feature pointer would let two features disagree about which segment is
  // current. Built before the engine so the funcs can close over it; `current`
  // stays null until a render walk publishes one.
  const activeSegment = createActiveSegmentRef();
  // [LAW:locality-or-seam] The menu runtime shares the action runtime (a menu's
  // glyph + body resolve from the same compiled table + store) and reads the
  // active segment through the shared record above.
  const menuRuntime: MenuRuntime = {
    action: actionRuntime,
    activeSegment,
  };
  // [LAW:one-source-of-truth] The config's look names — the one PER-CONFIG
  // option domain. Fed to every consumer (the `looks()` binding below, and —
  // via perConfigDomainsFor, the SAME construction cross-ref.ts and
  // state-validators.ts use — the compiled set-option domains), so the
  // rendered options, a hand-authored `range looks`, and the derived click
  // gate (which reads the same config in deriveActionValidators) trace to
  // one source.
  const lookNames = Object.keys(config.looks);
  const presetOptions = presetNames(config.presets);
  const perConfigDomains = perConfigDomainsFor(config);
  const engine = createCcCandybarEngine(
    {
      ...actionFuncs(actionRuntime),
      ...pickerFuncs(actionRuntime),
      ...menuFuncs(menuRuntime),
      // [LAW:one-source-of-truth] `{{ color }}` reads the palette of the
      // segment currently rendering — the same palette its `bg:`/`fg:` resolve
      // from, published by the walk. Binding it to a palette captured HERE
      // (registration runs once per config load, renders happen per tick) was
      // the two-clocks bug this seam exists to close: a session theme click, a
      // look, or a per-segment hue rotation moved a segment's background while
      // every in-body color stayed where it was, so one segment painted from
      // two palettes at once. Reading live costs nothing structurally — FuncMap
      // bodies run at evaluate time, so parse-once/evaluate-many is untouched.
      // `{{ bgOf }}` rides the same record. [LAW:rich-js-owns-color-math]
      ...segmentColorFuncs(activeSegment),
      // [LAW:one-type-per-behavior] The per-config sibling of the static
      // themes()/styles() bindings (template-engine/funcs.ts): zero-arg
      // projection of the "looks" option domain. Injected here — not in the
      // static FuncMap — because the domain is this config's looks block.
      looks: { fn: () => lookNames, argTypes: [] },
      // The presets domain's twin of the binding above — same per-config
      // reason, same shape. A hand-authored `range presets` and a
      // `{{ menu "applyPreset" }}` therefore enumerate the same names the
      // derived click gate admits.
      presets: { fn: () => presetOptions, argTypes: [] },
    },
    opts?.clock,
  );
  // [LAW:single-enforcer] THE one parse path for this config: prepend the helper
  // preamble so every template — segment template/when/bg/fg, node `when`, and
  // action copy/open — resolves `{{ template "name" }}` calls against the same
  // shared helpers. One closure, not raw engine.parse scattered across sites, so
  // there is exactly one boundary where helpers come into scope (and one place a
  // helper could fail to be visible). The preamble is compiled ONCE here, not per
  // parse, and is "" when no helpers are declared.
  const helperPreamble = compileHelperPreamble(engine, config.helpers);
  const parse = (src: string): Template<RichText> =>
    engine.parse(helperPreamble + src);
  // [LAW:one-source-of-truth] Map each SessionState key → the variable that
  // reads it, so an option picker marks its current selection by reading the
  // SAME value the templates read — independent of whether the config named the
  // variable after the key. State vars are the single read path for SessionState.
  const stateKeyToVar = new Map<string, string>();
  for (const [name, decl] of Object.entries(config.variables)) {
    if (decl.kind === "state" && !stateKeyToVar.has(decl.key)) {
      stateKeyToVar.set(decl.key, name);
    }
  }
  // Segment-local state vars read the same SessionState keys; they register
  // under the namespaced `segName.varName` (the form the store + scope use), so
  // map the key to that namespaced name. Global wins on key collision (added
  // first) — the value is the same key regardless, so either reads correctly.
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      if (decl.kind === "state" && !stateKeyToVar.has(decl.key)) {
        stateKeyToVar.set(decl.key, `${segName}.${varName}`);
      }
    }
  }
  // [LAW:one-source-of-truth] Actions resolve their set key → the reading
  // variable through the stateKeyToVar map, so an apply action and the picker
  // that references it read one value.
  actionRuntime.compiled = compileActions(
    parse,
    config.actions,
    stateKeyToVar,
    perConfigDomains,
  );

  // [LAW:dataflow-not-control-flow] One variable failing to declare does not
  // abort the rest. Errors are data (accumulated in loadWarnings); the store
  // simply lacks the broken variable. Segments that reference it get a
  // MissingFieldError at render time and show an error cell. Segments that
  // don't (e.g. configSwitcher) render normally.
  const loadWarnings: string[] = [];
  for (const [name, decl] of Object.entries(config.variables)) {
    try {
      declareOne(registry, name, decl, cwd);
    } catch (err) {
      loadWarnings.push(
        `Variable "${name}": ${(err as Error).message ?? String(err)}`,
      );
    }
  }

  // Segment-local vars stored under namespaced key segName.varName.
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      try {
        declareOne(registry, `${segName}.${varName}`, decl, cwd);
      } catch (err) {
        loadWarnings.push(
          `Variable "${segName}.${varName}": ${(err as Error).message ?? String(err)}`,
        );
      }
    }
  }

  // Pre-parse all segment templates and pre-resolve per-segment palettes once.
  // renderDsl calls evaluate() only — parse() and palette resolution never
  // run in the hot render path.
  // [LAW:no-defensive-null-guards] Object.create(null) — segment names come from
  // user config; a null-prototype object prevents __proto__/constructor/prototype
  // from being treated as segment data.
  const compiled: Record<string, CompiledSegment> = Object.create(
    null,
  ) as Record<string, CompiledSegment>;
  for (const [segName, seg] of Object.entries(config.segments)) {
    const parseField = (src: string, field: string) => {
      try {
        return parse(src);
      } catch (e) {
        throw new Error(
          `Template parse error in segments.${segName}.${field}: ${(e as Error).message}`,
          { cause: e },
        );
      }
    };
    compiled[segName] = {
      when: seg.when !== undefined ? parseField(seg.when, "when") : undefined,
      template: parseField(seg.template, "template"),
      bg: seg.bg !== undefined ? parseField(seg.bg, "bg") : undefined,
      fg: seg.fg !== undefined ? parseField(seg.fg, "fg") : undefined,
      // [LAW:one-source-of-truth] Freeze ONLY the explicit per-segment `palette:`
      // override — a deliberate static pin that intentionally ignores the live
      // session theme. The base theme (session ?? globals ?? default) is the
      // per-render basePalette; folding globals.palette in here too would freeze
      // it per segment and the stale copy would shadow basePalette, so a session
      // theme change could never recolor the bar.
      palette:
        seg.palette !== undefined
          ? paletteForThemeName(seg.palette)
          : undefined,
    };
  }

  // [LAW:one-source-of-truth] Compile the layout tree once here, alongside the
  // segment templates — renderDsl never parses. This driver owns the cross-cutting
  // `when` parse (one site, walk-uniform) and threads the recursion + per-config
  // resolution (palette names, state-key→var) into each node type's compile as
  // capabilities; the kind-specific assembly lives in node-registry.
  // [LAW:single-enforcer] The compiled tree mirrors config.root 1:1, so a node's
  // predicate and its children travel together.
  const parseNodeField = (src: string, path: string, field: string) => {
    try {
      return parse(src);
    } catch (e) {
      throw new Error(
        `Template parse error in ${path}.${field}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  };
  const compileNode = (node: LayoutNode, path: string): CompiledNode => {
    const cctx: NodeCompileCtx = {
      path,
      when:
        node.when === undefined
          ? undefined
          : parseNodeField(node.when, path, "when"),
      compileChild: compileNode,
    };
    return nodeType(node.kind).compile(node, cctx);
  };

  // [LAW:one-source-of-truth] One compiled tree per declared preset, built
  // through the SAME compileNode the config's own root goes through —
  // `presetRoot` resolves the fragment's `root` or falls back to the config's,
  // so the floor preset (the empty fragment) needs no arm and no absent case
  // downstream.
  // Keyed by the SAME domain the menu renders and the click gate admits, so
  // every selectable name has a compiled tree [LAW:one-source-of-truth].
  const roots = new Map<string, CompiledNode>();
  for (const name of presetOptions) {
    // The path travels WITH the tree, so a preset that stages the config's own
    // root diagnoses under `root` — the place its author actually wrote it.
    const { node, path } = presetRoot(config, name);
    roots.set(name, compileNode(node, path));
  }

  return {
    segments: compiled,
    roots,
    activeSegment,
    menuRuntime,
    loadWarnings,
  };
}

// [LAW:dataflow-not-control-flow] The focus tint: when a segment's own menu is
// open it is "focused", so its base background is lightened (rich-js owns the
// math — see [[rich-js-owns-color-math]]). The transform is RELATIVE to the
// resolved background, so any host theme tints to a consistent step above its own
// surface; a segment with no background (transparent) has nothing to lighten and
// passes through unchanged. One level ≈ 10% lightness — a subtle "this is active".
const MENU_FOCUS_LIGHTEN_LEVELS = 1;
function focusTint(style: Style): Style {
  const bg = style.bgcolor;
  if (bg === undefined) return style;
  const lit = ColorSpec.fromRgba(
    lighten(bg.getTruecolor(), MENU_FOCUS_LIGHTEN_LEVELS),
  );
  return new Style({ bgcolor: lit, color: style.color });
}

// ─── renderDsl ───────────────────────────────────────────────────────────────

/**
 * Render the DSL config to a (possibly multi-line) ANSI string.
 *
 * Pipeline:
 *   1. Push payload (+ injected `term.cols`) into input boxes — once per render.
 *   2. Build the scope proxy — once per render.
 *   3. Walk the compiled layout tree (renderNode) in pre-order, producing a list
 *      of LINES OF CELLS (not yet serialized). A `container` composes its
 *      children's blocks by its `direction` (vertical stacks, horizontal zips
 *      cells per row); a `cells` leaf evaluates its segments into cell lines. A
 *      node whose `when` (or an ancestor's) is false contributes no line, but its
 *      segments still advance the hue index so visible siblings keep
 *      positionally-stable colors.
 *   4. Serialize each composed line through the ONE strip joiner and join "\n".
 *
 * [LAW:single-enforcer] The daemon calls this verbatim — no alternate render
 * path. ONE walk renders every layout, flat or nested. The test and the daemon
 * share it.
 * [LAW:dataflow-not-control-flow] Node visibility, node count, and per-leaf
 * segment count are all data; a deeper tree is more recursion, not more code.
 * The projection (how a container maps children onto the plane) is the
 * `direction` VALUE, not a branch in the walk.
 *
 * Hue rotation: the segment index driving each `hueShift` advances in pre-order
 * across the whole tree, including hidden subtrees. Re-shaping a flat row list
 * into nested containers keeps every segment's color; toggling a node's
 * visibility does not recolor the nodes after it.
 */
// [LAW:locality-or-seam] The optional render observers, bundled as ONE named bag
// so a caller states what it passes by name — no positional tail to count, no
// `undefined` holes to reach a later observer, and a new observer is one field
// here rather than a signature change every caller re-counts.
export interface RenderObservers {
  // [LAW:dataflow-not-control-flow] Optional per-segment cell sink. When
  // present, each rendered segment's RichText array (post-layout, pre-
  // serialization) is written to this map under its segment name. Storing
  // cells (not pre-serialized strings) keeps the hot path's serializer
  // work proportional to the joined line only — debug consumers serialize
  // on demand. Hidden-by-when segments are absent from the map (presence
  // = "this segment rendered"). The map is cleared before the first row so
  // stale segment names never survive a layout edit. Per-segment standalone
  // serialization is not byte-identical to the segment's slice within the
  // joined line (powerline joiners sit *between* segments and have no
  // place in a one-segment render), but for debug visibility this is the
  // natural per-segment shape.
  readonly perSegmentSink?: Map<string, readonly RichText[]>;
  // [LAW:no-silent-failure] Optional observer for per-segment evaluation errors.
  // A failing segment renders as a visible ⚠ error cell (partial rendering, the
  // daemon's author-facing channel) — a headless caller with no one looking at
  // the bar (`cc-candybar check`) passes this to receive the same errors as
  // data and fold them into its text verdict. Trusted non-throwing (the
  // registry-dispose contract): an observer that throws is a caller bug
  // surfaced loudly, never caught and absorbed by the render walk.
  readonly onSegmentError?: (segName: string, message: string) => void;
}

// [LAW:locality-or-seam] The per-render RESOLUTION the caller performs and hands
// down — the values that are neither config (compiled once) nor payload (input
// data), but the session's live choices resolved against the config: which
// theme-adaptation, which preset. Bundled as ONE named bag for exactly the
// reason RenderObservers is: `look` arrived as a positional tail, `preset` would
// have been a second one, and the next resolution a third — each a signature
// every caller re-counts. A new per-render choice is now one field here.
//
// Both fields default to their domain's own identity element, so an omitting
// caller (a compile-only test, the demo) renders the unadapted config — a true
// default, not a fallback [LAW:no-silent-failure].
export interface RenderSelection {
  // The resolved look, as a ThemeKey: effectiveLookName over SessionState/
  // globals, then lookKeyByName — resolved by the caller exactly how basePalette
  // is. IDENTITY is the "none" look. Composed with each segment's hue shift into
  // ONE transposition.
  readonly look?: ThemeKey;
  // The resolved preset NAME: effectivePresetName over SessionState/globals,
  // collapsed to the floor if stale. Selects which of `compiled.roots` this
  // render walks. The name (not the fragment) crosses this seam because the
  // fragment's two halves land in two different places — the root here, the
  // globals in `opts`/the payload — and one name keeps them from disagreeing.
  readonly preset?: string;
}

export function renderDsl(
  config: ValidatedConfig,
  compiled: CompiledConfig,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  basePalette: Palette,
  opts: BuildLineOptions,
  observers?: RenderObservers,
  selection?: RenderSelection,
): string {
  const { perSegmentSink, onSegmentError } = observers ?? {};
  const { look = IDENTITY, preset = PRESET_FLOOR } = selection ?? {};
  // [LAW:one-source-of-truth] Inject the usable width as `term.cols` from the
  // SAME opts.width the strip wraps to (below), so a width-paginated widget reads
  // the exact wrap width — never a cached or independently-measured copy. This is
  // the RAW usable width (terminal cols minus the Claude-Code reserve), the honest
  // meaning every template — incl. user configs reading `.term.cols` — expects.
  // The picker's strip-chrome reservation is NOT folded in here: that is a
  // picker-local concern (the strip's end-caps wrap the picker's row, not every
  // segment), applied at the pagination seam in renderPicker. [LAW:locality-or-seam]
  // Spreading a non-object payload yields no keys (compile-only callers), so the
  // width is set regardless without a trust-boundary guard.
  registry.applyInput({ ...(payload as object), term: { cols: opts.width } });
  // [LAW:single-enforcer] Publish the render's strip style onto the shared action
  // runtime so the picker can reserve the joiner's end-cap chrome at its
  // pagination seam (the menu body renders through the same renderPicker). Set
  // once per render here — the same one-owner, per-render-mutation idiom as the
  // menu placement cursor below. [LAW:no-ambient-temporal-coupling]
  compiled.menuRuntime.action.stripStyle = opts.style;
  // [LAW:one-source-of-truth] Publish the render's intra-cell padding beside the
  // style: the picker reserves 2×padding at its pagination seam, the same seam
  // that reserves the joiner chrome — one resolved value, read where needed.
  compiled.menuRuntime.action.padding = opts.padding;

  const scope = buildScope(store);
  // [LAW:one-source-of-truth] hueStep is a value in the store like every other
  // render input — NOT a second source in globals. A config declares the
  // conventional hue-step variable and renderDsl reads that one source here. The
  // kind decides liveness with no change here: a `state` var lets a stepper drive
  // it live (session value over the declared default, the same session-over-
  // default the theme uses), a literal pins it (the bundled default's fixed 14°).
  // [LAW:no-defensive-null-guards] Two real, representable states both mean "no
  // rotation yet" (step 0): the variable is absent (an empty-default merge), OR
  // it is a `state` var with no default that no click has written yet (reads the
  // registry's empty fallback ""). Coerce to a finite number or 0 — a render must
  // never throw on a valid config. Number("") and Number("abc") collapse to the
  // 0 floor; any finite value (the literal default, a session pick) flows through.
  const rawHue = store.has(HUE_STEP_VAR) ? Number(store.read(HUE_STEP_VAR)) : 0;
  const hueStep = Number.isFinite(rawHue) ? rawHue : 0;

  perSegmentSink?.clear();

  // [LAW:single-enforcer] The hue cursor: one counter, advanced in pre-order
  // across the whole tree (visible or not) by segment leaves only — a container
  // advances none — so per-segment colors stay positionally stable regardless of
  // nesting or which nodes are hidden. ctx exposes nextHueShift() as the single
  // mutator. Hue is decorative: it carries no structural meaning.
  const hue = { value: 0 };
  const nextHueShift = (): number => {
    const shift = hue.value * hueStep;
    hue.value += 1;
    return shift;
  };

  // [LAW:no-defensive-null-guards] A segment node names one segment; resolve it to
  // its decl + compiled form. Both are always present together (loader validates,
  // registerDslConfig compiles); a miss is a caller bug the segment render throws on.
  const lookupSegment = (name: string) => {
    const seg = config.segments[name];
    const segCompiled = compiled.segments[name];
    return seg !== undefined && segCompiled !== undefined
      ? { seg, compiled: segCompiled }
      : undefined;
  };

  // [LAW:single-enforcer] The segment seam, owned here as a symmetric pair.
  // `enterSegment` establishes everything a segment's templates may ask about
  // themselves — the name `{{ menu }}` derives its identity from, the palette
  // `{{ color }}` resolves against, the background `{{ bgOf }}` returns — and
  // returns the resolved base Style. `exitSegment` collects the menu bodies the
  // fragments carried as metadata and tears the record back down.
  //
  // [LAW:no-ambient-temporal-coupling] The record is set and cleared around each
  // segment's evaluation by the walk ONLY, so "which segment am I in" is owned
  // state with one writer, never ambient context a reader has to hope is
  // current. Enter/exit are a pair by construction: every path that publishes
  // goes through the first, every path that finishes goes through the second.
  const enterSegment = (
    segName: string,
    palette: Palette,
    bgTemplate: Template<RichText> | undefined,
    fgTemplate: Template<RichText> | undefined,
  ): Style =>
    resolveSegmentColors(
      compiled.activeSegment,
      segName,
      palette,
      bgTemplate,
      fgTemplate,
      scope,
    );
  const exitSegment = (fragments: readonly RichText[]): readonly RichText[] => {
    compiled.activeSegment.current = null;
    return collectMenuDrops(fragments);
  };

  // [LAW:dataflow-not-control-flow] ONE walk renders any node to LINES OF CELLS
  // (serialization deferred to the root). The driver owns the cross-cutting
  // `when`: `visible` ANDs the node's own predicate with its ancestors'. It then
  // dispatches to the node type's render via nodeType() — no kind switch here.
  // The node count, nesting depth, and per-leaf segment count are all data; a
  // deeper tree is more recursion, not more code.
  const renderNode = (
    node: CompiledNode,
    parentVisible: boolean,
  ): RenderedLines => {
    const visible = parentVisible && evaluateWhen(node.when, scope);
    const ctx: NodeRenderCtx = {
      scope,
      basePalette,
      look,
      visible,
      padding: opts.padding,
      nextHueShift,
      perSegmentSink,
      onSegmentError,
      enterSegment,
      exitSegment,
      focusTint,
      lookupSegment,
      renderChild: renderNode,
    };
    return nodeType(node.kind).render(node, ctx);
  };

  // [LAW:single-enforcer] The ONE serialization pass: each composed line of cells
  // runs through the strip joiner exactly once, here. renderStripCells may itself
  // emit a "\n"-bearing string (FlexStrip width-overflow wrap); joining the per-
  // line results with "\n" splices those in place — byte-identical to serializing
  // each leaf row independently, since the cells and their order are unchanged.
  // [LAW:no-defensive-null-guards] The active preset's compiled tree. By the
  // time a name reaches here it must be a member: effectivePresetName collapses
  // unknown names to the floor, and every merged config declares the floor — so
  // the throw is the loud failure for a broken invariant (a hand-built config
  // missing the bundled presets block), never a silent fall back to some other
  // arrangement than the one the bar's own label claims is active.
  const root = compiled.roots.get(preset);
  if (root === undefined) {
    throw new Error(
      `Preset "${preset}" has no compiled layout — registerDslConfig compiles ` +
        `one per declared preset and effectivePresetName collapses unknown ` +
        `names to "${PRESET_FLOOR}"; a miss here is merge/policy drift ` +
        `(have: ${[...compiled.roots.keys()].join(", ")})`,
    );
  }
  return renderNode(root, true)
    .map((line) => renderStripCells(line, opts))
    .join("\n");
}
