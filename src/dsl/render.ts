// [LAW:single-enforcer] registerDslConfig + renderDsl are THE two spine functions the daemon calls
// verbatim. [LAW:one-source-of-truth] Templates pre-compile at registration, never per render.

import type { RichText, Palette, ThemeKey } from "@promptctl/rich-js";
import { IDENTITY } from "@promptctl/rich-js";
import { Defines, type Engine, type Template } from "@promptctl/go-template-js";
import type {
  ValidatedConfig,
  VariableDecl,
  CacheDecl,
  LayoutNode,
  ParseDecl,
  SourceDefault,
} from "../config/dsl-types.js";
import { parseArm } from "../config/dsl-types.js";
import { perConfigDomainsFor } from "../config/option-domain.js";
import { PRESET_FLOOR, presetNames, presetRoot } from "../config/presets.js";
import { addableSegmentDomains } from "../config/edit-chrome.js";
import type { VariableStore } from "../var-system/store.js";
import type { SourceRegistry } from "../var-system/sources.js";
import {
  parseDuration,
  type CachePolicy,
  type GitField,
} from "../var-system/sources.js";
import type { SourceParse } from "../var-system/parse.js";
import type { JsonValue } from "../var-system/types.js";
import type { BuildLineOptions } from "../render/strip.js";
import { DEFAULT_PADDING, renderStripCells } from "../render/strip.js";
import { paletteForThemeName, transposedPalette } from "../themes/index.js";
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
import { stateCell } from "../render/band-style.js";
import {
  BAR_ROOT,
  bandFor,
  bandRoot,
  decorationFor,
  descend,
  type AddressStep,
  type Region,
} from "../themes/decor.js";
// [LAW:one-way-deps] The node-type registry owns each kind's compile/render; this driver never re-switches on kind.
import {
  nodeType,
  type Compiled,
  type CompiledNode,
  type CompiledSegment,
  type CompiledSegments,
  type RenderedLines,
  type NodeCompileCtx,
  type NodeRenderCtx,
  type SegmentStyles,
} from "./node-registry.js";

// [LAW:one-source-of-truth] Segments AND the layout tree in one artifact the daemon cache holds.
export interface CompiledConfig {
  readonly segments: CompiledSegments;
  // [LAW:dataflow-not-control-flow] EVERY preset's layout, compiled up front: one RenderCache entry
  // serves many sessions. Total over `presetNames`, so the lookup needs no absent case.
  readonly roots: ReadonlyMap<string, CompiledNode>;
  readonly menuRuntime: MenuRuntime;
  // [LAW:one-source-of-truth][LAW:no-ambient-temporal-coupling] One "which segment is rendering" record, mutated only within a walk.
  readonly activeSegment: ActiveSegmentRef;
  // [LAW:types-are-the-program] Non-empty means partial load: usable but degraded.
  readonly loadWarnings: readonly string[];
}

// [LAW:dataflow-not-control-flow] One arm per CacheDecl variant; the in-check is the discriminator.
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

// [LAW:one-source-of-truth] The ONE place "no `parse:`" is read as the text arm.
// [LAW:parse-dont-validate] Each cast restates the loader's stamp rather than re-checking it.
function toSourceParse(
  parse: ParseDecl | undefined,
  dflt: SourceDefault | undefined,
): SourceParse {
  switch (parseArm(parse)) {
    case "json":
      return { kind: "json", default: dflt as JsonValue | undefined };
    case "regex":
      return {
        kind: "regex",
        regex: new RegExp((parse as { regex: string }).regex),
        default: dflt as string | undefined,
      };
    case "text":
      return { kind: "text", default: dflt as string | undefined };
  }
}

// [LAW:single-enforcer] The one dispatch from VariableDecl kind to SourceRegistry method.
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
      // [LAW:types-are-the-program] The loader matched `default` to `type`; absent is "string".
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
        cache: toCachePolicy(decl.cache),
        parse: toSourceParse(decl.parse, decl.default),
      });
      break;

    case "shell":
      registry.declareShell(name, decl.command, {
        cache: toCachePolicy(decl.cache),
        parse: toSourceParse(decl.parse, decl.default),
      });
      break;

    case "template":
      registry.declareTemplate(name, decl.template, {
        varDefault: decl.default,
      });
      break;

    case "time":
      // [LAW:types-are-the-program] The loader rejects non-ttl caches here, so this is total.
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

// [LAW:single-enforcer][LAW:one-source-of-truth] One `Defines`, inherited by LINK, never copied
// into every parse. [LAW:no-silent-fallbacks] Isolation gives a bad helper its own diagnostic.
function compileHelpers(
  engine: Engine<RichText>,
  helpers: Readonly<Record<string, string>>,
): Defines {
  let defines = Defines.EMPTY;
  for (const [name, body] of Object.entries(helpers)) {
    try {
      defines = engine
        .parse(`{{ define "${name}" }}${body}{{ end }}`, defines)
        .defines();
    } catch (e) {
      throw new Error(
        `Template parse error in helpers.${name}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
  return defines;
}

/**
 * Translate a validated DslConfig into the live VariableStore + SourceRegistry and pre-parse every
 * segment template. On hot-reload pass a FRESH store + registry and dispose the old one, or its
 * timers, watchers and git subscriptions leak.
 * [LAW:one-source-of-truth] Segment-local vars are referenced ONLY by their namespaced
 * `segName.varName` form; bare-name aliasing would make a ref depend on which segment renders.
 */
export function registerDslConfig(
  config: ValidatedConfig,
  registry: SourceRegistry,
  opts?: { cwd?: string; clock?: () => Date },
): CompiledConfig {
  const cwd = opts?.cwd ?? process.cwd();

  // [LAW:locality-or-seam] One engine per config load; the holder breaks the engine↔action cycle.
  // [LAW:one-source-of-truth] The action runtime reads the SAME store the registry declares into.
  const actionRuntime: ActionRuntime = {
    store: registry.variableStore,
    compiled: new Map(),
    // [LAW:types-are-the-program] renderDsl republishes these; the constants are a compile-only floor.
    stripStyle: "powerline",
    padding: DEFAULT_PADDING,
  };
  // [LAW:one-way-deps] Action + picker funcs are injected as data; the engine stays generic.
  // [LAW:one-source-of-truth] Built before the engine so the funcs close over the one record.
  const activeSegment = createActiveSegmentRef();
  const menuRuntime: MenuRuntime = {
    action: actionRuntime,
    activeSegment,
  };
  // [LAW:one-source-of-truth] The one PER-CONFIG option domain, fed to binding, domains and gate alike.
  const lookNames = Object.keys(config.looks);
  const presetOptions = presetNames(config.presets);
  // [LAW:one-source-of-truth] The SAME map deriveConfigActionValidators merges, never a second set.
  const perConfigDomains = new Map([
    ...perConfigDomainsFor(config),
    ...addableSegmentDomains(config),
  ]);
  const engine = createCcCandybarEngine(
    {
      ...actionFuncs(actionRuntime),
      ...pickerFuncs(actionRuntime, activeSegment),
      ...menuFuncs(menuRuntime),
      // [LAW:one-source-of-truth] `{{ color }}` reads the palette of the segment currently RENDERING,
      // not one captured here — capturing painted one segment from two palettes at once.
      ...segmentColorFuncs(activeSegment),
      // [LAW:one-type-per-behavior] Injected here because the domain is this config's looks block.
      looks: { fn: () => lookNames, argTypes: [] },
      presets: { fn: () => presetOptions, argTypes: [] },
    },
    opts?.clock,
  );
  // [LAW:single-enforcer] THE one parse path, so there is one boundary where helpers come into scope.
  const helpers = compileHelpers(engine, config.helpers);
  const parse = (src: string): Template<RichText> => engine.parse(src, helpers);
  // [LAW:one-source-of-truth] A picker marks its selection from the SAME value the templates read.
  const stateKeyToVar = new Map<string, string>();
  for (const [name, decl] of Object.entries(config.variables)) {
    if (decl.kind === "state" && !stateKeyToVar.has(decl.key)) {
      stateKeyToVar.set(decl.key, name);
    }
  }
  // Global wins on a key collision; either name reads the same key.
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      if (decl.kind === "state" && !stateKeyToVar.has(decl.key)) {
        stateKeyToVar.set(decl.key, `${segName}.${varName}`);
      }
    }
  }
  // [LAW:one-source-of-truth] An apply action and the picker referencing it read one value.
  actionRuntime.compiled = compileActions(
    parse,
    config.actions,
    stateKeyToVar,
    perConfigDomains,
  );

  // [LAW:dataflow-not-control-flow] Errors are data: one failing variable does not abort the rest.
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

  // [LAW:no-defensive-null-guards] Object.create(null): a user's `__proto__` is never segment data.
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
      // [LAW:one-source-of-truth] Freeze ONLY the explicit `palette:` pin: folding globals.palette in would shadow basePalette.
      palette:
        seg.palette !== undefined
          ? paletteForThemeName(seg.palette)
          : undefined,
    };
  }

  // [LAW:one-source-of-truth] The layout tree compiles once here; renderDsl never parses.
  // [LAW:single-enforcer] The compiled tree mirrors config.root 1:1.
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
  const compileNode = <N extends LayoutNode>(
    node: N,
    path: string,
  ): Compiled<N> => {
    const cctx: NodeCompileCtx = {
      path,
      when:
        node.when === undefined
          ? undefined
          : parseNodeField(node.when, path, "when"),
      parse: (src, field) => parseNodeField(src, path, field),
      compileChild: compileNode,
    };
    // [LAW:types-are-the-program] Restates nodeType's kind↔compiled pairing at the call site.
    return nodeType(node.kind).compile(node, cctx) as Compiled<N>;
  };

  // [LAW:one-source-of-truth] One tree per preset, keyed by the domain the menu and gate share.
  const roots = new Map<string, CompiledNode>();
  for (const name of presetOptions) {
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

/**
 * Render the DSL config to a (possibly multi-line) ANSI string: payload into input boxes, scope,
 * walk the compiled tree into LINES OF CELLS, serialize each line through the one strip joiner. A
 * node hidden by `when` contributes no line, but its ADDRESS is unchanged, so siblings keep colour.
 * [LAW:single-enforcer] The daemon calls this verbatim; ONE walk renders every layout.
 */
// [LAW:locality-or-seam] ONE named bag, so a new observer is a field, not a positional tail.
export interface RenderObservers {
  // [LAW:dataflow-not-control-flow] Cells, not strings, so the hot path serializes only the line.
  readonly perSegmentSink?: Map<string, readonly RichText[]>;
  // [LAW:no-silent-failure] A headless caller receives as data the errors the bar shows as ⚠ cells.
  readonly onSegmentError?: (segName: string, message: string) => void;
}

// [LAW:no-silent-failure] Each field defaults to its domain's identity element, not a fallback.
export interface RenderSelection {
  // IDENTITY is the "none" look; the base palette is transposed by it ONCE per render.
  readonly look?: ThemeKey;
  // The NAME, not the fragment, crosses this seam: the fragment's halves land in two places.
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
  // [LAW:one-source-of-truth] `term.cols` is the SAME opts.width the strip wraps to.
  // [LAW:locality-or-seam] The picker's strip-chrome reserve stays at its own pagination seam.
  registry.applyInput({ ...(payload as object), term: { cols: opts.width } });
  // [LAW:no-ambient-temporal-coupling] One owner publishes the strip style once per render.
  compiled.menuRuntime.action.stripStyle = opts.style;
  // [LAW:one-source-of-truth] The padding rides beside the style: one resolved value.
  compiled.menuRuntime.action.padding = opts.padding;

  const scope = buildScope(store);
  // [LAW:one-source-of-truth] Transposed ONCE, so a look click recolours the bar in one step.
  const palette = transposedPalette(basePalette, look);

  perSegmentSink?.clear();

  // [LAW:no-defensive-null-guards] Decl and compiled form always exist together; a miss throws.
  const lookupSegment = (name: string) => {
    const seg = config.segments[name];
    const segCompiled = compiled.segments[name];
    return seg !== undefined && segCompiled !== undefined
      ? { seg, compiled: segCompiled }
      : undefined;
  };

  // [LAW:single-enforcer] A symmetric pair: `enterSegment` publishes what a segment's templates may
  // ask about themselves and returns every Style it wears, trigger and band from ONE `bandFor` read.
  // [LAW:one-source-of-truth] ONE `decorationFor` read deals the tint, the text and the disclosure.
  const enterSegment = (
    segName: string,
    palette: Palette,
    region: Region,
    bgTemplate: Template<RichText> | undefined,
    fgTemplate: Template<RichText> | undefined,
  ): SegmentStyles => {
    const { tint, text, disclosure } = decorationFor(palette, region);
    const closed = resolveSegmentColors(
      compiled.activeSegment,
      segName,
      palette,
      disclosure,
      tint,
      text,
      bgTemplate,
      fgTemplate,
      scope,
    );
    const band = bandFor(palette, disclosure);
    return {
      closed,
      trigger: stateCell(palette, band.state),
      band: stateCell(palette, band.plane),
      disclosure,
    };
  };
  const exitSegment = (fragments: readonly RichText[]): readonly RichText[] => {
    compiled.activeSegment.current = null;
    return collectMenuDrops(fragments);
  };

  // [LAW:dataflow-not-control-flow] ONE walk: the driver owns `when` and dispatches via nodeType().
  const renderNode = (
    node: CompiledNode,
    parentVisible: boolean,
    region: Region,
  ): RenderedLines => {
    const visible = parentVisible && evaluateWhen(node.when, scope);
    const ctx: NodeRenderCtx = {
      scope,
      palette,
      visible,
      padding: opts.padding,
      region,
      perSegmentSink,
      onSegmentError,
      enterSegment,
      exitSegment,
      lookupSegment,
      renderChild: (child, childVisible, step: AddressStep) =>
        renderNode(child, childVisible, descend(region, step)),
      // A disclosure body starts a NEW region, so depth is a fact of the band, not walk state.
      renderBody: (body, open, band) =>
        renderNode(body, visible && open, bandRoot(band)),
    };
    return nodeType(node.kind).render(node, ctx);
  };

  // [LAW:single-enforcer] The ONE serialization pass; a wrap-emitted "\n" splices in place.
  // [LAW:no-defensive-null-guards] Unknown names collapse to the floor, so a miss here is a broken invariant.
  const root = compiled.roots.get(preset);
  if (root === undefined) {
    throw new Error(
      `Preset "${preset}" has no compiled layout — registerDslConfig compiles ` +
        `one per declared preset and effectivePresetName collapses unknown ` +
        `names to "${PRESET_FLOOR}"; a miss here is merge/policy drift ` +
        `(have: ${[...compiled.roots.keys()].join(", ")})`,
    );
  }
  return renderNode(root, true, BAR_ROOT)
    .map((line) => renderStripCells(line, opts))
    .join("\n");
}
