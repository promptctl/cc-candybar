// [LAW:single-enforcer] registerDslConfig + renderDslLine are THE two spine
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

import {
  PaletteResolver,
  type StripCell,
  type RichText,
} from "@promptctl/rich-js";
import type { Template } from "@promptctl/go-template-js";
import type {
  ValidatedConfig,
  VariableDecl,
  CacheDecl,
} from "../config/dsl-types.js";
import type { VariableStore } from "../var-system/store.js";
import type { SourceRegistry } from "../var-system/sources.js";
import {
  parseDuration,
  type CachePolicy,
  type GitField,
} from "../var-system/sources.js";
import type { BuildLineOptions } from "../render/strip.js";
import { renderStripCells } from "../render/strip.js";
import { effectiveSegmentPalette } from "../config/dsl-loader.js";
import { resolvePaletteName } from "../themes/index.js";
import { getThemePalette } from "../themes/palette-registry.js";
import { buildScope } from "../template-engine/scope.js";
import {
  createCcCandybarEngine,
  fragmentsToStripCells,
  evaluateWhen,
  applySegmentLayout,
  resolveSegmentColors,
} from "../template-engine/index.js";

// ─── Compiled segment shape ───────────────────────────────────────────────────

// Pre-parsed templates and pre-resolved palette for one segment. Built once at
// registration time; renderDslLine only evaluates. [LAW:one-source-of-truth]
// the compiled form is the authoritative runtime shape for a segment.
export interface CompiledSegment {
  readonly when?: Template<RichText>;
  readonly template: Template<RichText>;
  readonly bg?: Template<RichText>;
  readonly fg?: Template<RichText>;
  // Pre-resolved from effectiveSegmentPalette at registration time; undefined
  // means "use the basePalette passed to renderDslLine".
  readonly paletteResolver?: PaletteResolver;
}

// Pre-compiled templates for every segment in a DslConfig, keyed by segment
// name. Returned by registerDslConfig; consumed by renderDslLine.
export type CompiledSegments = Readonly<Record<string, CompiledSegment>>;

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

// [LAW:one-source-of-truth] One engine instance for all template compilation.
// Engine creation is expensive; sharing one instance means parse() amortizes
// the startup cost across all segment templates. The engine is resolver-less
// because built-in segment templates do not call palette functions in their
// bodies — colors are set via the bg/fg fields evaluated in resolveSegmentColors.
// Palette functions in template bodies ({{ primary "..." }}) are a future
// extension that would require a per-palette engine instance.
const _compileEngine = createCcCandybarEngine();

/**
 * Translate a validated DslConfig into the live VariableStore + SourceRegistry
 * and pre-parse all segment templates.
 *
 * Walks config.variables (global vars) and each segment's vars sub-block
 * (namespaced as segName.varName) and calls the matching SourceRegistry
 * declare* method for each VariableDecl. Also pre-parses every segment's
 * when/template/bg/fg strings once — renderDslLine only evaluates.
 *
 * Call once per config (at startup or hot-reload). The daemon calls this;
 * the render loop calls renderDslLine with the returned CompiledSegments.
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
  opts?: { cwd?: string },
): CompiledSegments {
  const cwd = opts?.cwd ?? process.cwd();

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
  // renderDslLine calls evaluate() only — parse() and palette resolution never
  // run in the hot render path.
  // [LAW:no-defensive-null-guards] Object.create(null) — segment names come from
  // user config; a null-prototype object prevents __proto__/constructor/prototype
  // from being treated as segment data.
  const compiled: Record<string, CompiledSegment> = Object.create(
    null,
  ) as Record<string, CompiledSegment>;
  for (const [segName, seg] of Object.entries(config.segments)) {
    const paletteName = effectiveSegmentPalette(config.globals, seg);
    const parseField = (src: string, field: string) => {
      try {
        return _compileEngine.parse(src);
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
      paletteResolver:
        paletteName !== undefined ? resolverForPalette(paletteName) : undefined,
    };
  }
  return compiled;
}

// ─── Per-segment palette resolution ──────────────────────────────────────────

// [LAW:single-enforcer] One place converts a validated palette name to a
// PaletteResolver. The loader guarantees the name is in allowedPalettes
// (validated at load time), so getThemePalette must succeed — null is a
// programming error (registry inconsistency), not a user error.
function resolverForPalette(name: string): PaletteResolver {
  const palette = getThemePalette(resolvePaletteName(name));
  if (palette === null) {
    throw new Error(
      `Palette "${name}" was validated by loader but not found in registry — ` +
        `allowedPalettes and the real registry are inconsistent`,
    );
  }
  return new PaletteResolver(palette);
}

// ─── renderDslLine ────────────────────────────────────────────────────────────

/**
 * Render one DSL layout line to an ANSI string.
 *
 * PROPOSAL 'Render' steps 1-6:
 *   1. Push payload into input boxes (registry.applyInput).
 *   2. Walk config.layout in order; skip segments whose `when` evaluates false.
 *   3. Per-segment PaletteResolver pre-resolved at registration (3rq.2) or basePalette.
 *   4. Resolve bg/fg → baseStyle (layered under each fragment so per-fragment fg
 *      becomes a cell part rather than being lost to a cell-level rebuild).
 *   5. Evaluate pre-compiled template → fragments → StripCells with baseStyle baked in.
 *      Apply width/justify/truncate.
 *   6. Concatenate all StripCells; join via powerline Joiner → ANSI string.
 *
 * [LAW:single-enforcer] The daemon (bzh.2) calls this verbatim — no alternate
 * render path. The test and the daemon share ONE render path.
 * [LAW:dataflow-not-control-flow] layout is data; N segments is more data,
 * not more code. The scope proxy is built once; templates are only evaluated.
 */
export function renderDslLine(
  config: ValidatedConfig,
  compiled: CompiledSegments,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  basePalette: PaletteResolver,
  opts: BuildLineOptions,
  // [LAW:dataflow-not-control-flow] Optional per-segment cell sink. When
  // present, each rendered segment's StripCell array (post-layout, pre-
  // serialization) is written to this map under its segment name. Storing
  // cells (not pre-serialized strings) keeps the hot path's serializer
  // work proportional to the joined line only — debug consumers serialize
  // on demand. Hidden-by-when segments are absent from the map (presence
  // = "this segment rendered"). The map is cleared before each render so
  // stale segment names never survive a layout edit. Per-segment standalone
  // serialization is not byte-identical to the segment's slice within the
  // joined line (powerline joiners sit *between* segments and have no
  // place in a one-segment render), but for debug visibility this is the
  // natural per-segment shape.
  perSegmentSink?: Map<string, readonly StripCell[]>,
): string {
  // Step 1: push payload into input boxes.
  registry.applyInput(payload);

  const scope = buildScope(store);
  const hueStep = config.globals.hueStep ?? 0;

  const allCells: StripCell[] = [];
  perSegmentSink?.clear();

  for (let i = 0; i < config.layout.length; i++) {
    const segName = config.layout[i]!;
    const seg = config.segments[segName];
    const segCompiled = compiled[segName];
    // [LAW:no-defensive-null-guards] seg + segCompiled are always defined —
    // the loader validates every layout entry against segments, and
    // registerDslConfig compiles every declared segment. A missing entry here
    // is a caller bug (renderDslLine called with a mismatched compiled object).
    if (!seg || !segCompiled) {
      throw new Error(`Layout entry "${segName}" has no matching segment`);
    }

    // Step 2: when predicate — skip hidden segments.
    if (!evaluateWhen(segCompiled.when, scope)) continue;

    // Step 3: per-segment palette (3rq.2) — pre-resolved at registration time.
    const resolver = segCompiled.paletteResolver ?? basePalette;

    // Step 4: resolve segment bg/fg first — they flow into cell construction
    // as a base style on every fragment, so per-fragment fg (e.g. inline
    // `{{ red ... }}`) survives the cell-level bg merge as a part.
    const baseStyle = resolveSegmentColors(
      resolver,
      segCompiled.bg,
      segCompiled.fg,
      scope,
      { hueRotationDegrees: i * hueStep },
    );

    // Step 5: evaluate pre-compiled template → StripCells with baseStyle baked in.
    // Same baseStyle also flows into layout so synthesized pad/marker cells
    // (fixed-width segments) keep the segment bg+fg continuous.
    const fragments = segCompiled.template.evaluate(scope);
    const cells = fragmentsToStripCells(fragments, baseStyle);

    const laidOut = applySegmentLayout(cells, {
      width: seg.width ?? "auto",
      justify: seg.justify ?? "left",
      truncate: seg.truncate ?? "right",
      baseStyle,
    });

    if (perSegmentSink !== undefined) {
      perSegmentSink.set(segName, laidOut);
    }

    allCells.push(...laidOut);
  }

  // Step 6: join all cells into one ANSI line.
  return renderStripCells(allCells, opts);
}
