// [LAW:one-type-per-behavior] Three primitives, three concerns:
//
//   parseDslConfig (text → RawDslConfig)
//     JSON5 syntax + per-record structural validation. Rejects the removed
//     `layout:` key and `kind:"cells"` node with migration-pointing errors.
//     Throws ConfigError on syntax / structural problems.
//
//   mergeWithDefault (RawDslConfig + DslConfig → DslConfig)
//     Cascade: shallow merge globals fields, by-name merge variables,
//     by-name then by-FIELD merge of segments and presets (a file's
//     declaration under a bundled name is a delta), by-name merge of root's
//     rows (a whole tree replaces). Pure function.
//
//   validateConfig (DslConfig → ValidatedConfig)
//     Cross-references + cycle detection on the merged shape. Sole producer
//     of ValidatedConfig. Throws ConfigError on cross-ref / cycle problems.
//
// loadConfig (path|null → DslConfig) wires parse+merge for the daemon's
// production path. validateConfig finishes the chain.
//
// [LAW:dataflow-not-control-flow] Validation passes accumulate issues into
// a list; consumers see every problem at once (compiler-style).
//
// This file is the pipeline orchestrator + the public barrel. Each validation
// concern lives in its own `loader/` module (split by change-reason); the
// re-exports below keep the import surface stable for every consumer.

import fs from "node:fs";
import JSON5 from "json5";
import {
  type DslConfig,
  type RawDslConfig,
  type ValidatedConfig,
} from "./dsl-types.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
import {
  ConfigError,
  editabilityNotice,
  findKeyLine,
  type ConfigIssue,
} from "./loader/diagnostics.js";
import {
  describeType,
  isPlainObject,
  type Mutable,
  type ValidateCtx,
} from "./loader/validate-core.js";
import { mergeWithDefault } from "./loader/merge.js";
import {
  validateEditGlobals,
  validateGlobals,
  validateThemeDefaults,
} from "./loader/globals.js";
import { validateVariables } from "./loader/variables.js";
import {
  inheritableSegmentNames,
  validateSegments,
} from "./loader/segments.js";
import { synthesizeGroupDecls, validateRootFragment } from "./loader/layout.js";
import {
  checkMenuDecls,
  synthesizePlacementMenus,
} from "./loader/menu-synth.js";
import { synthesizeEditModeToggle } from "./loader/edit-mode.js";
import { synthesizeEditChrome } from "./edit-chrome.js";
import { synthesizeSettingsMenu } from "./settings-menu.js";
import {
  reservedNamespaceCollisions,
  SETTINGS_NS,
} from "./loader/reserved-namespace.js";
import {
  actionHomeOf,
  validateActions,
  type ActionHome,
} from "./loader/actions.js";
import { validateStyles } from "./loader/styles.js";
import { validatePresets } from "./loader/presets.js";
import { validateHelpers } from "./loader/helpers.js";
import {
  validateCrossReferences,
  validateDeclarations,
} from "./loader/cross-ref.js";
import { templateScopeOf } from "./loader/refs.js";
import { validateNoCycles } from "./loader/cycles.js";
import { validateNoNesting } from "./loader/nesting.js";
import {
  applyPlugins,
  ownedBy,
  listedPlugins,
  droppedPluginNotice,
  type PluginContext,
  withDroppedPlacements,
  dropsOwning,
  type DroppedPlugin,
  type PluginLayer,
} from "./loader/plugins.js";
import { installedPlugins } from "./loader/plugin-folders.js";
import { type Checkout, checkoutOf } from "../utils/git-root.js";

// ─── Public barrel ───────────────────────────────────────────────────────────
// [LAW:locality-or-seam] Consumers import from `dsl-loader`; the internal split
// is invisible to them. Moving a symbol between loader/ modules never touches a
// callsite as long as it stays re-exported here.

export {
  ConfigError,
  editabilityNotice,
  findKeyLine,
} from "./loader/diagnostics.js";
export type { ConfigIssue } from "./loader/diagnostics.js";
export {
  dslConfigCandidatePaths,
  resolveDslConfig,
  configResolutionNotice,
  durableConfig,
  detectConfigCollisions,
} from "./loader/discovery.js";
export type { ConfigHome, ConfigResolution } from "./loader/discovery.js";
export type { Unchecked } from "../utils/presence.js";
export { mergeWithDefault } from "./loader/merge.js";
export { inheritableSegmentNames } from "./loader/segments.js";
export { templateReads } from "./loader/refs.js";
export { droppedPluginNotice } from "./loader/plugins.js";
export type { DroppedPlugin } from "./loader/plugins.js";

// ─── Three-stage pipeline ────────────────────────────────────────────────────

/**
 * Load a JSON5 DSL config file from disk and merge it with the given
 * default. Returns the effective DslConfig AND the raw source text.
 *
 * `path = null` means "no user file exists" — returns `dflt` unchanged
 * (uniform merge against an empty raw, which is deep-equal to `dflt`) and
 * an empty source. No consumer branches on file presence; that branch lives
 * inside loadConfig exactly once.
 *
 * [LAW:one-way-deps] `dflt` is a required parameter, not a default pointing at
 * DEFAULT_DSL_CONFIG: this module is generic merge/parse machinery, and
 * DEFAULT_DSL_CONFIG is a specific, higher-level instance built ON TOP of it
 * (default-dsl-config.ts imports parseDslConfig/mergeWithDefault to
 * synthesize itself — see that file). A default param here pointing back at
 * DEFAULT_DSL_CONFIG would make this generic module depend on its own
 * specific consumer — a cycle every caller who wants "the bundled default"
 * resolves explicitly by importing DEFAULT_DSL_CONFIG themselves.
 *
 * [LAW:one-source-of-truth] The source and the parsed raw shape are returned
 * alongside the config, so the whole result is validateConfig's input —
 * cross-ref diagnostics walk the fragments the file wrote and quote its lines
 * — and the caller can ask the raw shape what the file itself AUTHORS (which
 * preset roots it declares; candybar-config-dqe's `preset.customized`), all
 * from one read rather than a re-read or a re-parse downstream.
 *
 * `warnings` are the advisories the file's own text earns once it is JSON5 —
 * today the editability notice (a duplicate key the render path tolerates but
 * the config-file editor refuses, brandon-config-16g). They ride the same
 * channel as the register pass's `loadWarnings`; when structural validation
 * fails instead, the thrown ConfigError carries them.
 *
 * Throws ConfigError on JSON5 syntax / structural / per-record validation
 * failures. Cross-references and cycles are validateConfig()'s job.
 *
 * [LAW:dataflow-not-control-flow] One function, one branch, same operations
 * each call.
 */
export function loadConfig(
  path: string | null,
  dflt: DslConfig,
  ctx: LoadContext,
  allowedPalettes?: ReadonlySet<string>,
): LoadedFile & { config: DslConfig } {
  return path === null
    ? { ...NO_FILE, config: mergeWithDefault(NO_FILE.raw, dflt) }
    : loadConfigSource(
        path,
        fs.readFileSync(path, "utf-8"),
        dflt,
        ctx,
        allowedPalettes,
      );
}

// What one file's load needs from beyond the file: the session's project, and
// the plugins of the layers beneath it — every drop (a name under `plugins.`
// that no plugin owns stands in naming the unnamed ones), and which definition
// renders each plugin name.
export interface LoadContext extends PluginContext {
  readonly beneath: {
    readonly dropped: readonly DroppedPlugin[];
    readonly rendering: ReadonlyMap<string, string>;
  };
}

// A load with no session and nothing beneath the bundled default: a
// `data: { checkout }` plugin drops, naming why.
export const NO_PROJECT: LoadContext = {
  projectDir: null,
  checkout: null,
  beneath: { dropped: [], rendering: new Map() },
};

/**
 * loadConfig over text already in hand — the file as it WOULD read, for a
 * writer that must know its text loads before it lands (config-file-store's
 * commit). `path` names the text in diagnostics only.
 */
export function loadConfigSource(
  path: string,
  source: string,
  dflt: DslConfig,
  ctx: LoadContext,
  allowedPalettes?: ReadonlySet<string>,
): LoadedFile & { config: DslConfig } {
  // [LAW:one-source-of-truth] The plugins the file lists are one layer of the
  // same merge: bundled < plugins < this file. Each plugin is validated over
  // the layer it joins, so a definition that would not load drops itself
  // rather than the config that lists it. The names the file may author as a
  // delta are the segments of that very layer.
  // A name a dropped plugin owns is a delta too: its stand-in is the base.
  const parsed = parseDslFile(path, source, allowedPalettes, (refs, names) => {
    const layer = applyPlugins(
      listedPlugins(refs, path),
      ctx,
      { config: dflt, rendering: ctx.beneath.rendering },
      (c, plugin, replaces) =>
        checkPlugin(c, plugin, replaces, path, allowedPalettes),
    );
    const owning = dropsOwning(layer, ctx.beneath.dropped);
    return {
      inherited: new Set([
        ...inheritableSegmentNames(layer.config),
        ...names.filter((n) => owning(n).length > 0),
      ]),
      layer: { plugins: layer, owning },
    };
  });
  const { plugins, owning } = parsed.layer;
  const standing = withDroppedPlacements(
    mergeWithDefault(parsed.raw, plugins.config),
    owning,
  );
  return {
    source,
    raw: parsed.raw,
    warnings: [...parsed.warnings, ...plugins.dropped.map(droppedPluginNotice)],
    plugins: {
      loaded: plugins.loaded,
      dropped: plugins.dropped,
      reached: standing.reached,
      rendering: plugins.rendering,
    },
    config: standing.config,
  };
}

// [LAW:one-source-of-truth] The installed layer is a function of the
// definitions' bytes, the project, the checkout, the base and the palettes,
// so it is memoised on exactly those: a load with nothing installed changed
// pays one stat per definition, not one reference check per plugin.
// Per-plugin validation stays — it is what lets one plugin drop alone.
const installedMemo = new WeakMap<
  DslConfig,
  Map<string, { readonly key: string; readonly layer: PluginLayer }>
>();

function installedLayer(
  definitions: readonly string[],
  ctx: PluginContext,
  dflt: DslConfig,
  allowedPalettes: ReadonlySet<string> | undefined,
): PluginLayer {
  const key = JSON.stringify([
    [...(allowedPalettes ?? [])].sort(),
    definitions.map((d) => [d, statKey(d)]),
  ]);
  const byProject = installedMemo.get(dflt) ?? new Map();
  installedMemo.set(dflt, byProject);
  // Keyed on the checkout, not the working directory: every directory of one
  // checkout reads the same data, and the next load after a `.git` appears
  // above a directory reads the new checkout's. Nothing watches for that
  // `.git`: an ancestor watch per session is the cost, a reload the remedy.
  const slot = JSON.stringify([ctx.projectDir, ctx.checkout?.root ?? null]);
  const hit = byProject.get(slot);
  if (hit?.key === key) return hit.layer;
  const layer = applyPlugins(
    definitions,
    ctx,
    { config: dflt, rendering: new Map() },
    (c, plugin, replaces) =>
      checkPlugin(c, plugin, replaces, "<installed plugins>", allowedPalettes),
  );
  byProject.set(slot, { key, layer });
  return layer;
}

/**
 * Why each of `definitions` would not load, laid over `dflt` exactly as the
 * installed layer lays them: what `cc-candybar plugin install` refuses before
 * it writes anything. `checkout` stands in for a session's, so a
 * `data: { checkout }` path resolves; the data file need not exist.
 */
// [LAW:single-enforcer] The install's verdict is the loader's own, so a
// definition the bar would drop is never installed.
export function definitionProblems(
  definitions: readonly string[],
  dflt: DslConfig,
  checkout: Checkout,
): readonly DroppedPlugin[] {
  return applyPlugins(
    definitions,
    { projectDir: null, checkout },
    { config: dflt, rendering: new Map() },
    (c, plugin, replaces) =>
      checkPlugin(c, plugin, replaces, "<plugin install>", undefined),
  ).dropped;
}

// What a definition's bytes are, as cheaply as a stat says: a rewrite moves
// its mtime, size or inode; one that cannot be seen is its own state.
function statKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "unreadable";
  }
}

/**
 * Load a resolution's chain of config files, lowest precedence first: each
 * layer merges over the config the layers below it built (the bundled
 * default at the bottom), through the very merge the bundled default takes —
 * so a layer may declare only what differs, a segment the user declared
 * included (brandon-plugins-ktag.8th). The top layer's validation is the
 * config that renders, and the only one a good chain pays for; when it fails,
 * the layers below are validated over the layers they join, lowest first, and
 * the first that fails is the error — so a broken file fails naming ITS path
 * and line, never the file above it.
 *
 * `read` is the one content read of each file — a writer proving the text it
 * is about to write passes that text for its own layer. `trace` hears each
 * path as its load starts and each layer's advisories before its validation
 * runs, so a caller still holds both when a layer throws.
 *
 * [LAW:dataflow-not-control-flow] One fold; an empty chain validates the
 * bundled default through the same `loadConfig(null)` every no-file load
 * takes.
 */
export function loadConfigChain(
  paths: readonly string[],
  dflt: DslConfig,
  trace: ChainTrace,
  session: SessionDirs,
  read: (path: string) => string = (p) => fs.readFileSync(p, "utf-8"),
  allowedPalettes?: ReadonlySet<string>,
): LoadedChain {
  // [LAW:single-enforcer] The one place a session's working directory
  // becomes the checkout its plugins' data paths resolve against.
  const ctx: PluginContext = {
    projectDir: session.projectDir,
    checkout: session.cwd === null ? null : checkoutOf(session.cwd),
  };
  // [LAW:one-source-of-truth] Installed plugins are the layer every file
  // merges over: bundled < installed < the chain's files (and what each
  // lists). A file names an installed plugin's segment exactly as it names a
  // bundled one.
  const found = installedPlugins(ctx.projectDir);
  const merged = installedLayer(found.definitions, ctx, dflt, allowedPalettes);
  const plugins = {
    ...merged,
    dropped: [...merged.dropped, ...found.strays],
  };
  trace.warned(
    found.unchecked.map(
      (u) => `Plugin folder could not be listed: ${u.path} — ${u.error}`,
    ),
  );
  const base = plugins.config;
  const layers: Array<LoadedFile & { path: string; config: DslConfig }> = [];
  for (const path of paths) {
    trace.entered(path);
    const below = layers.at(-1)?.plugins;
    const loaded = loadConfigSource(
      path,
      read(path),
      layers.at(-1)?.config ?? base,
      {
        ...ctx,
        beneath: {
          dropped: [
            ...plugins.dropped,
            ...layers.flatMap((l) => l.plugins.dropped),
          ],
          rendering: below?.rendering ?? plugins.rendering,
        },
      },
      allowedPalettes,
    );
    trace.warned(loaded.warnings);
    layers.push({ ...loaded, path });
  }
  // [LAW:no-silent-failure] An installed plugin is on only where a config
  // places it, so its drop is the config's problem only where the config
  // reaches it (a stand-in carries it); one nothing reaches is said in the
  // daemon log alone — nobody asked for it.
  const reached = new Set(layers.flatMap((l) => [...l.plugins.reached]));
  const isReached = (d: DroppedPlugin): boolean => reached.has(d.path);
  const surfaced = plugins.dropped.filter(isReached);
  const unreached = plugins.dropped.filter((d) => !isReached(d));
  trace.warned(surfaced.map(droppedPluginNotice));
  const installed = {
    checkout: ctx.checkout,
    roots: found.roots,
    loaded: plugins.loaded,
    dropped: surfaced,
    unreached,
    reached,
    rendering: layers.at(-1)?.plugins.rendering ?? plugins.rendering,
  };
  const top = layers.at(-1);
  if (top === undefined) {
    return {
      layers,
      base,
      installed,
      config: validateConfig(
        loadConfig(null, base, NO_PROJECT),
        "<default>",
        allowedPalettes,
      ),
    };
  }
  try {
    return {
      layers,
      base,
      installed,
      config: validateConfig(top, top.path, allowedPalettes),
    };
  } catch (e) {
    for (const layer of layers.slice(0, -1)) {
      trace.entered(layer.path);
      validateConfig(layer, layer.path, allowedPalettes);
    }
    trace.entered(top.path);
    throw e;
  }
}

// The session a chain loads for: its project, and the directory it works in.
export interface SessionDirs {
  readonly projectDir: string | null;
  readonly cwd: string | null;
}

export interface ChainTrace {
  // The file a throw is to be blamed on, as the chain learns it.
  readonly entered: (path: string) => void;
  readonly warned: (warnings: readonly string[]) => void;
}

export interface LoadedChain {
  // Lowest first; each layer's `config` is the merge of it and every layer
  // below — the top one's is the merged tree before synthesis.
  readonly layers: ReadonlyArray<
    LoadedFile & { readonly path: string; readonly config: DslConfig }
  >;
  // The installed plugins under every layer: the roots searched (each is
  // watched), the definitions merged, and those dropped (also `warned`).
  // What the first file merges over: the bundled default and the installed
  // plugins — the config an absent file reads as.
  readonly base: DslConfig;
  readonly installed: LoadedFile["plugins"] & {
    // What a `data: { checkout }` path resolved against.
    readonly checkout: Checkout | null;
    readonly roots: readonly string[];
    // Installed drops no layer reaches: logged, never a warning.
    readonly unreached: readonly DroppedPlugin[];
  };
  readonly config: ValidatedConfig;
}

export interface LoadedFile {
  readonly raw: RawDslConfig;
  readonly source: string;
  readonly warnings: readonly string[];
  // The plugin definitions the file listed: those merged, and those dropped
  // with why. A drop is also a `warnings` line (the strip shows it); `check`
  // reads this to fail its verdict.
  readonly plugins: {
    readonly loaded: readonly string[];
    readonly dropped: readonly DroppedPlugin[];
    // The definition path of every drop a stand-in in this file's config
    // stands for.
    readonly reached: ReadonlySet<string>;
    // Each plugin name rendering at this layer, and its definition.
    readonly rendering: ReadonlyMap<string, string>;
  };
}

// [LAW:one-source-of-truth] What validation needs from one read: the merged
// config it promotes, and the file it was merged FROM — the raw fragments the
// author wrote and the text they wrote them in — so a diagnostic names the
// author's own path and line. loadConfig's result is one.
export interface AuthoredConfig {
  readonly config: DslConfig;
  readonly raw: RawDslConfig;
  readonly source: string;
}

/**
 * A plugin over the layer it joins. A plugin edits no `root` or `presets` and
 * declares only under its own namespace, so when the layer held nothing there
 * its declarations are all a check can find new: every reference they make
 * resolves, and no cycle runs through them. A plugin REPLACING one the layer
 * held is checked whole — the layer's own references and placements into that
 * namespace were checked against the plugin it replaces, and only a full check
 * sees them break, so the replacement drops alone rather than failing the file.
 * The full validateConfig of the file listing it still runs over the result.
 */
function checkPlugin(
  config: DslConfig,
  plugin: string,
  replaces: boolean,
  filePath: string,
  allowedPalettes: ReadonlySet<string> | undefined,
): void {
  if (replaces) {
    validateConfig(unauthored(config), filePath, allowedPalettes);
    return;
  }
  const owned = ownedBy(plugin);
  const issues: ConfigIssue[] = [];
  // Neither check below reads a palette name: only the structural pass does.
  const ctx: ValidateCtx = {
    source: "",
    issues,
    allowedPalettes: new Set(),
    groups: [],
  };
  validateDeclarations(ctx, config, templateScopeOf(config), owned);
  validateNoCycles(ctx, config, owned);
  validateNoNesting(ctx, config, owned);
  if (issues.length > 0) throw new ConfigError(filePath, issues);
}

// A config no file was merged into (the bundled default validated on its own,
// a test's hand-built tree) authored every layout it carries, so its own root
// and presets are what the layout checks walk.
export function unauthored(config: DslConfig): AuthoredConfig {
  return {
    config,
    raw: { root: config.root, presets: config.presets },
    source: "",
  };
}

// "No user file exists": a uniform merge against an empty raw, no text, no
// advisories to earn.
const NO_FILE: LoadedFile = {
  raw: {},
  source: "",
  warnings: [],
  plugins: {
    loaded: [],
    dropped: [],
    reached: new Set(),
    rendering: new Map(),
  },
};

/**
 * Promote a merged DslConfig to a ValidatedConfig by running cross-references
 * and cycle detection. Sole producer of ValidatedConfig in the codebase — the
 * phantom brand makes "the renderer never receives an unvalidated config" a
 * compile-time invariant, not a runtime convention.
 *
 * Throws ConfigError aggregating every issue.
 *
 * [LAW:single-enforcer] One cast site, here, exclusive.
 */
export function validateConfig(
  { config, raw, source }: AuthoredConfig,
  filePath = "<config>",
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
): ValidatedConfig {
  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = { source, issues, allowedPalettes, groups: [] };
  validateCrossReferences(ctx, config, raw);
  validateNoCycles(ctx, config);
  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }
  // [LAW:one-source-of-truth] A menu's keys are its PLACEMENT's, so they are
  // minted over the trees that render — which exist only now, merged and
  // cross-referenced — before the settings menu and edit chrome add their own.
  const withMenus = synthesizePlacementMenus(config, issues);
  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }
  // [LAW:one-source-of-truth] Edit-mode's CHROME half (brandon-layout-edit-
  // 2gc.3), synthesized HERE — not in parseDslConfig alongside the toggle —
  // because it needs the fully merged, preset-resolved tree cross-ref/cycles
  // just proved sound. Its own output (segment refs
  // into freshly-synthesized segments, actions into freshly-synthesized
  // actions) is correct by construction and does not re-enter cross-ref/
  // cycle checking, exactly as group/menu synthesis's output doesn't either.
  // [LAW:dataflow-not-control-flow] candybar-settings-ui-aok.1's global settings
  // menu, spliced BEFORE edit chrome so edit chrome walks the final content tree
  // and treats the menu's reserved `candybar.` names as chrome-exempt — the
  // full ordering argument lives in settings-menu.ts's header, beside the pass
  // it governs.
  const withChrome = synthesizeEditChrome(synthesizeSettingsMenu(withMenus));
  // [LAW:single-enforcer] Over the names the store is declared from, every
  // synthesized one included (nesting.ts).
  validateNoNesting(ctx, withChrome);
  if (issues.length > 0) {
    throw new ConfigError(filePath, issues);
  }
  return withChrome as ValidatedConfig;
}

/**
 * Parse a JSON5 DSL config source into a RawDslConfig. JSON5 syntax + per-
 * record structural validation. Cross-references and cycles are NOT checked
 * here — they belong to validateConfig, which runs on the merged shape.
 *
 * Returned shape preserves absence: top-level keys are optional in RawDslConfig.
 *
 * `allowedPalettes` is the set of palette names a `palette:` field may name.
 * It defaults to every name that resolves to a concrete Palette, so production
 * always validates loudly against the real registry. Tests inject a custom set
 * to exercise validation without depending on registry contents.
 *
 * `inheritedSegments` is the set of segment names the source may declare as a
 * DELTA (template omitted): the segments of the default it will be merged
 * over. It defaults to the empty set — a source parsed on its own (the bundled
 * default itself) must carry every template.
 */
export function parseDslConfig(
  filePath: string,
  source: string,
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
  inheritedSegments: ReadonlySet<string> = NO_INHERITED_SEGMENTS,
): RawDslConfig {
  return parseDslFile(filePath, source, allowedPalettes, () => ({
    inherited: inheritedSegments,
    layer: null,
  })).raw;
}

// The same parse, keeping the advisories the source earns between its two
// stages: the editability notice is computed once the text is JSON5 (so a
// syntax error is reported once, by stage 1, never again by the scanner on
// the same defect) and BEFORE structural validation, whose ConfigError
// carries it — a duplicate key beside an unknown top-level key is named on
// the strip beside that error, not after it is fixed.
function parseDslFile<L>(
  filePath: string,
  source: string,
  allowedPalettes: ReadonlySet<string> | undefined,
  // The layer the file merges over, built from the plugins it lists, and the
  // segment names that layer lets the file author as a delta.
  under: (
    plugins: readonly string[],
    segmentNames: readonly string[],
  ) => {
    readonly inherited: ReadonlySet<string>;
    readonly layer: L;
  },
): { raw: RawDslConfig; warnings: readonly string[]; layer: L } {
  // ── Stage 1: JSON5 syntax. A parse error here is single, immediate, and
  // carries line/col from the json5 package — no point continuing to other
  // passes that need a parsed structure to inspect.
  const json = parseJson5OrThrow(filePath, source);
  const notice = editabilityNotice(filePath, source);
  const warnings = notice === null ? [] : [notice];

  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = {
    source,
    issues,
    allowedPalettes: allowedPalettes ?? new Set(listResolvablePaletteNames()),
    groups: [],
  };

  // ── Stage 2: top-level shape + per-record shape. Absence survives as
  // `undefined` in the returned RawDslConfig.
  if (!isPlainObject(json)) {
    throw new ConfigError(
      filePath,
      [
        {
          path: "",
          message: `Config root must be an object, got ${describeType(json)}`,
        },
      ],
      warnings,
    );
  }

  // The plugin list is read ahead of the rest: the layer it builds decides
  // which segment names the file may author as a delta. Its own issues are
  // reported once, by validateTopLevel.
  const { inherited, layer } = under(
    json.plugins === undefined
      ? []
      : (validatePluginRefs({ ...ctx, issues: [] }, json.plugins) ?? []),
    isPlainObject(json.segments) ? Object.keys(json.segments) : [],
  );
  const raw = validateTopLevel(ctx, json, inherited, actionHomeOf(filePath));

  if (issues.length > 0) {
    throw new ConfigError(filePath, issues, warnings);
  }

  return { raw, warnings, layer };
}

// ─── Internals ───────────────────────────────────────────────────────────────

const NO_INHERITED_SEGMENTS: ReadonlySet<string> = new Set();

interface Json5Error extends Error {
  lineNumber?: number;
  columnNumber?: number;
}

function parseJson5OrThrow(filePath: string, source: string): unknown {
  try {
    return JSON5.parse(source);
  } catch (err) {
    const e = err as Json5Error;
    throw new ConfigError(filePath, [
      {
        path: "",
        message: `JSON5 syntax error: ${e.message}`,
        line: e.lineNumber,
        col: e.columnNumber,
      },
    ]);
  }
}

// [LAW:types-are-the-program] Returns RawDslConfig — absence of a top-level
// key survives the parse as `undefined`, distinct from explicit empty. The
// merge step downstream decides what "absent" means policy-wise (currently:
// inherit from default).
function validateTopLevel(
  ctx: ValidateCtx,
  raw: Record<string, unknown>,
  inheritedSegments: ReadonlySet<string>,
  // Where the file's actions are declared: a `run` runs in its directory.
  home: ActionHome,
): RawDslConfig {
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      ctx.issues.push({
        path: key,
        message: `Unknown top-level key "${key}". Expected one of: ${[...TOP_LEVEL_KEYS].join(", ")}`,
        line: findKeyLine(ctx.source, [key]),
      });
    }
  }

  const out: Mutable<RawDslConfig> = {};
  if (raw.globals !== undefined)
    out.globals = validateGlobals(ctx, "globals", raw.globals);
  if (raw.variables !== undefined)
    out.variables = validateVariables(ctx, "variables", raw.variables);
  if (raw.segments !== undefined)
    out.segments = validateSegments(ctx, raw.segments, inheritedSegments);
  // [LAW:no-silent-failure] `layout:` was removed in 2de.19. Reject loudly with
  // a migration hint so the author knows exactly how to rewrite their config.
  if (raw.layout !== undefined) {
    ctx.issues.push({
      path: "layout",
      message:
        `"layout" is no longer supported — use "root" with the A-grammar instead.\n` +
        `  Replace:  layout: [["seg1", "seg2"], ["seg3"]]\n` +
        `  With:     root: { v: [{ h: ["seg1", "seg2"] }, "seg3"] }\n` +
        `  Single-row example:  root: { h: ["seg1", "seg2"] }`,
      line: findKeyLine(ctx.source, ["layout"]),
    });
  }
  if (raw.root !== undefined)
    out.root = validateRootFragment(ctx, "root", raw.root);
  if (raw.actions !== undefined)
    out.actions = validateActions(ctx, raw.actions, home);
  // [LAW:no-silent-failure] `looks:` was renamed `styles:` (brandon-menu-ia-
  // q30.xuz). Refused by name, like `layout:` above, so the author is told the
  // new key rather than handed a bare unknown-key message.
  if (raw.looks !== undefined) {
    ctx.issues.push({
      path: "looks",
      message: `"looks" was renamed "styles" — move the block under styles: { … } (and globals.look to globals.style)`,
      line: findKeyLine(ctx.source, ["looks"]),
    });
  }
  if (raw.styles !== undefined) out.styles = validateStyles(ctx, raw.styles);
  if (raw.themeDefaults !== undefined)
    out.themeDefaults = validateThemeDefaults(ctx, raw.themeDefaults);
  // [LAW:one-source-of-truth] Parsed BEFORE the synthesis passes below, because
  // a preset's `root` runs through the same validateRootFragment and therefore collects
  // its group sugar into the same `ctx.groups` the top-level root does — the
  // synthesized artifacts must see every group the config declares, wherever it
  // was staged from.
  if (raw.presets !== undefined)
    out.presets = validatePresets(ctx, raw.presets);
  // [LAW:one-type-per-behavior] Edit mode's staged display globals — the same
  // fragment shape a preset carries, one rung later in the precedence chain, so
  // it runs through the same field table (validateEditGlobals) rather than a
  // parallel schema listing which globals edit mode may set.
  if (raw.editGlobals !== undefined)
    out.editGlobals = validateEditGlobals(ctx, "editGlobals", raw.editGlobals);
  if (raw.helpers !== undefined)
    out.helpers = validateHelpers(ctx, raw.helpers);
  if (raw.plugins !== undefined)
    out.plugins = validatePluginRefs(ctx, raw.plugins);
  // [LAW:one-source-of-truth] Group sugar synthesis runs AFTER every section
  // parsed: each group collected during the root walk emits its state var +
  // cycle action + toggle segment into the raw sections (so they merge over the
  // default and cross-ref like any user declaration), and user names under the
  // reserved namespace are rejected against the fully-parsed sections.
  synthesizeGroupDecls(ctx, out);
  // [LAW:one-source-of-truth] The `menus.` reservation and every `{{ menu }}`
  // call's shape, checked where the author wrote them; the keys each placement
  // derives are minted after merge (validateConfig).
  checkMenuDecls(ctx, out);
  // [LAW:one-source-of-truth] Edit-mode's TOGGLE half (brandon-layout-edit-
  // 2gc.3) — unconditional, like the reservation above, so `edit.mode`/
  // `edit.toggle` exist in EVERY parsed file and a hand-authored trigger
  // segment cross-ref-checks normally. The CHROME half (the per-position +/-
  // affordances) runs later, in validateConfig, once the merged/preset-
  // resolved tree exists to derive it from.
  synthesizeEditModeToggle(ctx, out);
  // [LAW:one-source-of-truth] The global settings menu reserves its namespace
  // here and synthesizes NOTHING here: the tree it must be present in only
  // exists after merge (a user `root` replaces the default's), so the artifacts
  // are minted in validateConfig. The reservation is unconditional all the same,
  // mirroring every other namespace above — "you never author candybar.*" is a
  // stable contract, not a rule that switches on when the pass happens to fire.
  reservedNamespaceCollisions(
    ctx,
    out,
    SETTINGS_NS,
    "the global settings menu",
  );
  return out;
}

// [LAW:no-silent-failure] `layout` and `looks` are listed so a config that
// writes one gets its migration error, not an "unknown key" message.
const TOP_LEVEL_KEYS = new Set([
  "globals",
  "variables",
  "segments",
  "layout",
  "looks",
  "root",
  "actions",
  "styles",
  "themeDefaults",
  "presets",
  "editGlobals",
  "helpers",
  "plugins",
]);

// `plugins:` is a list of definition paths. Loading them is applyPlugins'
// job, after the parse: a definition that fails drops itself, never the file.
function validatePluginRefs(
  ctx: ValidateCtx,
  raw: unknown,
): readonly string[] | undefined {
  if (
    Array.isArray(raw) &&
    raw.every((p) => typeof p === "string" && p !== "")
  ) {
    return raw as string[];
  }
  ctx.issues.push({
    path: "plugins",
    message: `"plugins" must be a list of plugin definition paths, got ${describeType(raw)}`,
    line: findKeyLine(ctx.source, ["plugins"]),
  });
  return undefined;
}
