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
//   validateRenderable (DslConfig → ValidatedConfig)
//     Cross-references + cycle detection on the merged shape. Sole producer
//     of ValidatedConfig. Throws ConfigError on cross-ref / cycle problems.
//
// loadConfig (path|null → DslConfig) wires parse+merge for the daemon's
// production path. validateRenderable finishes the chain.
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
  type InsertCell,
  type RawDslConfig,
  type ValidatedConfig,
} from "./dsl-types.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
import {
  ConfigError,
  editabilityNotice,
  findKeyLine,
  keyLocator,
  DroppedPlacements,
  DroppedFileError,
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
import {
  synthesizeGroupDecls,
  validateInsert,
  validateRootFragment,
} from "./loader/layout.js";
import {
  checkMenuDecls,
  synthesizePlacementMenus,
} from "./loader/menu-synth.js";
import { synthesizeEditModeToggle } from "./loader/edit-mode.js";
import { synthesizeEditChrome } from "./edit-chrome.js";
import { synthesizeSettingsMenu } from "./settings-menu.js";
import {
  pluginScopeCollisions,
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
import { insertNotice, placeInserts, type AuthoredTrees } from "./presets.js";
import { validateHelpers } from "./loader/helpers.js";
import {
  authoredPlacement,
  unplacedMessage,
  validateCrossReferences,
  validateDeclarations,
} from "./loader/cross-ref.js";
import { declarationsAt, templateScopeOf } from "./loader/refs.js";
import { validateNoCycles } from "./loader/cycles.js";
import { validateNoNesting } from "./loader/nesting.js";
import {
  applyPlugins,
  listedPlugins,
  droppedPluginNotice,
  type PluginContext,
  withDroppedPlacements,
  dropsOwning,
  type DroppedPlugin,
  type PluginDefinition,
  type PluginLayer,
} from "./loader/plugins.js";
import {
  ownedBy,
  type NamedDefinition,
  type PluginScope,
  type SegmentPresence,
} from "./loader/plugin-scope.js";
import { installedPlugins } from "./loader/plugin-folders.js";
import {
  presenceOf,
  reportable,
  absentPlacement,
  withoutUnplaced,
} from "./loader/unplaced.js";
import type { ApprovedRepo } from "./loader/repo-gate.js";
import type { ConfigLayer } from "./loader/discovery.js";
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
export type { ConfigIssue, DroppedFileError } from "./loader/diagnostics.js";
export {
  dslConfigCandidatePaths,
  resolveDslConfig,
  configResolutionNotice,
  durableConfig,
  detectConfigCollisions,
  homeLayer,
} from "./loader/discovery.js";
export type {
  ConfigHome,
  ConfigLayer,
  ConfigResolution,
} from "./loader/discovery.js";
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
 * alongside the config, so the whole result is validateRenderable's input —
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
 * failures. Cross-references and cycles are validateRenderable()'s job.
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
// the plugins of the layers beneath it — every drop (a name under a plugin scope
// that no plugin owns stands in naming the unnamed ones), and which definition
// renders each plugin name.
export interface LoadContext extends PluginContext {
  // [LAW:one-source-of-truth] The scope of the plugins the file lists, as
  // discovery found the file: `repo` for a repository's own config, `plugins`
  // for every other.
  readonly scope: PluginScope;
  readonly beneath: {
    readonly dropped: readonly DroppedPlugin[];
    readonly rendering: ReadonlyMap<string, NamedDefinition>;
  };
}

// A load with no session and nothing beneath the bundled default: a
// `data: { checkout }` plugin drops, naming why.
export const NO_PROJECT: LoadContext = {
  scope: "plugins",
  repo: null,
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
      // [LAW:one-source-of-truth] The layer's scope, decided where the
      // layer was discovered, rides on every definition it lists.
      listedPlugins(refs, path, ctx.scope),
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
    (parsed.raw.insert ?? []).map((cell) => cell.seg),
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
  definitions: readonly PluginDefinition[],
  ctx: PluginContext,
  dflt: DslConfig,
  allowedPalettes: ReadonlySet<string> | undefined,
): PluginLayer {
  const key = JSON.stringify([
    [...(allowedPalettes ?? [])].sort(),
    definitions.map((d) => [d.path, d.scope, statKey(d.path)]),
  ]);
  const byProject = installedMemo.get(dflt) ?? new Map();
  installedMemo.set(dflt, byProject);
  // Keyed on the checkout, not the working directory: every directory of one
  // checkout reads the same data, and the next load after a `.git` appears
  // above a directory reads the new checkout's. Nothing watches for that
  // `.git`: an ancestor watch per session is the cost, a reload the remedy.
  const slot = JSON.stringify([ctx.repo, ctx.checkout?.root ?? null]);
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
  definitions: readonly PluginDefinition[],
  dflt: DslConfig,
  checkout: Checkout,
): readonly DroppedPlugin[] {
  return applyPlugins(
    definitions,
    { repo: null, checkout },
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
 * layer's advisories before its validation runs, so a caller still holds them
 * when a layer throws; the throw itself names the file it is blamed on.
 *
 * [LAW:dataflow-not-control-flow] One fold; an empty chain validates the
 * bundled default through the same `loadConfig(null)` every no-file load
 * takes.
 */
export function loadConfigChain(
  chain: readonly ConfigLayer[],
  dflt: DslConfig,
  trace: ChainTrace,
  session: SessionDirs,
  read: (path: string) => string = (p) => fs.readFileSync(p, "utf-8"),
  allowedPalettes?: ReadonlySet<string>,
): LoadedChain {
  // [LAW:single-enforcer] The one place a session's working directory
  // becomes the checkout its plugins' data paths resolve against.
  const ctx: PluginContext = {
    repo: session.repo,
    checkout: session.cwd === null ? null : checkoutOf(session.cwd),
  };
  // [LAW:one-source-of-truth] Installed plugins are the layer every file
  // merges over: bundled < installed < the chain's files (and what each
  // lists). A file names an installed plugin's segment exactly as it names a
  // bundled one.
  const found = installedPlugins(ctx.repo);
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
  for (const { path, scope } of chain) {
    const below = layers.at(-1)?.plugins;
    const loaded = loadConfigSource(
      path,
      read(path),
      layers.at(-1)?.config ?? base,
      {
        ...ctx,
        // [LAW:one-source-of-truth] A layer's scope is where discovery found
        // it, carried here as data — never read off the file's name.
        scope,
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
  // [LAW:one-source-of-truth] The namespaces the chain renders, a repository's
  // own included: what a placement is judged against, so a placement under
  // a plugin this session lacks draws nothing and one under a plugin it has
  // is checked against what that plugin declares.
  const rendering = layers.at(-1)?.plugins.rendering ?? plugins.rendering;
  const installed = {
    checkout: ctx.checkout,
    roots: found.roots,
    loaded: plugins.loaded,
    dropped: surfaced,
    unreached,
    reached,
    rendering,
  };
  const top = layers.at(-1);
  // The advisories validation earns over the whole chain (an insert cell no
  // tree could place) join the layers' own once it passes; a refusal carries
  // them on its ConfigError.
  const renderable = ({
    warnings,
    ...rest
  }: Renderable): Omit<Renderable, "warnings"> => {
    trace.warned(warnings);
    return rest;
  };
  if (top === undefined) {
    return {
      layers,
      base,
      installed,
      ...renderable(
        validateRenderable(
          loadConfig(null, base, NO_PROJECT),
          rendering,
          "<default>",
          allowedPalettes,
        ),
      ),
    };
  }
  try {
    return {
      layers,
      base,
      installed,
      ...renderable(
        validateRenderable(
          top,
          rendering,
          top.path,
          allowedPalettes,
          layers.slice(0, -1).reverse(),
        ),
      ),
    };
  } catch (e) {
    // [LAW:single-enforcer] Blame goes to the lowest layer that fails on its
    // own, judged by the same tolerant validation the merged chain failed
    // under: a placement a lower layer leaves undeclared only drops its cell
    // there too, so it cannot stand in for the error that actually refused
    // the chain. Each is judged over the layers it joins, as it loads.
    for (const [i, layer] of layers.slice(0, -1).entries())
      validateRenderable(
        layer,
        layer.plugins.rendering,
        layer.path,
        allowedPalettes,
        layers.slice(0, i).reverse(),
      );
    throw e;
  }
}

// The session a chain loads for: its approved project, and the directory it
// works in.
export interface SessionDirs {
  readonly repo: ApprovedRepo | null;
  readonly cwd: string | null;
}

export interface ChainTrace {
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
  // The merged config the bar draws, and the placements it dropped
  // (validateRenderable).
  readonly config: ValidatedConfig;
  readonly dropped: readonly DroppedFileError[];
  // The merged config with every layer's insert cells placed
  // (validateRenderable's `placed`).
  readonly placed: DslConfig;
}

export interface LoadedFile {
  readonly raw: RawDslConfig;
  readonly source: string;
  readonly warnings: readonly string[];
  // The plugin definitions the file listed: those merged, and those dropped
  // with why. A drop is also a `warnings` line (the bar shows it); `check`
  // reads this to fail its verdict.
  readonly plugins: {
    readonly loaded: readonly PluginDefinition[];
    readonly dropped: readonly DroppedPlugin[];
    // The definition path of every drop a stand-in in this file's config
    // stands for.
    readonly reached: ReadonlySet<string>;
    // Each plugin namespace rendering at this layer, and its definition.
    readonly rendering: ReadonlyMap<string, NamedDefinition>;
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
 * The file listing it is validated over the result, so the check is the same
 * tolerant one the bar loads by: a placement of a segment nothing declares
 * drops its cell and is reported by the file's own validation, never blamed
 * on the plugin.
 */
function checkPlugin(
  config: DslConfig,
  ns: string,
  replaces: boolean,
  filePath: string,
  allowedPalettes: ReadonlySet<string> | undefined,
): void {
  if (replaces) {
    // [LAW:single-enforcer] The bar's own judgment of what fails a config.
    validateRenderable(
      unauthored(config),
      new Map(),
      filePath,
      allowedPalettes,
    );
    return;
  }
  const owned = ownedBy(ns);
  const issues: ConfigIssue[] = [];
  // Neither check below reads a palette name: only the structural pass does.
  const ctx: ValidateCtx = {
    source: "",
    issues,
    allowedPalettes: new Set(),
    groups: [],
    unplaced: [],
    inherited: [],
  };
  validateDeclarations(ctx, config, templateScopeOf(config), owned);
  validateNoCycles(ctx, config, owned);
  validateNoNesting(ctx, config, { checked: owned, authored: owned });
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

// A config the bar can draw, and the placements it dropped to draw it.
export interface Renderable {
  readonly config: ValidatedConfig;
  // [LAW:no-silent-failure] Each placement of an undeclared segment, as one
  // error per file that wrote one; empty for none. `check` refuses them.
  readonly dropped: readonly DroppedFileError[];
  // [LAW:one-source-of-truth] The merged config with every layer's insert
  // cells placed, before the load drops or synthesizes anything: the trees
  // the files authored as they render, for a reader that asks what the
  // authors placed (an insert entry places its segment as surely as a row).
  readonly placed: DslConfig;
  // The advisories the chain earns as a whole: each insert cell a tree that
  // renders could not place.
  readonly warnings: readonly string[];
}

// A file beneath the one validated, by its path.
export type AuthoredLayer = AuthoredConfig & { readonly path: string };

/**
 * The same validation, except that a placement of an undeclared segment drops
 * only its own cell (loader/unplaced.ts) and is returned as `dropped`, rather
 * than refusing the whole config: the bar draws everything else the author
 * placed. Any other issue, at any stage, still refuses it, reported together
 * with the drops.
 * Sole producer of ValidatedConfig in the codebase — the phantom brand makes
 * "the renderer never receives an unvalidated config" a compile-time
 * invariant, not a runtime convention.
 *
 * [LAW:single-enforcer] One cast site, here, exclusive.
 */
export function validateRenderable(
  authoredConfig: AuthoredConfig,
  // Each plugin namespace rendering in the session the config renders for,
  // and the definition that won it: a placement under a namespace missing
  // here draws nothing and is no error (plugin-scope.ts).
  rendering: ReadonlyMap<string, NamedDefinition>,
  filePath = "<config>",
  allowedPalettes: ReadonlySet<string> = new Set(listResolvablePaletteNames()),
  // The files it merges over, nearest first.
  beneath: readonly AuthoredLayer[] = [],
): Renderable {
  const presence = presenceOf(authoredConfig.config.segments, rendering);
  const written = layerInserts(
    { ...authoredConfig, path: filePath },
    beneath,
    presence,
  );
  // [LAW:single-enforcer] Every layer's `insert` cells are placed here, once,
  // before any check or synthesis walks a tree — so each walk sees the trees
  // that render and none places a cell again.
  const judge = (
    cells: readonly InsertCell[],
    refused: readonly string[],
  ): Renderable => {
    const inserted = placeInserts(
      authoredConfig.config,
      cells,
      written.authored,
    );
    return judgeRenderable(
      authoredConfig,
      filePath,
      allowedPalettes,
      beneath,
      inserted.config,
      presence,
      written.dropped,
      [...inserted.notices, ...refused],
    );
  };
  try {
    return judge(written.cells, []);
  } catch (e) {
    if (!(e instanceof ConfigError) || written.cells.length === 0) throw e;
    // [LAW:no-silent-failure] A layer's guess about the bar beneath it never
    // refuses that bar. The chain is judged again without any cell, so an
    // error that stands there is the files' own and refuses them as written;
    // otherwise the cells are taken in chain order, each judged over those
    // already taken, and a cell that brings an issue is left out and reported
    // against the entry that wrote it, whatever key the issue names.
    const bare = judge([], []);
    const own = new Set(
      bare.dropped.flatMap((d) => d.issues.map((i) => i.message)),
    );
    const { taken, refused } = written.cells.reduce<{
      taken: readonly InsertCell[];
      refused: readonly string[];
    }>(
      (acc, cell) => {
        try {
          judge([...acc.taken, cell], []);
          return { ...acc, taken: [...acc.taken, cell] };
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          const why = err.issues
            .filter((issue) => !own.has(issue.message))
            .map((issue) => issue.message)
            .join("; ");
          return {
            ...acc,
            refused: [
              ...acc.refused,
              insertNotice(
                cell,
                `${cell.relation} "${cell.anchor}", but the bar refuses it there: ${why}`,
              ),
            ],
          };
        }
      },
      { taken: [], refused: [] },
    );
    return judge(taken, refused);
  }
}

// validateRenderable over one placement of the insert cells: `merged` is the
// config with them placed, `filed` the cells already dropped, and `notices`
// the advisories the placement earned.
function judgeRenderable(
  { raw, source }: AuthoredConfig,
  filePath: string,
  allowedPalettes: ReadonlySet<string>,
  beneath: readonly AuthoredLayer[],
  merged: DslConfig,
  presence: (name: string) => SegmentPresence,
  filed: readonly FiledIssue[],
  notices: readonly string[],
): Renderable {
  const issues: ConfigIssue[] = [];
  const ctx: ValidateCtx = {
    source,
    issues,
    allowedPalettes,
    groups: [],
    unplaced: [],
    inherited: [],
  };
  // [LAW:single-enforcer] The one refusal every stage throws through, so the
  // drops ride with whichever issue refuses the config.
  const refuseIfIssues = (): void => {
    if (issues.length > 0) {
      throw new ConfigError(
        filePath,
        [...issues, ...ctx.unplaced, ...ctx.inherited],
        notices,
      );
    }
  };
  validateCrossReferences(ctx, merged, raw, presence);
  validateNoCycles(ctx, merged);
  refuseIfIssues();
  const dropped = droppedByFile(
    filePath,
    merged.segments,
    ctx,
    presence,
    beneath,
    filed,
  );
  // [LAW:dataflow-not-control-flow] Every undeclared placement leaves the
  // tree, reported or not: a cell whose plugin is absent here is no error, so
  // nothing was dropped, yet it must not reach the renderer. A config with
  // nothing to remove comes back as itself, so its trees keep their identity.
  const config = withoutUnplaced(merged);
  // [LAW:one-source-of-truth] A menu's keys are its PLACEMENT's, so they are
  // minted over the trees that render — which exist only now, merged and
  // cross-referenced — before the settings menu and edit chrome add their own.
  const withMenus = synthesizePlacementMenus(config, issues);
  refuseIfIssues();
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
  const authored = new Set(
    [
      ...declarationsAt({
        variables: raw.variables ?? {},
        segments: raw.segments ?? {},
      }),
    ].map(([name]) => name),
  );
  validateNoNesting(ctx, withChrome, {
    checked: () => true,
    authored: (name) => authored.has(name),
  });
  refuseIfIssues();
  return {
    config: withChrome as ValidatedConfig,
    dropped,
    placed: merged,
    warnings: notices,
  };
}

// An issue, and the file it is reported against.
interface FiledIssue {
  readonly file: string;
  readonly issue: ConfigIssue;
}

// Every layer's `insert` cells, lowest layer first so a later cell may anchor
// on an earlier one, and the trees the files write. A cell naming no declared
// segment draws nothing, like any placement of one: it is left out and
// reported against the file and entry that wrote it, whichever layer that is
// — unless its plugin is absent here, which is no error.
function layerInserts(
  top: AuthoredLayer,
  // The files it merges over, nearest first.
  beneath: readonly AuthoredLayer[],
  presence: (name: string) => SegmentPresence,
): {
  readonly cells: readonly InsertCell[];
  readonly authored: AuthoredTrees;
  readonly dropped: readonly FiledIssue[];
} {
  const layers = [...beneath].reverse().concat(top);
  // [LAW:dataflow-not-control-flow] A cell anchored on a placement whose
  // plugin is absent is absent with it, through any chain of cells: its
  // anchor draws nothing here, so neither does it, and neither is an error
  // (unplaced.ts reportable).
  const standsOnAbsent = absentPlacement(
    top.config,
    layers.flatMap((layer) => layer.raw.insert ?? []),
    presence,
  );
  const anchored = (cell: InsertCell): boolean => !standsOnAbsent(cell.anchor);
  // [LAW:single-enforcer] A cell naming the bar's chrome (the settings menu's
  // anchor among it) never gets here: the parse refuses it (loader/layout.ts).
  const declared = (cell: InsertCell): boolean =>
    presence(cell.seg).kind === "declared";
  const broken = (cell: InsertCell): boolean => reportable(presence(cell.seg));
  const own = (layer: AuthoredLayer): readonly InsertCell[] =>
    (layer.raw.insert ?? []).filter(anchored);
  return {
    cells: layers.flatMap((layer) => own(layer).filter(declared)),
    authored: {
      root: layers.some((layer) => layer.raw.root !== undefined),
      presets: new Set(
        layers.flatMap((layer) => Object.keys(layer.raw.presets ?? {})),
      ),
    },
    // One locator per layer, so its source is parsed at most once.
    dropped: layers.flatMap((layer) => {
      const lineOf = keyLocator(layer.source);
      // A cell's own segment is judged whatever it stands on: a typo under a
      // present plugin is broken in every session, not only where its anchor
      // draws.
      return (layer.raw.insert ?? []).filter(broken).map((cell) => ({
        file: layer.path,
        issue: {
          path: cell.by.entry,
          message: unplacedMessage(
            cell.by.entry,
            cell.seg,
            top.config.segments,
            presence(cell.seg),
          ),
          line: lineOf(cell.by.entry.split(".")),
        },
      }));
    }),
  };
}

// [LAW:single-enforcer] What `check` and the demo refuse that the bar draws
// past: every dropped placement, each file's error in turn.
export function refuseDrops(dropped: readonly DroppedFileError[]): void {
  if (dropped.length > 0) throw new DroppedPlacements(dropped);
}

// [LAW:no-silent-failure] Each dropped placement reported against the file
// that wrote it: this file's own, and each one inherited against the nearest
// file beneath whose own layout places it, at its path and line there. One no
// file wrote (an installed plugin's layout) stays under the tree that renders
// it.
function droppedByFile(
  filePath: string,
  // The segments the merged config declares.
  segments: DslConfig["segments"],
  ctx: ValidateCtx,
  presence: (name: string) => SegmentPresence,
  beneath: readonly AuthoredLayer[],
  // Insert cells already filed against the file that wrote them.
  filed: readonly FiledIssue[],
): DroppedFileError[] {
  const byFile = new Map<string, ConfigIssue[]>();
  const add = (file: string, issue: ConfigIssue): void => {
    byFile.set(file, [...(byFile.get(file) ?? []), issue]);
  };
  for (const { file, issue } of filed) add(file, issue);
  for (const issue of ctx.unplaced) add(filePath, issue);
  for (const { name, ...issue } of ctx.inherited) {
    const author = beneath.flatMap((layer) => {
      const at = authoredPlacement(layer.raw, name);
      return at === undefined ? [] : [{ layer, ...at }];
    })[0];
    if (author === undefined) add(filePath, issue);
    else
      add(author.layer.path, {
        path: author.path,
        message: unplacedMessage(
          author.layoutKey,
          name,
          segments,
          presence(name),
        ),
        line: findKeyLine(author.layer.source, author.path.split(".")),
      });
  }
  return [...byFile].map(
    ([file, issues]) => new DroppedFileError(file, issues),
  );
}

/**
 * Parse a JSON5 DSL config source into a RawDslConfig. JSON5 syntax + per-
 * record structural validation. Cross-references and cycles are NOT checked
 * here — they belong to validateRenderable, which runs on the merged shape.
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
// carries it — a duplicate key beside an unknown top-level key is named
// beside that error, not after it is fixed.
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
    unplaced: [],
    inherited: [],
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
  const raw = validateTopLevel(
    ctx,
    json,
    inherited,
    actionHomeOf(filePath),
    filePath,
  );

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
  // The file being parsed: stamped on each `insert` cell it writes.
  file: string,
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
  if (raw.insert !== undefined)
    out.insert = validateInsert(ctx, raw.insert, file);
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
  // derives are minted after merge (validateRenderable).
  checkMenuDecls(ctx, out);
  // [LAW:one-source-of-truth] Edit-mode's TOGGLE half (brandon-layout-edit-
  // 2gc.3) — unconditional, like the reservation above, so `edit.mode`/
  // `edit.toggle` exist in EVERY parsed file and a hand-authored trigger
  // segment cross-ref-checks normally. The CHROME half (the per-position +/-
  // affordances) runs later, in validateRenderable, once the merged/preset-
  // resolved tree exists to derive it from.
  synthesizeEditModeToggle(ctx, out);
  // [LAW:one-source-of-truth] The global settings menu reserves its namespace
  // here and synthesizes NOTHING here: the tree it must be present in only
  // exists after merge (a user `root` replaces the default's), so the artifacts
  // are minted in validateRenderable. The reservation is unconditional all the same,
  // mirroring every other namespace above — "you never author candybar.*" is a
  // stable contract, not a rule that switches on when the pass happens to fire.
  reservedNamespaceCollisions(
    ctx,
    out,
    SETTINGS_NS,
    "the global settings menu",
  );
  pluginScopeCollisions(ctx, out, inheritedSegments);
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
  "insert",
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
