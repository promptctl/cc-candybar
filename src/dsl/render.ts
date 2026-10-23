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

import { createHash } from "node:crypto";
import type { ColorDepth, RichText } from "@promptctl/rich-js";
import { Defines, type Engine, type Template } from "@promptctl/go-template-js";
import type { Instant } from "../utils/instant.js";
import type { ClockFactory } from "../template-engine/clock.js";
import type {
  ValidatedConfig,
  VariableDecl,
  CacheDecl,
  Globals,
  LayoutNode,
  ParseDecl,
  SegmentNode,
  SettingValue,
  SourceDefault,
} from "../config/dsl-types.js";
import {
  parseArm,
  placementSetting,
  settingsOf,
  stateVarDecls,
} from "../config/dsl-types.js";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "../config/effective-globals.js";
import { PRESET_FLOOR, presetNames, presetRoot } from "../config/presets.js";
import { configOptionDomains } from "../config/edit-chrome.js";
import { EDIT_NS } from "../config/loader/reserved-namespace.js";
import type { Derivation, VariableStore } from "../var-system/store.js";
import type { SourceRegistry } from "../var-system/sources.js";
import {
  parseDuration,
  type CachePolicy,
  type GitField,
} from "../var-system/sources.js";
import type { SourceParse } from "../var-system/parse.js";
import type { JsonValue } from "../var-system/types.js";
import type { BuildLineOptions } from "../render/strip.js";
import {
  drawStripCells,
  stripChromeCols,
  stripSeamCols,
} from "../render/strip.js";
import { resolveFill } from "../render/fill.js";
import {
  SessionEffects,
  type MenuFlash,
  type RowKind,
} from "../render/effect.js";
import { flashAt } from "../config/menu-timeout.js";
import {
  decideEffectName,
  decideStyleName,
  decideThemeName,
  ruleFloorMessage,
  type Selection,
  EXPRESSION_SLOTS,
  type ExpressionSlot,
  finishSelection,
  drawnDepth,
  isExpression,
  SLOT_FLOORS,
  EFFECT_FLOOR,
  transposedPalette,
} from "../themes/index.js";
import { ANIMATION_SPEEDS, FOLLOW_BAR } from "../themes/policy.js";
import type { DrawnMotion } from "../render/drawn-motion.js";
import {
  bindClock,
  createCcCandybarEngine,
  engineClockFunctions,
  HIDDEN,
} from "../template-engine/index.js";
import {
  compileActions,
  actionFuncs,
  bindRender,
  renderBinding,
  type ActionRuntime,
} from "../render/action.js";
import { SESSION_KEY_TO_EFFECTIVE_VAR } from "../config/setting-projections.js";
import { disclosureCloseFragment } from "../render/disclosure-close.js";
import { pickerFuncs } from "../render/picker.js";
import { carouselFuncs } from "../render/carousel.js";
import { themePreviewFuncs } from "../render/theme-preview.js";
import { swatchFuncs, swatchesFuncs } from "../render/swatches.js";
import {
  LAYOUT_PREVIEW,
  layoutPreviewFuncs,
} from "../render/layout-preview.js";
import { menuFuncs, type MenuRuntime } from "../render/menu.js";
import {
  createActiveSegmentRef,
  type ActiveSegmentRef,
} from "../render/active-segment.js";
import { segmentColorFuncs } from "../render/segment-color.js";
import { variableScopes, type VarScope } from "./variable-scope.js";
import { evaluateOnce, viewParts, type ViewParts } from "./parts.js";
import { declaredVariables } from "../config/loader/refs.js";
import {
  projectionsOf,
  templateInstants,
  variableNamesOf,
} from "../config/loader/projections.js";
import {
  barRoot,
  bandRoot,
  descend,
  paletteRole,
  textOn,
  SHADES,
  VARIATIONS,
  type AddressStep,
  type Decor,
  type Region,
} from "../themes/decor.js";
// [LAW:one-way-deps] The node-type registry sits below this driver: it owns the
// compiled node shapes + each kind's compile/render, dispatched via nodeType().
// render.ts threads the recursion (compileChild/renderChild) in as
// capabilities; it never re-switches on node kind.
import {
  returnedBy,
  heldLine,
  nodeType,
  layoutRows,
  rowIdentities,
  type Compiled,
  type CompiledNode,
  type CompiledSegment,
  type CompiledSegments,
  type CompiledSegmentNode,
  type PlacementSettings,
  type RenderedLine,
  type RenderedLines,
  type NodeCompileCtx,
  type NodeGate,
  type NodeRenderCtx,
  type EvaluatedSegment,
  type PlacementParts,
} from "./node-registry.js";

// ─── Compiled config ───────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The full compiled artifact registerDslConfig
// produces: every segment's compiled templates AND the compiled layout tree
// (nodes with parsed `when`). renderDsl needs both; bundling them keeps the
// daemon cache holding one value, not two that could fall out of sync. The
// compiled node + segment shapes live in node-registry (the render layer that
// owns node behavior); this driver only assembles + walks them.
// A globals rule compiled once, with every path it was written at — the config's
// own `globals.<slot>` and/or `presets.<name>.globals.<slot>`, since one source
// may be authored in several fragments (save-as-preset copies globals verbatim).
export interface CompiledRule {
  readonly where: string;
  readonly template: Template<RichText>;
}

export interface CompiledConfig {
  readonly segments: CompiledSegments;
  // [LAW:dataflow-not-control-flow] EVERY preset's layout, compiled up front and
  // keyed by preset name — the render selects one by name rather than compiling
  // per session. This is the same move `styles` makes one level down (every
  // style's ThemeKey is resolved at load; the render picks one), and it is what
  // lets a per-SESSION preset pick ride a per-ENTRY compilation: one RenderCache
  // entry serves many sessions, so nothing session-shaped may be compiled here.
  // Total over `presetNames` — every selectable name, floor included — so the
  // lookup needs no absent case. A preset declaring no `root` of its own maps
  // to the config's own compiled root: the identity element, not a special
  // case.
  readonly roots: ReadonlyMap<string, CompiledNode>;
  // [LAW:locality-or-seam] The menu runtime the engine's `menu` func closes over.
  readonly menuRuntime: MenuRuntime;
  // [LAW:one-source-of-truth] The compiled template for every RULE the config
  // authored where a name could go — `style` (brandon-looks-pe6) and `palette`
  // (brandon-themes-dzl) — in every globals fragment the config-default rung
  // reads: the config's own `globals` and each preset's (brandon-themes-owl: the
  // resolution reads the ACTIVE preset's globals over the config's, so a rule
  // there is the default's rule while that preset is active). Keyed by the rule's
  // SOURCE, because that is what the `expression` arm a render meets carries: the
  // selection names the template it needs, so no reader re-derives which
  // fragment won [LAW:dataflow-not-control-flow]. A source is present here
  // exactly when `isExpression` said some fragment's slot holds it — the same
  // predicate the loader exempted from membership and the resolution reads. Each
  // entry carries every path that source was written at, so a report about the
  // rule sends the reader to the fragment(s) holding it.
  //
  // Parsed HERE, with every other pre-parsed template, for the two reasons those
  // are: the per-render cost is an evaluation and not a parse, and a malformed
  // template is a LOAD error — the place an author expects to be told — rather
  // than a render error they would hear about once per repaint.
  readonly globalExpressions: ReadonlyMap<
    ExpressionSlot,
    ReadonlyMap<string, CompiledRule>
  >;
  // [LAW:one-source-of-truth] The single "which segment is rendering" record
  // every segment-scoped template function reads — the menu's identity, the
  // `color` func's palette, the `bgOf` func's background. Surfaced here so the
  // walk can publish into it. One instance per compiled config; mutated
  // synchronously within a single renderDsl walk (renders are sequential +
  // synchronous, so no cross-render leak) — the spatial cousin of the hue
  // cursor, one owner. [LAW:no-ambient-temporal-coupling]
  readonly activeSegment: ActiveSegmentRef;
  // [LAW:one-source-of-truth] The templates above that read the instant
  // (projections.ts): a view derives these at every draw and keeps every other
  // template's answer until what it read changes (src/dsl/parts.ts). Whether
  // the layout `{{ layoutPreview }}` lays out reads it, through its gates.
  readonly instant: ReadonlySet<Template<RichText>>;
  readonly layoutReadsInstant: boolean;
  // [LAW:single-enforcer] Each store this compile draws from, with the parts it
  // keeps there. A store is drawn by one compile, and releases its parts with
  // its variables (VariableStore.dispose), so an entry here lives exactly as
  // long as its store.
  readonly views: WeakMap<VariableStore, ViewParts>;
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

// [LAW:one-source-of-truth] The authored parse step lowered onto the runtime
// seam — the ONE place "no `parse:`" is read as the text arm. The regex
// compiles here from the source string the loader proved compiles (and has
// its capture group). `default` crosses in the arm's own domain: the loader's
// sourceDefaultSpec is the enforcer of that pairing, so each arm's cast
// restates its stamp rather than re-checking it [LAW:parse-dont-validate];
// the store shapes a json default as it shapes a scan (toDocument).
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

// ─── Single variable declaration ──────────────────────────────────────────────

// [LAW:single-enforcer] One function dispatches every VariableDecl kind to its
// SourceRegistry method. No other code path declares variables.
function declareOne(
  registry: SourceRegistry,
  name: string,
  decl: VariableDecl,
  cwd: string,
  derivation: Derivation,
): void {
  switch (decl.kind) {
    case "literal":
      registry.declareLiteral(name, decl.value as string | number | boolean);
      break;

    case "dropped":
      registry.declareFailedDocument(name, decl.reason);
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
        cache: toCachePolicy(decl.cache),
        parse: toSourceParse(decl.parse, decl.default),
      });
      break;

    case "shell":
      registry.declareShell(name, decl.command, {
        cwd,
        cache: toCachePolicy(decl.cache),
        parse: toSourceParse(decl.parse, decl.default),
      });
      break;

    case "template":
      registry.declareTemplate(name, decl.template, {
        varDefault: decl.default,
        derivation,
      });
      break;

    case "time":
      registry.declareTime(name, {
        format: decl.layout,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

// [LAW:single-enforcer] Compile the config's shared helper templates into ONE
// define set: each name→body is parsed as its own `{{ define "name" }}body{{ end }}`
// unit, chained onto the previous helpers' set, so the result is one `Defines`
// every template this config parses inherits (`engine.parse(src, helpers)`).
// [LAW:one-source-of-truth] Inherited by link, never by copy. The previous
// shape — the defines' SOURCE prepended to every parse — re-parsed the whole
// helper block into every template: ~100 KB of AST per parse for the 2 KB
// stdlib block, ~287 parses per config, ~30 MB per config, and a daemon
// holding twenty configs sat at 600 MB of nothing but duplicated helper ASTs
// (the 2026-09-02 RSS-breach snapshot and the 2026-09-03 crash-loop).
// [LAW:no-silent-failure] Each body is parsed in ISOLATION, so a malformed
// helper surfaces a per-helper diagnostic rather than a confusing error blamed
// on the first segment that happens to call it; the redefinition check the
// parser applies against the inherited set is what makes helper names unique.
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
  // [LAW:no-silent-failure] `cwd` is required: it is the directory `git`
  // and `shell` sources run in, and the daemon's own process.cwd() is
  // whichever shell spawned it — a default here would be that wrong answer.
  opts: { cwd: string },
): RegisteredConfig {
  const { compiled, loadWarnings } = registerCompiled(
    config,
    registry,
    opts.cwd,
    compileAlone,
    EVERY_SCOPE,
  );
  return { ...compiled, loadWarnings };
}

/** The compile for a config's compile key and input. */
export type CompileProvider = (
  key: string,
  input: CompileInput,
) => CompiledConfig;

/** A compile of its own, for a caller with no other entry to share one with. */
export const compileAlone: CompileProvider = (_key, input) =>
  compileDslConfig(input);

/** A config composed into a registry: its compile, and its store's declarations. */
export interface Registration {
  readonly compiled: CompiledConfig;
  // [LAW:one-source-of-truth] The identity of `compiled`: what it was compiled
  // from, so registrations carrying one key may carry one compile.
  readonly compileKey: string;
  readonly loadWarnings: readonly string[];
}

// [LAW:single-enforcer] The one composition of a config into a registry, which
// `cc-candybar check` (registerDslConfig) and the daemon (buildRenderState)
// both take: the compile `compile` hands back for the config's key — a render
// cache's shared one, or one of its own — then the variables of `scopes`
// declared into the registry: both for a one-shot render, the directory's
// alone for a render cache entry, whose sessions each declare a view.
export function registerCompiled(
  config: ValidatedConfig,
  registry: SourceRegistry,
  cwd: string,
  compile: CompileProvider,
  scopes: ReadonlySet<VarScope> = EVERY_SCOPE,
): Registration {
  const input = compileInputOf(config);
  const key = compileKey(input);
  return {
    compiled: compile(key, input),
    compileKey: key,
    loadWarnings: declareDslVariables(config, registry, cwd, scopes),
  };
}

// A compile and the declaration failures of the store it was registered into.
export interface RegisteredConfig extends CompiledConfig {
  // [LAW:types-are-the-program] Variable declaration failures that did NOT
  // prevent the config from loading (type mismatches, bad defaults). The
  // affected variables are absent from the store; segments that reference them
  // render as error cells. Non-empty means "partial load" — the config is
  // usable but degraded. The store's, not the compile's: one compile serves
  // every store its config is declared into.
  readonly loadWarnings: readonly string[];
}

// [LAW:decomposition] What a compile reads — the config less its variables,
// and the one fact it derives from them: which variable reads back each
// session key. A variable's SOURCE is the store's business (declareDslVariables):
// a plugin's `{ checkout }` data path is resolved per checkout into
// `config.variables`, so a compile that could read it would differ per
// worktree. Plain JSON data by type — `stateReads` is entries sorted by key,
// never a Map, which JSON.stringify writes as `{}` — so its serialization is
// the identity of every compile it can produce (brandon-unfiled-3248.8yp).
export interface CompileInput {
  readonly config: Omit<ValidatedConfig, "variables">;
  readonly stateReads: ReadonlyArray<readonly [key: string, variable: string]>;
  // [LAW:one-source-of-truth] What the compile tells its own templates' reads
  // of the instant by (projections.ts): the declared variables' names, and
  // which are projections, with why — the one other fact of the variables a
  // compile reads, sorted so it is part of the compile's identity.
  readonly variableNames: readonly string[];
  readonly projections: ReadonlyArray<readonly [variable: string, why: string]>;
}

export function compileInputOf(config: ValidatedConfig): CompileInput {
  const { variables, ...rest } = config;
  // [LAW:one-source-of-truth] Map each SessionState key → the variable a `set`
  // on it reads back, so an option picker marks its current selection by
  // reading the SAME value the templates read — independent of whether the
  // config named the variable after the key. For an ordinary key that is the
  // `state` variable over it.
  //
  // A settings key the daemon resolves per render (theme, style, preset, …)
  // reads back through its `.effective` projection FIRST, ahead of any `state`
  // variable over the same key: the current value of a setting is the one the
  // bar is rendering with, so a carousel over `{ set: "theme", from: "themes" }`
  // centres on the theme the bar wears even when the session never picked one
  // — the same read-back the settings menu's controls get, so a bar control
  // and the menu cannot disagree (brandon-theme-picker-bgw.exj).
  const stateKeyToVar = new Map<string, string>();
  for (const [key, name] of SESSION_KEY_TO_EFFECTIVE_VAR) {
    if (name in variables) stateKeyToVar.set(key, name);
  }
  // Segment-local state vars read the same SessionState keys under their
  // namespaced `segName.varName` (the form the store + scope use); a global
  // wins on key collision (yielded first) — the value is the same key
  // regardless, so either reads correctly.
  for (const [name, decl] of stateVarDecls(config)) {
    if (!stateKeyToVar.has(decl.key)) stateKeyToVar.set(decl.key, name);
  }
  return {
    config: rest,
    stateReads: [...stateKeyToVar].sort(([a], [b]) => (a < b ? -1 : 1)),
    variableNames: [...variableNamesOf(config)].sort(),
    projections: [...projectionsOf(config)].sort(([a], [b]) =>
      a < b ? -1 : 1,
    ),
  };
}

// [LAW:one-source-of-truth] THE compile identity: two inputs with one key
// compile alike, so the render cache shares one compile between them.
export function compileKey(input: CompileInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

// Declare every variable of the given scopes into the registry — a directory's
// sources into its home, a session's values into its view (variable-scope.ts),
// or both into one registry for a one-shot render. Returns the declaration
// failures: the rest are declared (see RegisteredConfig.loadWarnings).
export function declareDslVariables(
  config: ValidatedConfig,
  registry: SourceRegistry,
  cwd: string,
  scopes: ReadonlySet<VarScope>,
): readonly string[] {
  const scopeOf = variableScopes(config);
  const projections = projectionsOf(config);
  // [LAW:dataflow-not-control-flow] One variable failing to declare does not
  // abort the rest. Errors are data (accumulated in loadWarnings); the store
  // simply lacks the broken variable. Segments that reference it get a
  // MissingFieldError at render time and show an error cell. Segments that
  // don't (e.g. configSwitcher) render normally.
  const loadWarnings: string[] = [];
  for (const [name, decl] of declaredVariables(config)) {
    if (!scopes.has(scopeOf.get(name)!)) continue;
    try {
      declareOne(
        registry,
        name,
        decl,
        cwd,
        projections.has(name) ? "projection" : "computed",
      );
    } catch (err) {
      loadWarnings.push(
        `Variable "${name}": ${(err as Error).message ?? String(err)}`,
      );
    }
  }
  return loadWarnings;
}

// Both scopes: a registry that is its own directory and its own one view.
export const EVERY_SCOPE: ReadonlySet<VarScope> = new Set([
  "directory",
  "view",
]);

// Pre-parse every template the config holds against one engine whose
// template functions read the store and clocks of the render in progress
// (ActionRuntime.bound), so the compile holds no store of its own.
export function compileDslConfig({
  config,
  stateReads,
  variableNames,
  projections,
}: CompileInput): CompiledConfig {
  // [LAW:locality-or-seam] One engine per config load, carrying THIS config's
  // action runtime. Engine creation amortizes across all of this config's segment
  // templates (parse-once); per-config (not per-render) is the right granularity
  // because the action set is config-scoped. The runtime holder is populated below
  // — the `action`/`picker` funcs reference the engine, and the compiled actions
  // reference the engine, so the holder breaks that cycle.
  // [LAW:one-source-of-truth] The action runtime reads through the SAME store the
  // render reads back — the one drawDsl binds for its walk, never one captured
  // here, since one compile serves every store its config is declared into.
  const actionRuntime: ActionRuntime = {
    bound: undefined,
    compiled: new Map(),
  };
  // [LAW:one-way-deps] Inject action + picker feature funcs as data — the engine
  // stays generic. The picker shares the ACTION runtime (it resolves its
  // apply/page actions from the same compiled table), so they read one source.
  // [LAW:one-source-of-truth] ONE record for "which segment is rendering", read
  // by every segment-scoped template function: `{{ menu }}` takes its identity
  // from the name, `{{ color }}` its palette, `{{ bgOf }}` its background. A
  // per-feature pointer would let two features disagree about which segment is
  // current. Built before the engine so the funcs can close over it; `current`
  // stays null until a render walk publishes one.
  // [LAW:one-source-of-truth] This engine's `readableOn` floors at the depth
  // its variables' does — the registry the render bound. Its clock is the
  // engine's own, the draw in progress, as theirs is.
  const drawnAt = (): ColorDepth =>
    renderBinding(actionRuntime, "drawnAt").registry.drawnAt();
  const activeSegment = createActiveSegmentRef(drawnAt);
  // [LAW:locality-or-seam] The menu runtime shares the action runtime (a menu's
  // glyph + body resolve from the same compiled table + store) and reads the
  // active segment through the shared record above.
  const menuRuntime: MenuRuntime = {
    action: actionRuntime,
    activeSegment,
  };
  // [LAW:one-source-of-truth] The config's style names — the one PER-CONFIG
  // option domain. Fed to every consumer (the `styles()` binding below, and —
  // via configOptionDomains, the SAME map cross-ref.ts and both gates
  // use — the compiled set-option domains), so the
  // rendered options, a hand-authored `range styles`, and the derived click
  // gate (which reads the same config in deriveActionValidators) trace to
  // one source.
  const styleNames = Object.keys(config.styles);
  const presetOptions = presetNames(config.presets);
  const perConfigDomains = configOptionDomains(config);
  // The swatch row's `?` picks from the draw's one instant, so a draw at a
  // given instant offers one pick, as it shows one clock.
  const renderClocks: readonly ClockFactory[] = [
    (clock) => swatchesFuncs(actionRuntime, activeSegment, clock.now),
  ];
  const engine = createCcCandybarEngine({
    extraFuncs: {
      ...actionFuncs(actionRuntime),
      ...swatchFuncs(actionRuntime),
      ...pickerFuncs(actionRuntime, activeSegment),
      ...carouselFuncs(actionRuntime, activeSegment),
      ...themePreviewFuncs(actionRuntime, activeSegment),
      ...layoutPreviewFuncs(actionRuntime, activeSegment),
      ...menuFuncs(menuRuntime),
      // [LAW:one-source-of-truth] `{{ color }}` reads the palette of the
      // segment currently rendering — the same palette its `bg:`/`fg:` resolve
      // from, published by the walk. Binding it to a palette captured HERE
      // (registration runs once per config load, renders happen per tick) was
      // the two-clocks bug this seam exists to close: a session theme click or
      // a style moved a segment's background while every in-body color stayed
      // where it was, so one segment painted from two palettes at once. Reading
      // live costs nothing structurally — FuncMap bodies run at evaluate time,
      // so parse-once/evaluate-many is untouched.
      // `{{ bgOf }}` rides the same record. [LAW:one-source-of-truth]
      ...segmentColorFuncs(activeSegment),
      // [LAW:one-type-per-behavior] The per-config sibling of the static
      // themes()/styles() bindings (template-engine/funcs.ts): zero-arg
      // projection of the "styles" option domain. Injected here — not in the
      // static FuncMap — because the domain is this config's styles block.
      styles: { fn: () => styleNames, argTypes: [], arity: { kind: "exact" } },
      // The presets domain's twin of the binding above — same per-config
      // reason, same shape. A hand-authored `range presets` and a
      // `{{ menu "applyPreset" }}` therefore enumerate the same names the
      // derived click gate admits.
      presets: {
        fn: () => presetOptions,
        argTypes: [],
        arity: { kind: "exact" },
      },
    },
    clockFuncs: renderClocks,
    drawnAt,
  });
  // [LAW:single-enforcer] THE one parse path for this config: every template —
  // segment template/when/bg/fg, node `when`, and action copy/open — inherits
  // the same helper define set, so `{{ template "name" }}` resolves against one
  // shared AST. One closure, not raw engine.parse scattered across sites, so
  // there is exactly one boundary where helpers come into scope (and one place
  // a helper could fail to be visible). The helpers are parsed ONCE here.
  const helpers = compileHelpers(engine, config.helpers);
  // Every template parsed, with its text: which read the instant is decided
  // once all are parsed (below), since a `{{ layoutPreview }}` reads every
  // layout gate.
  const sources = new Map<Template<RichText>, string>();
  const parse = (src: string): Template<RichText> => {
    const parsed = engine.parse(src, helpers);
    sources.set(parsed, src);
    return parsed;
  };
  // A node's templates recur across many nodes — edit mode gates every chrome
  // cell and every placed segment in every preset by a handful of predicates,
  // and draws one segment's remove lead and configure trail on both its label and its content —
  // so each distinct source is parsed once and its template shared. A parsed
  // template holds no evaluation state, so sharing one is sharing its AST.
  const nodeTemplates = new Map<string, Template<RichText>>();
  const parseShared = (src: string): Template<RichText> => {
    const known = nodeTemplates.get(src);
    if (known !== undefined) return known;
    const parsed = parse(src);
    nodeTemplates.set(src, parsed);
    return parsed;
  };
  const stateKeyToVar = new Map(stateReads);
  // [LAW:one-source-of-truth] Actions resolve their set key → the reading
  // variable through the stateKeyToVar map, so an apply action and the picker
  // that references it read one value.
  actionRuntime.compiled = compileActions(
    parse,
    config.actions,
    stateKeyToVar,
    perConfigDomains,
  );

  // Pre-parse all segment templates once.
  // renderDsl calls evaluate() only — parse() never runs in the hot render
  // path.
  // [LAW:no-defensive-null-guards] Object.create(null) — segment names come from
  // user config; a null-prototype object prevents __proto__/constructor/prototype
  // from being treated as segment data.
  const compiled: Record<string, CompiledSegment> = Object.create(
    null,
  ) as Record<string, CompiledSegment>;
  for (const [segName, seg] of Object.entries(config.segments)) {
    const parseField = (src: string, field: string, read = parse) => {
      try {
        return read(src);
      } catch (e) {
        throw new Error(
          `Template parse error in segments.${segName}.${field}: ${(e as Error).message}`,
          { cause: e },
        );
      }
    };
    compiled[segName] = {
      when:
        seg.when !== undefined
          ? parseField(seg.when, "when", parseShared)
          : undefined,
      template: parseField(seg.template, "template"),
      bg: seg.bg !== undefined ? parseField(seg.bg, "bg") : undefined,
      fg: seg.fg !== undefined ? parseField(seg.fg, "fg") : undefined,
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
      return parseShared(src);
    } catch (e) {
      throw new Error(
        `Template parse error in ${path}.${field}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  };
  // [LAW:parse-dont-validate] A placement's settings, resolved once against
  // its segment's declaration: the loader proved every value it sets is
  // declared and in its domain, so resolution is a fill of the defaults.
  // [LAW:one-source-of-truth] A setting configure mode can change reads
  // through its draft variable (SegmentNode.drafts), whose default IS the
  // value filled here — so the render shows a session's unsaved pick the
  // moment it lands, and the file's value while there is none. A pick the
  // declaration no longer admits parses to nothing and reads as no pick.
  const resolvedSettings = (node: SegmentNode): PlacementSettings => {
    // [LAW:no-defensive-null-guards] cross-ref proved every placed segment
    // is declared.
    const declared = settingsOf(config.segments[node.name]!);
    const out = Object.create(null) as Record<string, SettingValue>;
    for (const [name, decl] of Object.entries(declared)) {
      Object.defineProperty(out, name, {
        enumerable: true,
        get: () =>
          placementSetting(node, name, decl, (draft) =>
            String(
              renderBinding(actionRuntime, `setting ${name}`).store.read(
                draft.variable,
              ),
            ),
          ),
      });
    }
    // settingsOf always declares `theme` and `effect`, over domains whose
    // values are names (an effect's, the placement effects) — the one cast from
    // the record to what it provably holds.
    return Object.freeze(out) as PlacementSettings;
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
      placementSettings: resolvedSettings,
    };
    // [LAW:types-are-the-program] The registry pairs each kind with the
    // compile that returns that kind's own compiled arm (nodeType's documented
    // cast); this restates the pairing at the call site so a container hands
    // back a compiled container, not the union.
    return nodeType(node.kind).compile(node, cctx) as Compiled<N>;
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

  // [LAW:no-silent-failure] Parsed eagerly so a malformed rule is a load error
  // naming the path it was written at, not a per-render throw. Membership is
  // decided by SHAPE (`isExpression`), the same way a template is told from a
  // literal everywhere else here, so an entry exists iff the resolution can hand
  // renderDsl an `expression` arm carrying that source — one predicate, every
  // reader. [LAW:dataflow-not-control-flow] One fold over every fragment × every
  // slot: adding a slot or a preset never adds a branch here.
  // Keyed by slot, then source: one text written in both slots is two rules, and
  // a report about the palette's must not send the reader to the style.
  const globalExpressions = new Map(
    EXPRESSION_SLOTS.map((slot) => [slot, new Map<string, CompiledRule>()]),
  );
  const fragments: ReadonlyArray<readonly [string, Partial<Globals>]> = [
    ["globals", config.globals],
    ...Object.entries(config.presets).map(
      ([name, preset]) =>
        [`presets.${name}.globals`, preset.globals ?? {}] as const,
    ),
  ];
  for (const [path, globals] of fragments) {
    for (const slot of EXPRESSION_SLOTS) {
      const authored = globals[slot];
      if (!isExpression(authored)) continue;
      const where = `${path}.${slot}`;
      const rules = globalExpressions.get(slot)!;
      const seen = rules.get(authored);
      rules.set(
        authored,
        seen === undefined
          ? { where, template: parseExpressionSlot(parse, where, authored) }
          : { where: `${seen.where}, ${where}`, template: seen.template },
      );
    }
  }

  // [LAW:single-enforcer] Which of these templates read the instant
  // (projections.ts), so a view keeps every other as a derived value of its
  // store (src/dsl/parts.ts). A `{{ layoutPreview }}` lays out the active
  // preset under its gates, so it reads the instant when one of them does:
  // the gates are told first, by the engine's clock functions alone — a gate
  // is drawn outside any segment, where no layout can be asked for.
  const basis = {
    helpers: config.helpers,
    names: new Set(variableNames),
    projections: new Map(projections),
    clock: engineClockFunctions(renderClocks),
  };
  const gateReadsInstant = templateInstants(basis, config.actions);
  const gates = [...roots.values()].flatMap(layoutGates(compiled));
  const layoutReadsInstant = gates.some((gate) =>
    gateReadsInstant(sources.get(gate)!),
  );
  const readsInstant = templateInstants(
    {
      ...basis,
      clock: layoutReadsInstant
        ? new Set([...basis.clock, LAYOUT_PREVIEW])
        : basis.clock,
    },
    config.actions,
  );
  const instant = new Set(
    [...sources].flatMap(([template, source]) =>
      readsInstant(source) ? [template] : [],
    ),
  );

  return {
    segments: compiled,
    roots,
    activeSegment,
    menuRuntime,
    globalExpressions,
    instant,
    layoutReadsInstant,
    views: new WeakMap(),
  };
}

// The segments a compile's draws evaluate at every frame: those any of whose
// templates read the instant, in declaration order.
export function instantSegments(compiled: CompiledConfig): string[] {
  return Object.entries(compiled.segments).flatMap(([name, segment]) =>
    [segment.when, segment.bg, segment.fg, segment.template].some(
      (template) => template !== undefined && compiled.instant.has(template),
    )
      ? [name]
      : [],
  );
}

// [LAW:one-source-of-truth] The gates a layout's `{{ layoutPreview }}` reads:
// the own `when` of every node `layoutRows` asks about, all of them shown, and
// each segment's among them — so no gate it never asks makes it a projection.
const layoutGates =
  (segments: CompiledSegments) =>
  (root: CompiledNode): Array<Template<RichText>> => {
    const asked: CompiledNode[] = [];
    layoutRows(root, (node) => {
      asked.push(node);
      return true;
    });
    return asked.flatMap((node) => [
      ...(node.when === undefined ? [] : [node.when]),
      ...(node.kind === "segment" && segments[node.name]!.when !== undefined
        ? [segments[node.name]!.when!]
        : []),
    ]);
  };

// ─── A globals slot holding a rule (brandon-looks-pe6, brandon-themes-dzl) ───

// [LAW:no-silent-failure] Re-thrown with the slot attached: the engine knows the
// template is malformed, only cc-candybar knows which config field it came from.
// The same reasoning (and the same shape) as a `bg:`/`fg:` parse failure.
function parseExpressionSlot(
  parse: (src: string) => Template<RichText>,
  path: string,
  source: string,
): Template<RichText> {
  try {
    return parse(source);
  } catch (e) {
    throw new Error(
      `${path} is not a valid template: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// [LAW:no-defensive-null-guards] `isExpression` gates BOTH the compile in
// registerDslConfig and the `expression` arm the resolution produces, over the
// same fragments, so a missing template here is drift between two readers of
// that one predicate — a loud caller bug, never a case to absorb into a field's
// floor.
function compiledRule(
  compiled: CompiledConfig,
  slot: ExpressionSlot,
  source: string,
): CompiledRule {
  const rule = compiled.globalExpressions.get(slot)!.get(source);
  if (rule === undefined) {
    throw new Error(
      `the ${slot} rule ${JSON.stringify(source)} reached the render but no compiled ` +
        `template exists — registerDslConfig and the resolution disagree about isExpression`,
    );
  }
  return rule;
}

// [LAW:single-enforcer] THE reading of a globals rule: the name it wrote, or —
// when its template threw (a `fail`, a missing field) — its slot's floor,
// reported. Thrown on, a rule's own fault would take the whole statusline away
// (brandon-unfiled-3248.2gq), where a failing segment costs one ⚠ cell; a
// globals slot has no cell of its own, so the strip is where it says so
// [LAW:no-silent-failure]. The floor is a NAME, so each slot's `decide` turns
// it into that slot's floor value exactly as it would a rule naming it. The
// rule itself is a part of the view (`ViewParts.rule`).
function evalRule(
  slot: ExpressionSlot,
  rule: CompiledRule,
  parts: ViewParts,
  warn: (warning: RenderWarning) => void,
): string {
  const outcome = parts.rule(rule.template);
  switch (outcome.kind) {
    case "named":
      return outcome.name;
    case "failed":
      warn({
        kind: "rule",
        slot,
        message: ruleFloorMessage(
          rule.where,
          slot,
          `the rule failed — ${outcome.error}`,
        ),
      });
      return SLOT_FLOORS[slot];
  }
}

// The name a render publishes for a slot BEFORE its fold has finished: the
// decided name, or that slot's floor when only this render can settle it — the
// floor a failing rule collapses to, read from the one table.
// [LAW:dataflow-not-control-flow] One total projection of the union to one value,
// shared by every slot, rather than a per-slot branch at the push site.
function provisionalName<T>(
  selected: Selection<T>,
  slot: ExpressionSlot,
): string {
  return selected.kind === "decided" ? selected.name : SLOT_FLOORS[slot];
}

// The ids of the placements a layout node holds, its open bodies' included:
// what names a container to its author. Its compiled `when` is edit chrome's
// wrapping of the one they wrote and its path is a position in the synthesized
// tree, while a placement keeps its id through every synthesis. Edit chrome's
// own cells are not the author's.
function placementsUnder(node: CompiledNode): string[] {
  return segmentsUnder(node)
    .filter((segment) => !segment.name.startsWith(EDIT_NS))
    .map((segment) => segment.id);
}

// Every segment node a layout node holds, its open bodies' included, in order.
function segmentsUnder(node: CompiledNode): CompiledSegmentNode[] {
  if (node.kind === "container") return node.children.flatMap(segmentsUnder);
  return [
    node,
    ...(node.opens === undefined ? [] : segmentsUnder(node.opens.body)),
  ];
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
 *      cells per row); a `segment` leaf evaluates into cell lines. A node whose
 *      `when` (or an ancestor's) is false contributes no line; its ADDRESS — the
 *      position its colours derive from — is unchanged by being hidden, so
 *      visible siblings keep their colours.
 *   4. Serialize each composed line through the ONE strip joiner and join "\n".
 *
 * [LAW:single-enforcer] The daemon calls this verbatim — no alternate render
 * path. ONE walk renders every layout, flat or nested. The test and the daemon
 * share it.
 * [LAW:dataflow-not-control-flow] Node visibility, node count, and per-leaf
 * segment count are all data; a deeper tree is more recursion, not more code.
 * The projection (how a container maps children onto the plane) is the
 * `direction` VALUE, not a branch in the walk.
 */
// [LAW:locality-or-seam] The optional render observers, bundled as ONE named bag
// so a caller states what it passes by name — no positional tail to count, no
// `undefined` holes to reach a later observer, and a new observer is one field
// here rather than a signature change every caller re-counts.
export interface RenderObservers {
  // [LAW:dataflow-not-control-flow] Optional per-segment cell sink. When
  // present, each rendered segment's RichText array (post-layout, pre-
  // serialization) is written to this map under its placement id — its
  // segment's name unless the placement names its own. Storing
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
  readonly onSegmentError?: (placementId: string, message: string) => void;
  // [LAW:no-silent-failure] Optional observer for what this render had to settle
  // for itself and could not honour (`RenderWarning`). The render goes on — a
  // throw would take the whole statusline away — but nothing else on the bar
  // says why it looks as it does.
  //
  // Optional for the same reason the two above are: a caller that passes none has
  // said it is not listening (a compile-only test, the demo). Both shipping
  // callers listen — the daemon folds every one into the diagnostic strip's
  // warning channel, and `cc-candybar check` fails a globals rule, a gate or a
  // variable that cannot refresh, so each is visible whether or not anyone is
  // looking at a bar. Check lists
  // a band-floor shortfall only where its own renders open a trigger — one open
  // by default; it opens none itself, so a shortfall behind a closed trigger
  // reaches the bar alone.
  readonly onRenderWarning?: (warning: RenderWarning) => void;
}

// [LAW:types-are-the-program] A drawn frame: its bytes, and its motion
// (brandon-doctor-v62x.tgp). `moves` is what its cells say (`DrawnRow.moves`),
// never what the config asked for: a template's `frames` moves the bar as
// surely as an effect does. `can-move` is a still frame whose config, under
// the settings in force, can draw motion at a later render — a
// `globals.effect` rule, placements that fade as they come and go, or a
// placement wearing its own effect that is not drawn now (hidden by its
// `when`, or in a closed body) — which no still cell can say.
export interface DrawnFrame {
  readonly text: string;
  readonly motion: DrawnMotion;
  // The rows an open menu added — a disclosure body, a dropped `{{ menu }}` —
  // which flash and close once the session goes idle.
  readonly menuRows: number;
  // How many of the view's parts this frame evaluated (src/dsl/parts.ts):
  // between data changes, only those that read the instant.
  readonly evaluated: number;
}

// [LAW:types-are-the-program] What a render could not honour, by what failed:
// the kind is what a consumer that treats them differently reads, never the
// prose.
export type RenderWarning =
  // A globals RULE the render could not honour, so `slot` wears its floor: its
  // template threw (brandon-unfiled-3248.2gq), or a palette rule's result named
  // no installed theme (brandon-themes-dzl). A globals slot has no cell of its
  // own to show a ⚠ in the way a failing segment does.
  | {
      readonly kind: "rule";
      readonly slot: ExpressionSlot;
      readonly message: string;
    }
  // A container's own `when` whose template threw, so what it gates is
  // hidden (brandon-unfiled-3248.ryf). A container has no cell to show a ⚠ in;
  // a placement's gate failing draws its ⚠ instead, through onSegmentError.
  // `where` names it as a placement's ⚠ is named, `error` says why.
  | {
      readonly kind: "when";
      readonly where: string;
      readonly error: string;
      readonly message: string;
    }
  // A floor an open band stands short of as drawn (decor.ts `bandFor`): its
  // trigger off the cells of the row it stands in, or its plane off its
  // trigger. Drawn as near as it comes, and the message names the setting that
  // clears it — a fact about the chosen look, not a fault in the config.
  | { readonly kind: "band-floor"; readonly message: string }
  // A variable whose cache policy cannot fire — its key template throws, or
  // the OS refused its watch — so the bar draws its last value with no cell of
  // its own to say it has stopped refreshing (brandon-var-system-7wl9).
  | {
      readonly kind: "refresh";
      readonly variable: string;
      readonly error: string;
      readonly message: string;
    };

// [LAW:locality-or-seam] The per-render RESOLUTION the caller performs and hands
// down — the values that are neither config (compiled once) nor payload (input
// data), but the session's live choices resolved against the config: which
// theme, style, effect, preset, variation and shade, and whether placements
// fade. Bundled as ONE named bag for exactly the reason RenderObservers is.
// [LAW:one-source-of-truth] Each field IS the field `resolveEffectiveGlobals`
// resolves (see EffectiveGlobals for how): a Pick, not a restatement, so the
// selection cannot hold a field the resolution does not, and every one is
// required — a caller hands over the whole resolution or none of it.
export type RenderSelection = Pick<
  EffectiveGlobals,
  | "theme"
  | "style"
  | "effect"
  | "preset"
  | "variation"
  | "shade"
  | "transitions"
  | "animationSpeed"
  | "menuTimeout"
> & {
  // The session's effect memory: when its effect came into force (the effect's
  // own t = 0), the effects already made for its rows, and what each placement
  // its last frame drew. The daemon hands each session its own; an omitting
  // caller draws with a fresh one, so its render is the effect's calm first
  // frame and nothing in it fades in or dissolves out.
  readonly effects?: SessionEffects<RenderedLine>;
  // When the session's idle period began — its last click, or its first
  // render by this daemon (src/daemon/menu-idle.ts) — which the flash its open
  // menus wear before they close counts from. A caller with no such clock
  // (check, the demo) never flashes.
  readonly idleSince?: Instant;
};

// The bar's bytes alone: `drawDsl`'s text, for a caller that draws one frame
// and asks nothing of its motion.
export function renderDsl(...args: Parameters<typeof drawDsl>): string {
  return drawDsl(...args).text;
}

export function drawDsl(
  config: ValidatedConfig,
  compiled: CompiledConfig,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  // [LAW:effects-at-boundaries] The instant this render is drawn at, sampled by
  // the caller: nothing rendered reads a clock of its own.
  at: Instant,
  opts: BuildLineOptions,
  observers?: RenderObservers,
  // [LAW:one-source-of-truth] An omitting caller renders as a session that has
  // never clicked: the daemon's own resolution with no picks, so a config
  // declaring globals.preset or globals.style draws the preset, theme and look
  // the bar does. `opts` stays the caller's own: the daemon derives it from the
  // same resolution (`renderOptionsOf`). Whether the file authors the preset's
  // root is no part of the selection.
  selection: RenderSelection = resolveEffectiveGlobals(
    config,
    () => null,
    () => false,
  ),
): DrawnFrame {
  const { perSegmentSink, onSegmentError, onRenderWarning } = observers ?? {};
  const warn = (warning: RenderWarning): void => onRenderWarning?.(warning);
  // The band-floor shortfalls of the bands this render opens, each reported
  // once after the walk however many triggers open a band that falls short.
  const shortfalls = new Set<string>();
  // [LAW:one-source-of-truth] The session's animation clock, read once at the
  // render's instant: its templates' `frames` animate by this reading, and the
  // effects below by the same value (brandon-menus-sjhy.nt2).
  const effects = selection.effects ?? new SessionEffects<RenderedLine>("");
  const clock = effects.clockAt(at, ANIMATION_SPEEDS[selection.animationSpeed]);
  // [LAW:one-source-of-truth] The instant this render draws at, bound to the
  // engines' one clock for the walk and unbound on every exit: every time read
  // below — a template's `now`, a `time` variable — reads the one instant.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- held for its disposal
  using _clock = bindClock(at, clock.anim);
  // The depth it draws at, into the view's registry: every text colour chosen
  // below — and every variable template's `readableOn` — is floored on it.
  registry.drawAt(drawnDepth(opts.colorCompatibility));
  // [LAW:one-source-of-truth] The view's parts: every template below is read
  // through them, kept until what it read changes unless it reads the instant
  // (src/dsl/parts.ts). The draw's own facts first, so no part reads the last
  // draw's.
  const facts = {
    width: opts.width,
    chromeCols: stripChromeCols(opts),
    padding: opts.padding,
    seamCols: stripSeamCols(opts),
    preset: selection.preset,
  };
  const parts = viewParts(compiled, store, registry, facts);
  parts.draw(facts);
  const evaluatedBefore = parts.evaluated;
  // [LAW:no-ambient-temporal-coupling] The compile may serve many stores (one
  // per render-cache entry its config compiles alike in): every template it
  // evaluates below reads THIS view's binding, bound for the walk and dropped
  // on every exit, a throw included, so the compile keeps nothing of it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- held for its disposal
  using _bound = bindRender(compiled.menuRuntime.action, parts.binding);
  const {
    preset,
    theme: selectedTheme,
    style: selectedStyle,
    effect: selectedEffect,
    transitions,
  } = selection;
  const decor: Decor = {
    variation: VARIATIONS[selection.variation],
    shade: SHADES[selection.shade],
  };
  // [LAW:one-source-of-truth] Inject the usable width as `term.cols` from the
  // SAME opts.width the strip wraps to (below) and a row fits to (published as
  // RenderBinding.width), so a template reads the exact wrap width — never a
  // cached or independently-measured copy. This is the RAW usable width
  // (terminal cols minus the Claude-Code reserve), the honest meaning every
  // template — incl. user configs reading `.term.cols` — expects. The picker's
  // strip-chrome reservation is NOT folded in here: that is a row-local concern
  // (the strip's end-caps wrap the picker's row, not every segment), applied at
  // the fitting seam in rowBudget. [LAW:locality-or-seam]
  // Spreading a non-object payload yields no keys (compile-only callers), so the
  // width is set regardless without a trust-boundary guard.
  // [LAW:one-source-of-truth] `theme.effective` and `style.effective` are each
  // published by whatever FINISHED that field's fold, and nothing else CAN publish
  // them: under a rule nobody upstream knows the answer, and under a decided name
  // the selection already carries it. So the payload never carries either field —
  // renderDsl injects both, exactly as it injects `term.cols`, which is why a
  // `{{ .theme.effective }}` / `{{ .style.effective }}` label and the palette the
  // bar is actually painted from cannot disagree (brandon-looks-pe6,
  // brandon-themes-dzl).
  const payloadWith = (
    themeName: string,
    styleName: string,
    effectName: string,
  ): object => ({
    ...(payload as object),
    term: { cols: opts.width },
    theme: { effective: themeName },
    style: { effective: styleName },
    effect: { effective: effectName },
  });
  // An expression arm's provisional value is its FLOOR: it is what that slot
  // collapses to when its result names nothing, so a rule reading its own
  // `.effective` (a self-reference) sees the answer it would get by naming
  // nothing, rather than a stale value from a previous render. A rule in ONE slot
  // reading the OTHER's `.effective` sees the same thing, which is why neither
  // slot's rule may be written to depend on the other's result.
  registry.applyInput(
    payloadWith(
      provisionalName(selectedTheme, "palette"),
      provisionalName(selectedStyle, "style"),
      provisionalName(selectedEffect, "effect"),
    ),
  );
  // The other half of each fold, which could only ever happen here: a rule reads
  // the store the push above just filled with this render's values. A decided
  // selection returns ITSELF, so the republish below is skipped by identity
  // rather than by re-testing the discriminator [LAW:dataflow-not-control-flow].
  // [LAW:one-type-per-behavior] One `finishSelection` for both slots; what differs
  // is the two values each hands it — which template to evaluate, and how a name
  // becomes that field's value.
  const theme = finishSelection(selectedTheme, (source) => {
    const rule = compiledRule(compiled, "palette", source);
    // [LAW:effects-at-boundaries] The message belongs to the theme domain, the
    // channel to the caller: a result naming no installed theme renders the floor
    // and says so, rather than throwing away the whole bar.
    return decideThemeName(
      evalRule("palette", rule, parts, warn),
      rule.where,
      (message) => warn({ kind: "rule", slot: "palette", message }),
    );
  });
  const style = finishSelection(selectedStyle, (source) =>
    decideStyleName(
      evalRule("style", compiledRule(compiled, "style", source), parts, warn),
      config.styles,
    ),
  );
  const effect = finishSelection(selectedEffect, (source) =>
    decideEffectName(
      evalRule("effect", compiledRule(compiled, "effect", source), parts, warn),
    ),
  );
  // [LAW:no-silent-failure] A rule arm learned a name the push above could not
  // carry, so push it: without this the settings menu's `🎨 theme` / `◐ style`
  // controls would label themselves from the floor while the bar wore the rule's
  // result — one fact with two answers. All payload ingestion goes through
  // applyInput (see SourceRegistry's own contract), so this is that one path,
  // called again, not a second way to write an input box.
  if (
    theme !== selectedTheme ||
    style !== selectedStyle ||
    effect !== selectedEffect
  )
    registry.applyInput(payloadWith(theme.name, style.name, effect.name));
  // [LAW:one-source-of-truth] The render's BASE palette: a picker over a
  // colour-valued domain paints each option in the palette picking it would put
  // in force, and a style's answer is this base transposed by that style's key —
  // the base, never the styled palette below, because a style applies to the
  // base by definition. Under a rule, this is the first line at which the base
  // palette is known.
  const basePalette = theme.value;
  // [LAW:one-source-of-truth] The render's palette: the base theme under the
  // session's style, transposed ONCE here — every unpinned segment colours from
  // this one object, so a style click recolours the whole bar from one
  // transposition, not one per segment.
  const palette = transposedPalette(basePalette, style.value);
  // The look the walk below draws in, published before it evaluates a template
  // that reads it (`renderLook`).
  parts.publishLook({ basePalette, palette, decor });
  // The motion of each row this render draws: the session's effect memory
  // records the settled effect coming into force, so its clock starts there,
  // and what each placement this frame draws, so one the last frame — drawn
  // from this config, preset and session state — did not draw fades in, and
  // one it drew that this frame does not dissolves out as it was drawn there.
  // [LAW:one-source-of-truth] The flash counts down to the instant the
  // daemon's timer closes the menus (`flashAt`), lit in the theme's `warning`
  // — something is about to happen — under the text chosen for it.
  const flashT =
    selection.idleSince === undefined
      ? null
      : flashAt(selection.idleSince, selection.menuTimeout, at);
  const flashFill = paletteRole(palette, "warning");
  const flash: MenuFlash =
    flashT === null
      ? null
      : {
          t: flashT,
          fill: flashFill,
          text: textOn(palette, flashFill, registry.drawnAt()),
        };
  const motion = effects.motion(
    effect.value,
    clock,
    {
      transitions,
      source: {
        config,
        preset,
        revision: registry.stateRevision(),
        width: opts.width,
      },
      returned: returnedBy,
      hold: heldLine,
    },
    flash,
  );

  perSegmentSink?.clear();

  // [LAW:no-defensive-null-guards] A segment node names one declared segment
  // (the loader validates it); a miss is a caller bug the segment render
  // throws on.
  const lookupSegment = (name: string) => config.segments[name];

  // [LAW:no-silent-failure] Every floor an open band stands short of, from
  // what the placement evaluated to, reported once after the walk.
  const collected = (evaluated: EvaluatedSegment): EvaluatedSegment => {
    for (const shortfall of evaluated.shortfalls) shortfalls.add(shortfall);
    return evaluated;
  };
  const placement = (node: CompiledSegmentNode): PlacementParts => {
    const own = parts.placement(node);
    return {
      shown: () => own.shown(),
      bodyOpen: () => own.bodyOpen(),
      evaluate: (palette, region) => collected(own.evaluate(palette, region)),
    };
  };

  // [LAW:dataflow-not-control-flow] ONE walk renders any node to LINES OF CELLS
  // (serialization deferred to the root). The driver owns the cross-cutting
  // `when`: a node under a parent not shown is hidden, and any other is gated
  // by its own predicate — shown, hidden, or failed, never collapsed to a
  // boolean, since what a failure costs is the node type's to say. It then
  // dispatches to the node type's render via nodeType() — no kind switch here.
  // The node count, nesting depth, and per-leaf segment count are all data; a
  // deeper tree is more recursion, not more code.
  const renderNode = (
    node: CompiledNode,
    parentVisible: boolean,
    region: Region,
  ): RenderedLines => {
    // A hidden parent's child is hidden without its `when` being asked.
    const evaluated = parentVisible ? parts.gate(node) : HIDDEN;
    const gate: NodeGate =
      evaluated.kind === "failed"
        ? {
            ...evaluated,
            report: () => {
              const where = `when over ${placementsUnder(node).join(", ") || "no placement"}`;
              warn({
                kind: "when",
                where,
                error: evaluated.message,
                message: `${where}: ${evaluated.message} — what it gates is hidden`,
              });
            },
          }
        : evaluated;
    const ctx: NodeRenderCtx = {
      scope: parts.scope,
      palette,
      gate,
      padding: opts.padding,
      region,
      perSegmentSink,
      onSegmentError,
      placement,
      evaluateOnce: (node, scope, palette, body) =>
        collected(
          evaluateOnce(
            compiled.activeSegment,
            node,
            palette,
            region,
            registry.drawnAt(),
            body,
            scope,
          ),
        ),
      lookupSegment,
      renderChild: (child, childVisible, step: AddressStep) =>
        renderNode(child, childVisible, descend(region, step)),
      // A disclosure body starts a NEW region: the root of the band its
      // trigger opens. Depth is a fact of that band — counted up by
      // `decorationFor` each time a band item opens the next — so a nested
      // `{{ menu }}` inside door → ⚙ lands at depth 2 with no walk state.
      renderBody: (body, open, band) =>
        renderNode(body, gate.kind === "shown" && open, bandRoot(band)),
      // [LAW:one-source-of-truth] The row ✕ reads the session id from the
      // same store every other affordance's URL does.
      closeDisclosure: (key) => disclosureCloseFragment(store, key),
      placed: motion.placed,
    };
    return nodeType(node.kind).render(node, ctx);
  };

  // [LAW:single-enforcer] The ONE serialization pass: each composed line of cells
  // runs through the strip joiner exactly once, here. drawStripCells may itself
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
  const rendered = rowIdentities(renderNode(root, true, barRoot(decor)))
    // A row's fill demands resolve here and nowhere else: this is the one place a
    // composed row and the width it must fit are both in hand (brandon-layout-0c2).
    // [LAW:one-source-of-truth] A row's motion follows the row, not its line
    // number, so a menu opening over it does not move it onto another's.
    // Its items are what the strip stamps their cells with, each beside the
    // effect its cell demands.
    .map(({ line, row }) => {
      const items = resolveFill(line.cells, opts);
      // At the root, a `deeper` line is one an open menu added.
      const kind: RowKind = line.band === "deeper" ? "menu" : "bar";
      return {
        kind,
        ...drawStripCells(
          items.map((item) => item.owner),
          opts,
          motion.row(row, kind, items),
        ),
      };
    });
  motion.drawn();
  const menuRows = rendered.filter((row) => row.kind === "menu").length;
  // What the frame arms under the settings in force, drawn or not: an open
  // menu, which flashes before it closes on its own, an effect rule, fades, or a placement of this preset — hidden by its `when` or a
  // closed body right now — wearing an effect of its own. Asked only of a
  // frame no row of which moves.
  const armed = (): boolean =>
    menuRows > 0 ||
    selectedEffect.kind === "expression" ||
    transitions ||
    segmentsUnder(root).some(
      ({ settings }) =>
        settings.effect !== FOLLOW_BAR && settings.effect !== EFFECT_FLOOR,
    );
  const frameMotion: DrawnMotion = rendered.some((row) => row.moves)
    ? "moves"
    : armed()
      ? "can-move"
      : "still";
  for (const message of shortfalls) warn({ kind: "band-floor", message });
  // Read after the walk: the payload this render pushed is what a key reads.
  for (const [variable, fault] of registry.cachePolicyFaults())
    warn({
      kind: "refresh",
      variable,
      error: fault.message,
      message: `variable "${variable}" cannot refresh: ${fault.message}`,
    });
  return {
    text: rendered.map((row) => row.text).join("\n"),
    motion: frameMotion,
    menuRows,
    evaluated: parts.evaluated - evaluatedBefore,
  };
}
