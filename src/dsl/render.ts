// [LAW:single-enforcer] registerDslConfig + renderDslLine are THE two spine
// functions the daemon calls verbatim. No parallel registration path, no
// alternate render path. bzh.2 reuses these; it does not reimplement them.
//
// [LAW:one-source-of-truth] registerDslConfig is the single JSON-shape →
// runtime translation. Every VariableDecl kind maps to exactly one
// SourceRegistry.declare* call here.
//
// [LAW:dataflow-not-control-flow] Both functions execute unconditionally;
// the input values (kind discriminators, layout length, palette presence)
// govern output, not whether operations run.

import { PaletteResolver, type StripCell } from "@promptctl/rich-js";
import type {
  DslConfig,
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
  return { kind: "never" };
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
      // [LAW:types-are-the-program] Input vars are always "string": the DSL
      // config has no type annotation for input fields, and all payload values
      // coerce to string via toString(). Typed inputs are a future extension.
      registry.declareInput(name, decl.path, "string", decl.default);
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
  }
}

// ─── registerDslConfig ────────────────────────────────────────────────────────

/**
 * Translate a validated DslConfig into the live VariableStore + SourceRegistry.
 *
 * Walks config.variables (global vars) and each segment's vars sub-block
 * (namespaced as segName.varName) and calls the matching SourceRegistry
 * declare* method for each VariableDecl.
 *
 * Call once per config (at startup or hot-reload). The daemon calls this; the
 * render loop calls renderDslLine.
 *
 * [LAW:one-source-of-truth] THE JSON-shape→runtime translation. No other
 * module re-derives this mapping.
 * [LAW:dataflow-not-control-flow] The kind discriminator in declareOne selects
 * the declare* call; no special-casing beyond the closed source-kind set.
 */
export function registerDslConfig(
  config: DslConfig,
  store: VariableStore,
  registry: SourceRegistry,
  opts?: { cwd?: string },
): void {
  const cwd = opts?.cwd ?? process.cwd();

  for (const [name, decl] of Object.entries(config.variables)) {
    declareOne(registry, name, decl, cwd);
  }

  // Segment-local vars live under the namespaced key segName.varName in the
  // store. The scope proxy resolves .varName as a bare prefix when the
  // segment's own template evaluates — see buildScope for the traversal logic.
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      declareOne(registry, `${segName}.${varName}`, decl, cwd);
    }
  }
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
 *   3. Per segment: evaluate template → fragments → StripCells.
 *   4. Resolve effectiveSegmentPalette (3rq.2) → per-segment PaletteResolver.
 *   5. Resolve bg/fg → defaultStyle; apply width/justify/truncate.
 *   6. Concatenate all StripCells; join via powerline Joiner → ANSI string.
 *
 * [LAW:single-enforcer] The daemon (bzh.2) calls this verbatim — no alternate
 * render path. The test and the daemon share ONE render path.
 * [LAW:dataflow-not-control-flow] layout is data; N segments is more data,
 * not more code. The engine runs once per render; the scope proxy is built once.
 */
export function renderDslLine(
  config: DslConfig,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  basePalette: PaletteResolver,
  opts: BuildLineOptions,
): string {
  // Step 1: push payload into input boxes.
  registry.applyInput(payload);

  // One engine instance for the full line. Template body evaluation does not
  // use palette functions (bg/fg use resolveSegmentColors, not template
  // palette funcs), so a resolver-less engine is correct for the render body.
  const engine = createCcCandybarEngine();
  const scope = buildScope(store);
  const hueStep = config.globals.hueStep ?? 0;

  const allCells: StripCell[] = [];

  for (let i = 0; i < config.layout.length; i++) {
    const segName = config.layout[i]!;
    const seg = config.segments[segName];
    // [LAW:no-defensive-null-guards] seg is always defined — the loader
    // validates every layout entry against segments. A missing seg here is
    // a loader bug, not a user error; loud failure is correct.
    if (!seg)
      throw new Error(`Layout entry "${segName}" has no matching segment`);

    // Step 2: when predicate — skip hidden segments.
    const whenTpl = seg.when !== undefined ? engine.parse(seg.when) : undefined;
    if (!evaluateWhen(whenTpl, scope)) continue;

    // Step 3: template → StripCells.
    const fragments = engine.parse(seg.template).evaluate(scope);
    const cells = fragmentsToStripCells(fragments);

    // Step 4: per-segment palette (3rq.2).
    const paletteName = effectiveSegmentPalette(config.globals, seg);
    const resolver =
      paletteName !== undefined ? resolverForPalette(paletteName) : basePalette;

    // Step 5: colors + layout.
    const bgTpl = seg.bg !== undefined ? engine.parse(seg.bg) : undefined;
    const fgTpl = seg.fg !== undefined ? engine.parse(seg.fg) : undefined;
    const defaultStyle = resolveSegmentColors(resolver, bgTpl, fgTpl, scope, {
      hueRotationDegrees: i * hueStep,
    });

    const laidOut = applySegmentLayout(cells, {
      width: seg.width ?? "auto",
      justify: seg.justify ?? "left",
      truncate: seg.truncate ?? "right",
      defaultStyle,
    });

    allCells.push(...laidOut);
  }

  // Step 6: join all cells into one ANSI line.
  return renderStripCells(allCells, opts);
}
