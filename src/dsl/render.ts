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

import type { RichText, PaletteResolver } from "@promptctl/rich-js";
import type {
  ValidatedConfig,
  VariableDecl,
  CacheDecl,
  LayoutNode,
} from "../config/dsl-types.js";
import { HUE_STEP_VAR } from "../config/dsl-types.js";
import type { VariableStore } from "../var-system/store.js";
import type { SourceRegistry } from "../var-system/sources.js";
import {
  parseDuration,
  type CachePolicy,
  type GitField,
} from "../var-system/sources.js";
import type { BuildLineOptions } from "../render/strip.js";
import { renderStripCells } from "../render/strip.js";
import { resolverForThemeName } from "../themes/index.js";
import { buildScope } from "../template-engine/scope.js";
import {
  createCcCandybarEngine,
  evaluateWhen,
} from "../template-engine/index.js";
import {
  compileActions,
  actionFuncs,
  type ActionRuntime,
} from "../render/action.js";
import { pickerFuncs } from "../render/picker.js";
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
  readonly root: CompiledNode;
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

    case "time": {
      // Only `ttl` is honored for the refresh interval; other CacheDecl
      // variants (watch_file, depends_on, key, never) are not mapped because
      // declareTime has no "disable refresh" mode — it always registers a TTL
      // timer. A future extension may add a `never`-mode that snapshots the
      // current time at declaration and never refreshes. Until then, non-ttl
      // cache declarations on time vars are treated as "use the default 1s TTL"
      // and the loader should be tightened to disallow them (follow-up ticket).
      const ttlMs =
        decl.cache && "ttl" in decl.cache
          ? parseDuration(decl.cache.ttl)
          : undefined;
      registry.declareTime(name, {
        format: decl.layout,
        ttlMs,
        varDefault: decl.default,
      });
      break;
    }

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
 * NOTE on segment-local vars: segment vars are stored under the namespaced key
 * segName.varName in the store. Templates must reference them via the namespaced
 * form (.segName.varName). Bare-name access (.varName from within the owning
 * segment's template) is NOT currently supported at runtime — the scope proxy
 * only resolves keys present in the store. The loader's cross-ref validator
 * allows bare-name refs for validation purposes but the runtime does not yet
 * implement the aliasing. Use namespaced form until a per-segment scope proxy
 * is added (planned follow-up).
 */
export function registerDslConfig(
  config: ValidatedConfig,
  registry: SourceRegistry,
  opts?: { cwd?: string; store?: VariableStore; clock?: () => Date },
): CompiledConfig {
  const cwd = opts?.cwd ?? process.cwd();

  // [LAW:locality-or-seam] One engine per config load, carrying THIS config's
  // action runtime. Engine creation amortizes across all of this config's segment
  // templates (parse-once); per-config (not per-render) is the right granularity
  // because the action set is config-scoped. The runtime holder is populated below
  // — the `action`/`picker` funcs reference the engine, and the compiled actions
  // reference the engine, so the holder breaks that cycle.
  // [LAW:no-defensive-null-guards] store may be absent for compile-only callers
  // with no actions; renderAction throws loudly if an action is actually used
  // without a store, rather than silently rendering an empty click.
  const actionRuntime: ActionRuntime = {
    store: opts?.store ?? null,
    compiled: new Map(),
  };
  // [LAW:one-way-deps] Inject action + picker feature funcs as data — the engine
  // stays generic. The picker shares the ACTION runtime (it resolves its
  // apply/page actions from the same compiled table), so they read one source.
  // [LAW:single-enforcer] Forward the caller's clock (the daemon's `() => new
  // Date()`, a test's frozen clock) to the one engine. Omitted ⇒ undefined ⇒
  // createCcCandybarEngine applies its single default; no second default literal.
  const engine = createCcCandybarEngine(
    undefined,
    {
      ...actionFuncs(actionRuntime),
      ...pickerFuncs(actionRuntime),
    },
    opts?.clock,
  );
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
    engine,
    config.actions,
    stateKeyToVar,
  );

  for (const [name, decl] of Object.entries(config.variables)) {
    declareOne(registry, name, decl, cwd);
  }

  // Segment-local vars stored under namespaced key segName.varName.
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      declareOne(registry, `${segName}.${varName}`, decl, cwd);
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
        return engine.parse(src);
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
      paletteResolver:
        seg.palette !== undefined
          ? resolverForThemeName(seg.palette)
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
      return engine.parse(src);
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

  return { segments: compiled, root: compileNode(config.root, "root") };
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
export function renderDsl(
  config: ValidatedConfig,
  compiled: CompiledConfig,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  basePalette: PaletteResolver,
  opts: BuildLineOptions,
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
  perSegmentSink?: Map<string, readonly RichText[]>,
): string {
  // [LAW:one-source-of-truth] Inject the usable width as `term.cols` from the
  // SAME opts.width the strip wraps to (below), so a width-paginated widget
  // reads the exact wrap width — never a cached or independently-measured copy.
  // Spreading a non-object payload yields no keys (compile-only callers), so the
  // width is set regardless without a trust-boundary guard.
  registry.applyInput({ ...(payload as object), term: { cols: opts.width } });

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
      visible,
      nextHueShift,
      perSegmentSink,
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
  return renderNode(compiled.root, true)
    .map((line) => renderStripCells(line, opts))
    .join("\n");
}
