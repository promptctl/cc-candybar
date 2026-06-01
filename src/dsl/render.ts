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

import { RichText, Style } from "@promptctl/rich-js";
import type { PaletteResolver } from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type {
  ValidatedConfig,
  VariableDecl,
  CacheDecl,
  LayoutNode,
  InlineCell,
  Direction,
} from "../config/dsl-types.js";
import { HUE_STEP_VAR, SESSION_ID_VAR } from "../config/dsl-types.js";
import { toString as varToString } from "../var-system/types.js";
import { effectsUrl, VERB_SET_STATE } from "../click/wire.js";
import type { VariableStore } from "../var-system/store.js";
import type { SourceRegistry } from "../var-system/sources.js";
import {
  parseDuration,
  type CachePolicy,
  type GitField,
} from "../var-system/sources.js";
import type { BuildLineOptions } from "../render/strip.js";
import { renderStripCells } from "../render/strip.js";
import { splitCellsIntoLines } from "../render/split-lines.js";
import { resolverForThemeName, transposedResolver } from "../themes/index.js";
import { buildScope } from "../template-engine/scope.js";
import {
  createCcCandybarEngine,
  fragmentsToCells,
  evaluateWhen,
  applySegmentLayout,
  resolveSegmentColors,
} from "../template-engine/index.js";
import {
  compileWidgets,
  widgetFuncs,
  type WidgetRuntime,
} from "../render/widget.js";

// ─── Compiled segment shape ───────────────────────────────────────────────────

// Pre-parsed templates and pre-resolved palette for one segment. Built once at
// registration time; renderDsl only evaluates. [LAW:one-source-of-truth]
// the compiled form is the authoritative runtime shape for a segment.
export interface CompiledSegment {
  readonly when?: Template<RichText>;
  readonly template: Template<RichText>;
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
  // Pre-resolved from the segment's explicit `palette:` override at registration
  // time; undefined means "use the per-render basePalette passed to renderDsl"
  // (the live session ?? globals ?? default base theme).
  readonly paletteResolver?: PaletteResolver;
}

// Pre-compiled templates for every segment in a DslConfig, keyed by segment
// name. Consumed by renderDsl.
export type CompiledSegments = Readonly<Record<string, CompiledSegment>>;

// [LAW:dataflow-not-control-flow] The compiled mirror of a LayoutNode: the same
// recursive shape with every `when` predicate parsed ONCE here. renderDsl walks
// this compiled tree — not the raw config — so the parse-once guarantee covers
// every node. A `cells` node carries its segment-name run; a `container` node
// carries its `direction` and compiled children.
export interface CompiledCellsNode {
  readonly kind: "cells";
  readonly when?: Template<RichText>;
  readonly segments: readonly string[];
}
// [LAW:dataflow-not-control-flow] The compiled inline leaf: its `when` and its
// bg/fg color specs are parsed ONCE here (renderDsl only evaluates), its palette
// override pre-resolved. The cells themselves are literal (text + literal
// onClick), so they need no compilation — the only render-time work is turning
// each cell's literal (key, value) into a set-state URL against the live
// session id, and resolving the leaf's color.
export interface CompiledInlineNode {
  readonly kind: "inline";
  readonly when?: Template<RichText>;
  readonly cells: readonly InlineCell[];
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
  readonly paletteResolver?: PaletteResolver;
}
export interface CompiledContainerNode {
  readonly kind: "container";
  readonly direction: Direction;
  readonly when?: Template<RichText>;
  readonly children: readonly CompiledNode[];
}
export type CompiledNode =
  | CompiledCellsNode
  | CompiledInlineNode
  | CompiledContainerNode;

// [LAW:one-source-of-truth] The full compiled artifact registerDslConfig
// produces: every segment's compiled templates AND the compiled layout tree
// (nodes with parsed `when`). renderDsl needs both; bundling them keeps the
// daemon cache holding one value, not two that could fall out of sync.
export interface CompiledConfig {
  readonly segments: CompiledSegments;
  readonly root: CompiledNode;
}

// A rendered node is a LIST OF LINES, each line a list of cells — NOT yet
// serialized. [LAW:types-are-the-program] Cells (not ANSI bytes) are the
// composition substrate: the powerline joiner caps between adjacent cells, and
// serializing a node before composition would freeze its last cell's edge to
// the default background, making a cap across a sibling seam unrecoverable.
// Serialization (the single joiner pass) therefore runs exactly once, at the
// root, AFTER the whole tree has composed.
type RenderedLines = ReadonlyArray<readonly RichText[]>;

// [LAW:dataflow-not-control-flow] A container's `direction` is the projection it
// applies to its already-rendered child blocks — DATA selecting a fold, not a
// branch that skips work. `vertical` STACKS (concatenate the children's line-
// lists); `horizontal` ZIPS (row i is every child's row-i cells concatenated, so
// the joiner caps ACROSS the seam — there is no abut). The switch is exhaustive
// over `Direction`; adding `outline` to DIRECTIONS forces a new arm here.
function composeBlocks(
  direction: Direction,
  blocks: readonly RenderedLines[],
): RenderedLines {
  switch (direction) {
    case "vertical":
      return blocks.flatMap((b) => b);
    case "horizontal": {
      const height = blocks.reduce((m, b) => Math.max(m, b.length), 0);
      const rows: RichText[][] = [];
      for (let i = 0; i < height; i++) {
        rows.push(blocks.flatMap((b) => b[i] ?? []));
      }
      return rows;
    }
  }
}

// [LAW:single-enforcer] One inline-cell click → URL mapping: a structured
// (key, value) write becomes exactly one `set-state` effect on the one click
// wire. effectsUrl owns the encoding; this names the single-effect shape an
// inline cell emits (the same shape the doomed widget runtime builds today).
function setStateUrl(sessionId: string, key: string, value: string): string {
  return effectsUrl([{ verb: VERB_SET_STATE, args: [sessionId, key, value] }]);
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
  opts?: { cwd?: string; store?: VariableStore },
): CompiledConfig {
  const cwd = opts?.cwd ?? process.cwd();

  // [LAW:locality-or-seam] One engine per config load, carrying THIS config's
  // widget runtime. Engine creation amortizes across all of this config's
  // segment templates (parse-once); per-config (not per-render) is the right
  // granularity because the widget set is config-scoped. The runtime holder is
  // populated below — the `widget` func references the engine, and the compiled
  // widgets reference the engine, so the holder breaks that cycle.
  // [LAW:no-defensive-null-guards] store may be absent for compile-only callers
  // with no widgets; renderWidget throws loudly if a widget is actually used
  // without a store, rather than silently rendering an empty click.
  const widgetRuntime: WidgetRuntime = {
    store: opts?.store ?? null,
    compiled: new Map(),
  };
  // [LAW:one-way-deps] Inject the widget feature's func as data — the engine
  // stays generic. The func closes over the runtime holder, whose `compiled`
  // map is populated just below (the holder breaks the engine↔widgets cycle).
  const engine = createCcCandybarEngine(undefined, widgetFuncs(widgetRuntime));
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
  widgetRuntime.compiled = compileWidgets(
    engine,
    config.widgets,
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
  // segment templates — renderDsl never parses. Each node's `when` is parsed in
  // place; the compiled tree mirrors config.root 1:1 (same structure, same
  // segment order), so a node's predicate and its children travel together.
  const compileNodeField = (src: string, path: string, field: string) => {
    try {
      return engine.parse(src);
    } catch (e) {
      throw new Error(
        `Template parse error in ${path}.${field}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  };
  const compileWhen = (when: string | undefined, path: string) =>
    when === undefined ? undefined : compileNodeField(when, path, "when");
  const compileNode = (node: LayoutNode, path: string): CompiledNode => {
    const when = compileWhen(node.when, path);
    if (node.kind === "cells") {
      return { kind: "cells", when, segments: node.segments };
    }
    if (node.kind === "inline") {
      // [LAW:one-source-of-truth] bg/fg are parsed through the SAME engine as a
      // segment's bg/fg and resolved by the SAME resolveSegmentColors at render,
      // so an inline leaf's color follows one color path — never a second one
      // that could drift. A static palette name parses to a literal-emitting
      // template; the parse-once guarantee still holds.
      return {
        kind: "inline",
        when,
        cells: node.cells,
        bg:
          node.bg !== undefined
            ? compileNodeField(node.bg, path, "bg")
            : undefined,
        fg:
          node.fg !== undefined
            ? compileNodeField(node.fg, path, "fg")
            : undefined,
        paletteResolver:
          node.palette !== undefined
            ? resolverForThemeName(node.palette)
            : undefined,
      };
    }
    return {
      kind: "container",
      direction: node.direction,
      when,
      children: node.children.map((child, i) =>
        compileNode(child, `${path}.children[${i}]`),
      ),
    };
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

  // [LAW:one-source-of-truth] The session id an inline cell's set-state URL
  // carries comes from the SAME conventional variable the widget runtime reads —
  // one name for "which session am I in." Absent (compile-only callers, or a
  // config that never declared it) is a real state: an empty id yields a wire URL
  // the daemon rejects loudly rather than mutating the wrong session.
  const sessionId = store.has(SESSION_ID_VAR)
    ? varToString(store.read(SESSION_ID_VAR))
    : "";

  perSegmentSink?.clear();

  // [LAW:single-enforcer] segIndex is the one hue cursor, advanced in pre-order
  // across the whole tree (visible or not) so per-segment colors stay
  // positionally stable regardless of how the layout is nested or which nodes
  // are currently hidden.
  let segIndex = 0;

  // [LAW:dataflow-not-control-flow] One walk renders any node to LINES OF CELLS
  // (serialization is deferred to the root). `visible` ANDs the node's own `when`
  // with its ancestors' — a leaf renders only when its whole path is visible, yet
  // its segments always advance segIndex. A container's projection is its
  // `direction` VALUE: composeBlocks folds the children's blocks (vertical stacks,
  // horizontal zips cells per row so the joiner caps across the seam).
  const renderNode = (
    node: CompiledNode,
    parentVisible: boolean,
  ): RenderedLines => {
    const visible = parentVisible && evaluateWhen(node.when, scope);

    if (node.kind === "container") {
      return composeBlocks(
        node.direction,
        node.children.map((child) => renderNode(child, visible)),
      );
    }

    if (node.kind === "inline") {
      // [LAW:single-enforcer] An inline leaf is ONE hue unit (like a segment): it
      // consumes exactly one segIndex so its color is positionally stable and the
      // siblings after it keep their colors regardless of its visibility.
      const hueShift = segIndex * hueStep;
      segIndex++;
      if (!visible) return [];

      // [LAW:dataflow-not-control-flow] The per-leaf variability is WHICH palette
      // — the leaf's override (or basePalette) transposed by its hueShift — and
      // bg/fg resolve from that one palette, the SAME path a segment's color
      // takes. No second color codepath.
      const resolver = transposedResolver(
        node.paletteResolver ?? basePalette,
        hueShift,
      );
      const baseStyle = resolveSegmentColors(resolver, node.bg, node.fg, scope);

      // [LAW:dataflow-not-control-flow] Each cell becomes one fragment; a cell's
      // `onClick` (a value, not a branch) decides whether that fragment carries an
      // OSC-8 set-state link. fragmentsToCells then splits at link boundaries so
      // each clickable cell is independently addressable — the SAME mapper a
      // segment template's output flows through. Inter-cell single-space
      // separators match the inline spacing the bar already renders.
      const fragments = node.cells.flatMap((cell, i) => {
        const frag =
          cell.onClick !== undefined
            ? new RichText(cell.text, {
                style: new Style({
                  link: setStateUrl(
                    sessionId,
                    cell.onClick.set,
                    cell.onClick.to,
                  ),
                }),
              })
            : new RichText(cell.text);
        return i > 0 ? [new RichText(" "), frag] : [frag];
      });
      return [fragmentsToCells(fragments, baseStyle)];
    }

    // [LAW:dataflow-not-control-flow] The leaf accumulates VISUAL lines, not a
    // flat cell run. A segment's first line continues the current row line; each
    // subsequent line (from an authored "\n") opens a new one. Starts as one
    // empty line so an all-hidden visible leaf still yields exactly one (empty)
    // line — the pre-substrate behavior.
    const rowLines: RichText[][] = [[]];
    for (const segName of node.segments) {
      const seg = config.segments[segName];
      const segCompiled = compiled.segments[segName];
      // [LAW:no-defensive-null-guards] seg + segCompiled are always defined —
      // the loader validates every cells-node entry against segments, and
      // registerDslConfig compiles every declared segment. A missing entry
      // here is a caller bug (renderDsl called with a mismatched compiled
      // object).
      if (!seg || !segCompiled) {
        throw new Error(`Layout entry "${segName}" has no matching segment`);
      }

      const hueShift = segIndex * hueStep;
      segIndex++;

      if (!visible) continue;
      if (!evaluateWhen(segCompiled.when, scope)) continue;

      // [LAW:dataflow-not-control-flow] The per-segment variability is WHICH
      // palette — the base resolver (per-segment override or basePalette)
      // transposed by hueShift. bg and fg then resolve from this one palette.
      const resolver = transposedResolver(
        segCompiled.paletteResolver ?? basePalette,
        hueShift,
      );

      const baseStyle = resolveSegmentColors(
        resolver,
        segCompiled.bg,
        segCompiled.fg,
        scope,
      );

      const fragments = segCompiled.template.evaluate(scope);
      const segCells = fragmentsToCells(fragments, baseStyle);

      // [LAW:single-enforcer] Partition the segment's authored "\n" into visual
      // lines BEFORE per-segment layout — width/justify/truncate then measure
      // each line cleanly, never a "\n"-bearing cell whose cellLength is a
      // zero-width lie (which would truncate or mis-align across the break). A
      // newline-free segment is the degenerate one-line case: one applySegmentLayout
      // call on the whole cell run, byte-identical to the pre-split path.
      const laidLines = splitCellsIntoLines(segCells).map((line) =>
        applySegmentLayout(line, {
          width: seg.width ?? "auto",
          justify: seg.justify ?? "left",
          truncate: seg.truncate ?? "right",
          baseStyle,
        }),
      );

      laidLines.forEach((laid, i) => {
        if (i > 0) rowLines.push([]);
        rowLines[rowLines.length - 1]!.push(...laid);
      });

      if (perSegmentSink !== undefined) {
        perSegmentSink.set(segName, laidLines.flat());
      }
    }

    // [LAW:dataflow-not-control-flow] A hidden leaf is absent (no line). A
    // visible leaf hands back its accumulated cell lines; serialization (and
    // FlexStrip auto-wrap) happens once at the root, never here.
    if (!visible) return [];
    return rowLines;
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
