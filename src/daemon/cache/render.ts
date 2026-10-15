import path from "node:path";
import { nearestWatchTarget } from "../../utils/watch-target.js";
import type { RichText } from "@promptctl/rich-js";
import { neededPrefixesByPreset } from "../render-payload.js";
import { fileHeldSettings } from "../setting-drafts.js";
import {
  loadConfigChain,
  type LoadedChain,
  resolveDslConfig,
  configResolutionNotice,
  dslConfigCandidatePaths,
  detectConfigCollisions,
  ConfigError,
} from "../../config/dsl-loader.js";
import type {
  DslConfig,
  RawDslConfig,
  ValidatedConfig,
} from "../../config/dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "../../config/default-dsl-config.js";
import { registerDslConfig, type CompiledConfig } from "../../dsl/render.js";
import { stateGate } from "../verbs/state-validators.js";
import { configGate } from "../verbs/config-validators.js";
import { presetNames, presetRoot } from "../../config/presets.js";
import { unusedDeclarations, type UnusedDecl } from "../../config/unused.js";
import { VariableStore } from "../../var-system/store.js";
import { SourceRegistry } from "../../var-system/sources.js";
import type { GitDataProvider } from "./git.js";
import type { SessionStateRW } from "../session-state.js";
import type {
  WatcherRegistry,
  WatcherHandle,
  WatchTargets,
} from "./watchers.js";
import { dlog } from "../log.js";
import { pluginDataVar, pluginNameOf } from "../../config/loader/plugins.js";

// [LAW:one-source-of-truth] Each cache entry owns the live DSL state for a
// (projectDir, cwd) tuple: the parsed config, the variable store +
// registry it was registered against, the compiled segment closures, and
// the resolved base palette. registerDslConfig + renderDsl are the
// single render path — the cache only holds state across calls.
//
// Capacity sized for "many concurrent sessions in many repos". Each entry
// holds a SourceRegistry (timers, watchers) so the hard cap doubles as a
// resource ceiling: at 256 active entries, fs watchers and TTL timers are
// bounded by N × declarations-per-config.
const MAX_ENTRIES = 256;

// [LAW:single-enforcer] These are the cache-and-registry deps — git data
// (for declareGit subscriptions), session state (for declareState atoms),
// and the watcher registry (for hot-reload's config file watcher). Daemon-
// owned data providers like the SessionUsageStore/git provider/etc. live in
// `payloadDeps` (server.ts) and feed `buildRenderPayload`; they are not
// part of cache identity or lifecycle.
export interface RenderDeps {
  gitService: GitDataProvider;
  sessionState: SessionStateRW;
  watchers: WatcherRegistry;
}

// What building one config's state needs. The git provider is optional
// because a SourceRegistry stands up its own when handed none — what a
// one-shot load outside the daemon (`cc-candybar doctor`) wants.
export interface StateDeps {
  readonly gitService?: GitDataProvider;
  readonly sessionState: SessionStateRW;
}

// [LAW:no-ambient-temporal-coupling] The cache's outward lifecycle signal. A
// reload is the one event the cache alone knows the completion of — it runs
// from a debounced fs watcher, on the cache's own schedule — so anything that
// must run AFTER a reload (an operator log of its outcome, a test asserting
// on the state it wrote) needs the cache to say so, or it is left betting on
// a clock. The same named-bag idiom as renderDsl's RenderObservers
// [LAW:locality-or-seam]: a caller states what it passes by name, and a new
// observer is one field here, not a constructor signature every caller
// re-counts.
export interface RenderCacheObservers {
  // Fires once per completed reload of an entry — the initial population in
  // getOrCreate and every watcher-driven reload alike, success (a fresh
  // `state`) and failure (`lastError` set, prior state preserved) alike —
  // after the entry's fields and watcher are settled. The entry is handed
  // over as ReloadedEntry so the observer reads the outcome from the one
  // place it lives and the type, not this comment, keeps it from writing
  // there. Trusted non-throwing (the same contract as onSegmentError): an
  // observer that throws is a caller bug surfaced loudly, never absorbed here.
  readonly onReload?: (entry: ReloadedEntry) => void;
}

// [LAW:types-are-the-program] The observer's view of an entry: an ALLOW-LIST
// of the load's outcome. Nothing that owns a resource — the watcher handle,
// the SourceRegistry, the validator disposers, the render-cell sink — crosses
// this seam, so a handle added to either type later is closed by
// construction, not by remembering to omit it (`Readonly` alone would not:
// it cannot stop a method call such as `dispose()`).
export type ReloadedEntry = Readonly<
  Pick<
    CacheEntry,
    | "projectDir"
    | "cwd"
    | "configFile"
    | "configLayers"
    | "failedFile"
    | "lastError"
    | "lastWarning"
  >
> & { readonly state: Readonly<Pick<DslRenderState, "config">> };

// [LAW:types-are-the-program] The DSL render state for an entry is one
// bundle, never null: an entry can ALWAYS render. It is seeded with the
// bundled default's state at creation (candybar-settings-ui-0gz) and
// replaced by each config that loads; a config that fails to load leaves it
// as it was. So the bar under a load error is the best config the entry has
// — the last one that loaded, or the bundled default before any has — and
// the settings menu (the door back to the file) exists from the first
// render, through the same synthesis every config gets.
//
// `neededInputPaths` is the layout-reachable closure of input paths for a
// preset, computed once per preset. The daemon's payload builder reads the
// active preset's to gate provider invocation.
//
// `lastRenderCellsBySegment` is the per-segment StripCell sink that
// renderDsl writes on each render — pre-layout cells, NOT serialized
// ANSI. Storing cells (not strings) keeps the hot path free of the
// per-segment renderStripCells call: the debug projection serializes on
// demand only when a `debug segments` request actually arrives. The map
// identity is stable for the entry's lifetime; renderDsl clears +
// repopulates it in place. A segment hidden by `when` is absent from the
// map — its presence in the keys is the "this segment rendered" signal.
export interface DslRenderState {
  readonly config: ValidatedConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly compiled: CompiledConfig;
  readonly neededInputPaths: (preset: string) => ReadonlySet<string>;
  readonly lastRenderCellsBySegment: Map<string, readonly RichText[]>;
  // [LAW:one-source-of-truth] The preset names whose layout tree the config
  // FILE authors at the path presetRoot() reports for them (candybar-config-
  // dqe): `root` for a preset staging the config's own root, `presets.<n>.
  // root` otherwise. This is what `.preset.customized` means now — the file
  // declares that tree, whether a hand wrote it or a `+`/`-` click did; the
  // two are indistinguishable by design. Computed from the SAME raw parse
  // that produced `config`, on the SAME reload, so the two never drift.
  readonly authoredRoots: ReadonlySet<string>;
  // The config keys the FILE holds a value for at a layer a reset clears
  // (fileHeldSettings) — from the same raw parse, for the same reason.
  readonly fileHeldSettings: ReadonlySet<string>;
  // What the file declares that nothing uses (the doctor's config check) —
  // from the same raw parse, for the same reason.
  readonly unused: readonly UnusedDecl[];
  // The plugin definitions this load merged, and those it dropped.
  readonly plugins: LoadedPlugins;
}

// The installed roots searched (every one watched), and the definitions —
// installed and listed — merged and dropped.
type LoadedPlugins = LoadedChain["installed"];

// The files a config is merged from, lowest first, and the one durable
// clicks write — `resolveDslConfig`'s chain, or the bundled default's empty
// one.
export interface ConfigChain {
  readonly layers: readonly string[];
  readonly home: string;
  // The session's project: where its repo-shipped plugins live.
  readonly projectDir: string | null;
}

// [LAW:nothing-unseen] Which plugins a daemon load merged, the data file each
// merged one reads, the checkout a `{ checkout }` path resolved against —
// `git:<root>`, or `dir:<cwd>` for a directory in no checkout, `-` with no
// session — and which it dropped: a drop is also on the strip, but the rest is
// said nowhere else. The daemon's own sink — buildRenderState is shared with
// the demo.
export function pluginLoadLine(
  layers: readonly string[],
  { plugins, config }: Pick<DslRenderState, "plugins" | "config">,
): string {
  const { checkout, loaded, dropped, unreached } = plugins;
  const checkoutField =
    checkout === null
      ? "-"
      : `${checkout.git ? "git" : "dir"}:${checkout.root}`;
  const dataOf = (definition: string): string => {
    const name = pluginNameOf(definition);
    const data =
      name === undefined ? undefined : config.variables[pluginDataVar(name)];
    return data?.kind === "file" ? data.path : "none";
  };
  return (
    `config load ${layers.join(" < ") || "<default>"}: plugins loaded=${loaded.length} dropped=${dropped.length} unplaced=${unreached.length} checkout=${checkoutField}` +
    loaded.map((p) => ` +${p} data=${dataOf(p)}`).join("") +
    dropped.map((d) => ` -${d.path} (${d.reason})`).join("") +
    unreached.map((d) => ` ~${d.path} (${d.reason})`).join("")
  );
}

// [LAW:one-source-of-truth] Each entry tracks the last *valid* DSL state +
// the last error AND last warning from a reload attempt. A state is only
// ever replaced by a state — a load failure means "show the error but keep
// rendering with what we had", and what we had is the bundled default until
// a config loads. Errors are scoped to the cache key (which includes cwd /
// projectDir) so a broken config in repo A cannot pollute repo B.
//
// [LAW:one-type-per-behavior] error and warning are distinct severities, so
// they get distinct channels. `lastError` is load-fatal (config didn't
// parse / validate); `lastWarning` is advisory (e.g., extension collision —
// load succeeded but something the user should know about). The render path
// surfaces both through one diagnostics composer in src/daemon/server.ts.
// [LAW:types-are-the-program] `projectDir` and `cwd` are required inputs to
// every render request. The wire boundary in server.ts validates the
// underlying hookData and returns BAD_REQUEST when either is absent, so by
// the time a cache entry is built they are real non-empty paths. `configFile`
// is the client's explicit path (server.ts composes a load-config pick,
// `--config`, and the `configEnv` hint; `~` already expanded) — present when
// overriding the standard precedence chain, undefined otherwise.
export interface CacheEntry {
  projectDir: string;
  cwd: string;
  configFile: string | undefined;
  // The files the state was merged from, lowest first, as the last load
  // resolved them (empty: the bundled default), and the one whose load
  // failed when the last load did.
  configLayers: readonly string[];
  // The file durable clicks write (resolveDslConfig's home).
  configHome: string;
  failedFile: string | null;
  lastError: string | null;
  lastWarning: string | null;
  state: DslRenderState;
  watcher: WatcherHandle | null;
  // The key `watcher` was acquired under — the identity of its target set.
  watcherKey: string | null;
}

// [LAW:one-source-of-truth] Cache key includes every input that affects DSL
// resolution: projectDir, cwd, and the session's explicit config path (if any).
// `projectDir`/`cwd` are real strings by construction (validated upstream);
// `configFile` collapses absent → empty in the key, distinct from any real path.
function cacheKey(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
): string {
  return projectDir + "\0" + cwd + "\0" + (configFile ?? "");
}

// [LAW:one-source-of-truth] The preset names whose layout the raw file
// authors — a root FRAGMENT (a whole tree or a `{ rows }` map, either is
// authorship) at the path presetRoot() reports, the one decision of "where
// does this preset's layout live" (src/config/presets.ts), projected onto
// the raw shape rather than re-derived here.
// [LAW:one-source-of-truth] `config` must be the MERGED tree, before
// validateConfig: edit chrome materializes an explicit `presets.<n>.root`
// for every preset, so asked of the validated tree presetRoot() never
// reports `root` and a file customizing a root-staging preset reads as
// pristine.
function authoredRoots(
  config: DslConfig,
  raw: RawDslConfig,
): ReadonlySet<string> {
  return new Set(
    presetNames(config.presets).filter((name) =>
      presetRoot(config, name).path === "root"
        ? raw.root !== undefined
        : raw.presets?.[name]?.root !== undefined,
    ),
  );
}

// [LAW:single-enforcer] Same enumerator the resolver uses, so the watcher
// covers the exact set of paths the next reload would consult — an explicit
// `configFile` collapses to one candidate; absent, the precedence chain unfolds
// in full. Every layer of the chain is ALSO watched by inode, so
// an in-place write fires as well as an atomic rename. Directories are
// deduped with their filename filters unioned, and the whole set is sorted
// so equal sets spell equal signatures.
function watchTargetsFor(
  entry: CacheEntry,
  layers: readonly string[],
): WatchTargets {
  // [LAW:types-are-the-program] A directory watched for named children, or
  // for every child (`null`): a plugin root holds folders no load has seen.
  const byDir = new Map<string, Set<string> | null>();
  // A plugin definition is part of the config it is listed in: installing,
  // fixing or editing one reloads the config as an edit to the file would.
  const { roots, loaded, dropped, unreached } = entry.state.plugins;
  for (const candidate of [
    ...dslConfigCandidatePaths(entry.projectDir, entry.cwd, entry.configFile),
    ...roots,
    ...loaded,
    ...[...dropped, ...unreached].map((d) => d.path),
  ]) {
    const { dir, name } = nearestWatchTarget(candidate);
    const names = byDir.has(dir) ? byDir.get(dir)! : new Set<string>();
    names?.add(name);
    byDir.set(dir, names);
  }
  // An existing root is watched for every child: a folder created in it is a
  // plugin installed.
  for (const root of roots) {
    const { dir, name, leaf } = nearestWatchTarget(path.join(root, "_"));
    if (leaf && name === "_") byDir.set(dir, null);
  }
  return {
    files: layers,
    dirs: [...byDir.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dirPath, names]) =>
        names === null
          ? { path: dirPath }
          : { path: dirPath, filenames: [...names].sort() },
      ),
  };
}

// The warning channel is ONE string (composeWithDiagnostics splits it into
// rows); absent advisories are nulls in the list, an empty list is null.
function joinWarnings(parts: ReadonlyArray<string | null>): string | null {
  return parts.filter(Boolean).join("\n") || null;
}

// [LAW:types-are-the-program] One attempt at loading a config from disk. The
// two arms are exclusive by construction: a state XOR an error message, never
// both, never neither — so a caller folding it cannot see a "loaded but also
// failed" entry. `warning` and `layers` are facts of the attempt
// regardless of arm (collision detection runs on a broken file too).
export type LoadOutcome = {
  readonly layers: readonly string[];
  readonly home: string;
  readonly warning: string | null;
} & (
  | { readonly state: DslRenderState; readonly error: null }
  | {
      readonly state: null;
      readonly error: string;
      // The layer whose load threw — the file the strip links to. Null when
      // the throw was not a file's (the bundled default by program
      // invariant never is).
      readonly failedFile: string | null;
    }
);

// [LAW:single-enforcer] Construct the full new state — parsed config,
// store, registry, compiled segments, palette — as one transaction. Any
// failure inside disposes the partially-built registry so we don't leak
// timers/watchers from a half-constructed reload, then rethrows so the
// caller (loadFromDisk) preserves the prior `entry.state` unchanged. The
// advisories each stage earns are appended to `warnings` as they arise —
// an accumulator the caller owns, because a return value could not carry
// them past the rethrow.
export function buildRenderState(
  cwd: string,
  chain: ConfigChain,
  warnings: Array<string | null>,
  deps: StateDeps,
  entered: (path: string | null) => void = () => {},
): DslRenderState {
  // [LAW:dataflow-not-control-flow][LAW:single-enforcer] Three primitives,
  // straight-line composition. `loadConfig(null)` returns the bundled
  // default (uniform merge against empty raw); `validateConfig` is the
  // sole producer of `ValidatedConfig`. The renderer accepts only
  // `ValidatedConfig`, so the compiler enforces the chain — there is no
  // "skip validate" path that typechecks downstream.
  // [LAW:one-source-of-truth] The chain's one load: each layer validated
  // over the layers it joins, so cross-ref diagnostics name the failing
  // file's own paths and lines. A layer's advisories are appended before its
  // validation, so a cross-ref failure still carries them (a duplicate key
  // names its line beside the error).
  const { layers, config, installed } = loadConfigChain(
    chain.layers,
    DEFAULT_DSL_CONFIG,
    { entered, warned: (w) => warnings.push(...w) },
    { projectDir: chain.projectDir, cwd },
  );
  // Past the chain, a failure is the one file's when there is one, and no
  // file's when several merged into what failed.
  entered(layers.length === 1 ? layers[0]!.path : null);
  const merged = layers.at(-1)?.config ?? DEFAULT_DSL_CONFIG;
  const homeRaw = layers.find((l) => l.path === chain.home)?.raw ?? {};

  const store = new VariableStore();
  // [LAW:single-enforcer] Inject the daemon's shared GitDataProvider so
  // every config's `kind: "git"` declarations route through one cache +
  // watcher pool (rather than each registry standing up its own). The
  // sessionState injection makes `kind: "state"` variables read/write the
  // same per-session store the click verbs mutate. `default_empty_value`
  // is honored from globals — it's the fallback used by input/env/etc.
  // sources when neither the path resolves nor the declaration carries
  // its own `default`. The loader validates it as a string; the registry
  // default ("") matches the historical behavior when omitted.
  const registry = new SourceRegistry(
    store,
    config.globals.default_empty_value ?? "",
    deps.gitService,
    deps.sessionState,
  );

  let compiled: CompiledConfig;
  try {
    // [LAW:one-source-of-truth] The action runtime reads session.id + current
    // picker values from registry.variableStore — the same store this entry's
    // registry declares into — so no store reference is threaded separately.
    compiled = registerDslConfig(config, registry, { cwd });
    // [LAW:dataflow-not-control-flow] Partial-load warnings (variable
    // declaration failures that didn't abort the load) flow through the
    // same warning channel as collision warnings; both visible at once —
    // appended before the validator pass so a derive throw still carries
    // them.
    warnings.push(...compiled.loadWarnings);
    // [LAW:no-silent-failure] The gates this config's sessions click through
    // are derived from its action table on demand (stateGate / configGate),
    // so nothing is installed here. They are built once now so an action
    // table that cannot gate — a built-in key re-claimed, two actions that
    // contradict each other on one key — fails this load, never the first
    // click.
    stateGate(config);
    configGate(config);
  } catch (err) {
    registry.dispose();
    throw err;
  }

  // [LAW:one-source-of-truth] basePalette is NOT frozen here. One cache entry
  // serves many sessions, but the effective theme is per-session SessionState;
  // freezing the palette per entry would let the rendered colors diverge from
  // the session's chosen theme. The server resolves basePalette per render
  // from the effective theme (resolveThemeSelection, settled by renderDsl).
  return {
    config,
    store,
    registry,
    compiled,
    neededInputPaths: neededPrefixesByPreset(config),
    lastRenderCellsBySegment: new Map<string, readonly RichText[]>(),
    // What a reset clears is the home's: resets write nowhere else.
    authoredRoots: authoredRoots(merged, homeRaw),
    fileHeldSettings: fileHeldSettings(homeRaw),
    // One entry per declaration, however many layers declare it.
    unused: [
      ...new Map(
        layers
          .flatMap((l) => unusedDeclarations(l.raw, merged))
          .map((u) => [`${u.kind}:${u.name}`, u] as const),
      ).values(),
    ],
    plugins: {
      checkout: installed.checkout,
      roots: installed.roots,
      // What renders, as the loader decided it: a nearer layer's load or
      // drop replaces a farther one's of the same name.
      loaded: [...installed.rendering.values()],
      dropped: [
        ...installed.dropped,
        ...layers.flatMap((l) => l.plugins.dropped),
      ],
      unreached: installed.unreached,
      reached: installed.reached,
      rendering: installed.rendering,
    },
  };
}

// [LAW:effects-at-boundaries] One attempt at the disk: resolve the path,
// detect collisions, build the state. It touches no entry — the cache folds
// the outcome onto a new entry (getOrCreate) or an existing one (reloadInto),
// so the state it built is never constructed-then-discarded and the no-file
// default is built once, not twice; `cc-candybar doctor`, which has no cache,
// reads the outcome and disposes the state it was handed.
export function loadFromDisk(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
  deps: StateDeps,
): LoadOutcome {
  const resolution = resolveDslConfig(projectDir, cwd, configFile);
  // `chain` loads its layers; `missing`/`unreadable` build the bundled
  // default — what distinguishes them is a notice, below, not a load path.
  const chain: ConfigChain = {
    layers: resolution.kind === "chain" ? resolution.layers : [],
    home: resolution.home,
    projectDir,
  };

  // [LAW:dataflow-not-control-flow] Advisories run every load, independent
  // of load success — even if the .json5 fails to parse, the user still
  // wants to know they have a shadowed .json sibling; an explicit path to
  // an absent file is named whatever the default then does. Pure
  // file-existence checks, so cheap. The watcher already monitors every
  // candidate path, so creating/removing a duplicate — or the named file
  // appearing — triggers reload and re-detection automatically; nothing
  // else needs to invalidate this.
  const advisories = [
    detectConfigCollisions(projectDir, cwd),
    configResolutionNotice(resolution),
  ];

  // [LAW:dataflow-not-control-flow] A failure at any step — parse,
  // registration, palette resolution — is the `error` arm; the caller's
  // prior state stays untouched, so the daemon keeps rendering the
  // last-known-good config — the bundled default until one has loaded —
  // plus the error strip (composeWithDiagnostics reads `lastError` and
  // `lastWarning`). The build appends the advisories it earns along the
  // way (the file's editability notice, the register pass's partial-load
  // warnings) to `advisories` as it goes, so every warning produced before
  // a failure still reaches the strip beside the error — the same channel,
  // the same ordering, that `cc-candybar check` reports.
  let state: DslRenderState;
  let failing: string | null = null;
  try {
    state = buildRenderState(cwd, chain, advisories, deps, (path) => {
      failing = path;
    });
  } catch (err) {
    if (err instanceof ConfigError) advisories.push(...err.warnings);
    return {
      layers: chain.layers,
      home: chain.home,
      failedFile: failing,
      warning: joinWarnings(advisories),
      state: null,
      error:
        err instanceof ConfigError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
  return {
    layers: chain.layers,
    home: chain.home,
    warning: joinWarnings(advisories),
    state,
    error: null,
  };
}

// [LAW:single-enforcer] What a config that fails its FIRST load renders: the
// bundled default. The render cache seeds an entry with it, and
// `cc-candybar doctor`, which has no cache, reads the same bar from it. The
// seed's own advisories go nowhere: the strip already carries the failed
// load's, and the default earns none by program invariant.
export function fallbackState(
  cwd: string,
  projectDir: string,
  deps: StateDeps,
): DslRenderState {
  // The entry's own project: the seed watches its repo's plugin root, so a
  // plugin installed there after the failed load reloads.
  return buildRenderState(cwd, { layers: [], home: "", projectDir }, [], deps);
}

export class RenderCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly deps: RenderDeps;
  private readonly maxEntries: number;
  private readonly observers: RenderCacheObservers;

  constructor(
    deps: RenderDeps,
    opts: { maxEntries?: number; observers?: RenderCacheObservers } = {},
  ) {
    this.deps = deps;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    this.observers = opts.observers ?? {};
  }

  // [LAW:dataflow-not-control-flow] One uniform shape: every entry has the
  // same fields and a renderable state. The renderer reads the data; no
  // special-case branches between "first load", "reload",
  // "reload-after-error".
  getOrCreate(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
  ): CacheEntry {
    const key = cacheKey(projectDir, cwd, configFile);
    const existing = this.entries.get(key);
    if (existing) {
      // Move to end (most recently used) for LRU eviction.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }

    const loaded = loadFromDisk(projectDir, cwd, configFile, this.deps);
    if (loaded.state !== null)
      dlog("info", pluginLoadLine(loaded.layers, loaded.state));
    // [LAW:no-silent-failure] A config that fails its FIRST load still yields
    // a bar: the bundled default, built exactly here and only then — the error
    // rides the diagnostic strip above it, loud, and the settings menu is the
    // door back to the file. The default validates by program invariant
    // (test/default-dsl-config.test.ts); a throw is a daemon bug and surfaces
    // as the request's failure, never a half-built entry.
    const entry: CacheEntry = {
      projectDir,
      cwd,
      configFile,
      configLayers: [],
      configHome: "",
      failedFile: null,
      lastError: loaded.error,
      lastWarning: loaded.warning,
      state: loaded.state ?? fallbackState(cwd, projectDir, this.deps),
      watcher: null,
      watcherKey: null,
    };
    // [LAW:single-enforcer] Insert, bound, watch, then notify — in that
    // order. From the moment the entry is in the map it is reachable for
    // eviction and dispose, so a throwing observer cannot strand a registry
    // outside it, and a reentrant getOrCreate for this key finds the entry
    // rather than building a duplicate. The bound runs first because it is a
    // fact about the MAP, complete at insertion: nothing later (including an
    // observer throwing) can skip it. [LAW:dataflow-not-control-flow]
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (oldest !== undefined) {
        const [oldestKey, evicted] = oldest;
        // [LAW:single-enforcer] dispose the registry on eviction — it owns
        // timers, fs watchers, and git subscriptions. Dropping the entry
        // without dispose leaks every async handle the config declared.
        evicted.state.registry.dispose();
        evicted.watcher?.release();
        this.entries.delete(oldestKey);
      }
    }
    this.refreshWatcher(entry, loaded);
    this.observers.onReload?.(entry);

    return entry;
  }

  // Re-read an entry from disk NOW, for a caller that just wrote its file and
  // must not act on the old config until the reload has landed (a save
  // releasing the picks the file now holds). The watcher still fires later;
  // a second reload of unchanged bytes is idempotent.
  reload(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
  ): void {
    this.reloadInto(this.getOrCreate(projectDir, cwd, configFile));
  }

  // Re-populate `entry` from the current state of disk (watcher-driven).
  //
  // - Load success: dispose the prior state, swap the fresh one in.
  // - Load failure: keep the prior state (the bundled default before any
  //   config has loaded), set lastError.
  //
  // [LAW:single-enforcer] hot-reload contract: any reload that produces a
  // new DslConfig disposes the old SourceRegistry before constructing a new
  // one. The registry owns timers, watchers, MobX reactions, and git
  // subscriptions — dropping it without dispose leaks every handle.
  //
  // [LAW:single-enforcer] One publish point for "this reload completed":
  // straight-line, so the signal structurally cannot be skipped by whichever
  // arm the load took.
  private reloadInto(entry: CacheEntry): void {
    const loaded = loadFromDisk(
      entry.projectDir,
      entry.cwd,
      entry.configFile,
      this.deps,
    );
    entry.lastWarning = loaded.warning;
    entry.lastError = loaded.error;
    if (loaded.state !== null) {
      dlog("info", pluginLoadLine(loaded.layers, loaded.state));
      // [LAW:single-enforcer] Dispose-before-swap: the old registry owns
      // timers, fs watchers, MobX reactions, and git subscriptions — dropping
      // the reference without disposing would leak them.
      entry.state.registry.dispose();
      entry.state = loaded.state;
    }
    // Rebinds to the broken file (and its sibling candidates) too, so an
    // in-place save OR a higher-precedence file appearing recovers.
    this.refreshWatcher(entry, loaded);
    this.observers.onReload?.(entry);
  }

  // [LAW:single-enforcer] One watcher-rebind decision per reload: the watch
  // target set is DERIVED from disk (which candidate resolved, which
  // ancestor directories exist right now), and the entry rebinds exactly when
  // that derived set differs from the one it holds. A resolved-path change
  // (including null↔non-null) is one way the set changes; a candidate's
  // parent directory appearing is another — the same rule covers both, so
  // there is no separate "did the path change" test to drift from it.
  private refreshWatcher(entry: CacheEntry, loaded: LoadOutcome): void {
    entry.configLayers = loaded.layers;
    entry.configHome = loaded.home;
    entry.failedFile = loaded.error === null ? null : loaded.failedFile;
    const targets = watchTargetsFor(entry, loaded.layers);
    // [LAW:one-source-of-truth] WatcherRegistry shares slots by key and keeps
    // the FIRST acquire's targets, so the key must name the target set —
    // the signature is the key, and "rebind when the set changed" and "the
    // key changed" are the same fact.
    const key = `config:${entry.projectDir}:${entry.cwd}:${entry.configFile ?? ""}:${JSON.stringify(targets)}`;
    if (entry.watcher !== null && entry.watcherKey === key) return;
    entry.watcher?.release();
    entry.watcherKey = key;
    entry.watcher = this.deps.watchers.acquire(key, targets, () =>
      this.onConfigChanged(entry),
    );
  }

  // [LAW:single-enforcer] One reload dispatcher per cache entry. The
  // watcher fires on any change in any candidate dir matching the
  // CONFIG_FILENAME; the entry re-resolves its own resolution chain (so a
  // higher-precedence file appearing supersedes a lower one) and reloads.
  // We don't filter by which specific path changed because the
  // (projectDir, cwd) tuple already scopes the entry's watcher set —
  // sibling entries with different scopes don't share this watcher.
  private onConfigChanged(entry: CacheEntry): void {
    dlog(
      "info",
      `config change detected for entry projectDir=${entry.projectDir} cwd=${entry.cwd}`,
    );
    this.reloadInto(entry);
  }

  get size(): number {
    return this.entries.size;
  }

  // [LAW:single-enforcer] One read path for "any entry's state" used by
  // the debug protocol's introspection (`debug vars` / `segments` / `config`).
  // Reads existing entries — does NOT call getOrCreate, so debug
  // introspection never has the side effect of creating a fresh cache entry
  // (with its own SourceRegistry timers/watchers) tied to the daemon's own
  // `process.cwd()`. Null only when the cache is empty; debug responses are
  // empty in that case by construction.
  firstState(): DslRenderState | null {
    return this.entries.values().next().value?.state ?? null;
  }
}
