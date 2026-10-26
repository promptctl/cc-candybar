import path from "node:path";
import { nearestWatchTarget } from "../../utils/watch-target.js";
import type { RichText } from "@promptctl/rich-js";
import { reaction } from "mobx";
import {
  neededPrefixesByPreset,
  settledLanes,
  type Declaration,
  type DeclaredLanes,
  type ViewFacts,
} from "../render-payload.js";
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
import {
  compileAlone,
  compileDslConfig,
  declareDslVariables,
  instantSegments,
  registerCompiled,
  type CompileInput,
  type CompileProvider,
  type CompiledConfig,
  type Registration,
} from "../../dsl/render.js";
import { mb } from "../limits.js";
import { stateGate } from "../verbs/state-validators.js";
import { configGate } from "../verbs/config-validators.js";
import { presetNames, presetRoot } from "../../config/presets.js";
import { presetOf } from "../../config/effective-globals.js";
import { unusedDeclarations, type UnusedDecl } from "../../config/unused.js";
import { VariableStore } from "../../var-system/store.js";
import { SourceRegistry } from "../../var-system/sources.js";
import type { VarScope } from "../../dsl/variable-scope.js";
import type { SessionStateReader, SessionStateRW } from "../session-state.js";
import type {
  WatcherRegistry,
  WatcherHandle,
  WatchTargets,
} from "./watchers.js";
import { quietLogger, type DaemonLogger } from "../../utils/logger.js";
import { Holds } from "../../utils/holds.js";
import { ABSENT, failed } from "../../utils/outcome.js";
import { pluginDataVar, pluginNameOf } from "../../config/loader/plugins.js";
import { projectionsOf } from "../../config/loader/projections.js";

// [LAW:one-source-of-truth] Each cache entry owns the live DSL state for a
// (projectDir, cwd) tuple: the parsed config, the variable store +
// registry it was registered against, the compiled segment closures, and
// the resolved base palette. registerDslConfig + renderDsl are the
// single render path — the cache only holds state across calls.
//
// [LAW:one-source-of-truth] Bounded by bytes, out of the daemon's one memory
// budget: an entry is a new one per directory a session renders from (every
// worktree, every `cd`), so a count sized for watchers (it was 256, ~2.4 GB of
// states) let the memory backstop trip long before anything was evicted
// (brandon-unfiled-3248.8yp). The heap a state holds beside its compile, and
// the heap one compile holds — measured, and held to by
// test/render-cache-sharing.test.ts, which fails when either is exceeded.
// Measured 2026-10-20 over the bundled default: a rendered entry 1.8 MB (2.4
// MB in a daemon serving a full user config from forty real worktree
// directories); a compile 7.1 MB, counted as an evicted builder leaves it —
// its own heap and the part of that builder's config it still reaches. It was
// 9.3 MB an entry, every one compiling its own.
export const ENTRY_BYTES = 3 * 1024 * 1024;
export const COMPILE_BYTES = 10 * 1024 * 1024;
// A session's view (SessionView): its store of the session's values over the
// entry's, and the parts of every placement it has drawn, kept until it is
// disposed (src/dsl/parts.ts). Measured 2026-10-23 over the bundled default:
// 1.0 MB a view drawn once, and 1.6 MB a view that has opened every list the
// menu hangs and every tab — the most it draws — so the constant charges that,
// with headroom for a user config's further placements.
export const VIEW_BYTES = 2.5 * 1024 * 1024;

// The render cache's share of the daemon's memory limit: a quarter, leaving the
// rest to V8's own mappings, the code, the other caches, and the heap's growth
// room. At the default limit that is ~114 sessions on one compile, each an
// entry and a view, against a working set of ~20 directories in the production
// daemon. A larger share buys entries with RSS: rendering 100 worktree
// directories, RSS ended at 329 / 390 / 424 MB of a 512 MB limit under a
// quarter / three eighths / half — the larger two past the 75% line
// `approachingLimit` warns at.
export function renderCacheBudget(memoryLimitBytes: number): number {
  return Math.floor(memoryLimitBytes / 4);
}

// The count ceiling beside the byte budget: every entry holds a
// SourceRegistry (fs watchers, TTL timers) and a config
// watcher, a resource the byte budget does not see. At the default memory limit
// the bytes bind long before this; it is what bounds watchers when
// CC_CANDYBAR_RSS_LIMIT_MB is raised.
export const MAX_ENTRIES = 256;

// [LAW:single-enforcer] These are the cache-and-registry deps — session state
// (for declareState atoms) and the watcher registry (for hot-reload's config file watcher). Daemon-
// owned data providers like the SessionUsageStore/git provider/etc. live in
// `payloadDeps` (server.ts) and feed `buildRenderPayload`; they are not
// part of cache identity or lifecycle.
export interface RenderDeps {
  sessionState: SessionStateRW;
  watchers: WatcherRegistry;
  // What a view declares of the daemon's shared entries
  // (src/daemon/render-payload.ts `declareLanes`); a test reading no built-in
  // source passes DECLARES_NOTHING.
  declare: Declare;
  // Where the cache's events go — every load, every teardown. Only the
  // daemon passes `dlog`; a caller passing none logs quietly, like the
  // providers and the usage store.
  log?: DaemonLogger;
}

// What building one config's state needs.
export interface StateDeps {
  readonly sessionState: SessionStateRW;
  // The compile for a config's compile key. A cache shares one between every
  // entry whose config compiles alike (RenderCache's table); a one-shot load
  // has no other entry to share with and compiles its own.
  readonly compile?: CompileProvider;
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
// `store` and `registry` are the entry's DIRECTORY home: the sources no
// session value reaches (variable-scope.ts). A session draws through its own
// view over them (SessionView).
export interface DslRenderState {
  readonly config: ValidatedConfig;
  // [LAW:one-source-of-truth] The identity of `compiled` (compileKey of what
  // it was compiled from): states carrying one key carry one compile.
  readonly compileKey: string;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly compiled: CompiledConfig;
  readonly neededInputPaths: (preset: string) => ReadonlySet<string>;
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
  {
    plugins,
    config,
    compiled,
  }: Pick<DslRenderState, "plugins" | "config" | "compiled">,
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
    `config load ${layers.join(" < ") || "<default>"}: projections=${[...projectionsOf(config).keys()].join(",") || "-"} instantSegments=${instantSegments(compiled).join(",") || "-"} instantTemplates=${compiled.instant.size} plugins loaded=${loaded.length} dropped=${dropped.length} unplaced=${unreached.length} checkout=${checkoutField}` +
    loaded.map((p) => ` +${p} data=${dataOf(p)}`).join("") +
    dropped.map((d) => ` -${d.path} (${d.reason})`).join("") +
    unreached.map((d) => ` ~${d.path} (${d.reason})`).join("")
  );
}

// [LAW:nothing-unseen] A config's teardown releases every computed's MobX
// subscriptions (brandon-unfiled-3248.t14 was a teardown that released none,
// found in a heap snapshot because nothing said so). Why it was torn down,
// how many it released, and how many renders were still drawing with it when
// the cache retired it — those deferred the teardown to the last one's return
// (brandon-unfiled-3248.6rc) — beside the load line of what replaced it.
export interface Teardown {
  readonly reason: "reload" | "evict" | "close";
  // Renders holding the state when it was retired: 0 is a teardown at
  // retirement, more is one deferred to the last release.
  readonly held: number;
}

export function configDisposeLine(
  teardown: Teardown,
  released: number,
): string {
  return `config disposed reason=${teardown.reason} released=${released} held=${teardown.held}`;
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
// `--config`, and the `configEnv` hint; absolute) — present when
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

// [LAW:no-ambient-temporal-coupling] A state's lifetime is a fact the cache
// owns (brandon-unfiled-3248.6rc): the renders holding it across their
// payload await, and the teardown it is due once the cache stopped serving
// it — evicted, or replaced by a reload. Deferred reclamation, RCU-style:
// the map moves at once (the cap stays a bound, a reload swaps at once) and
// a retired state is disposed when its last holder returns, never under a
// render — which otherwise resumed on a disposed store, every chained read
// recomputed untracked.
interface StateHold {
  holders: number;
  retired: Teardown | null;
}

// A render's hold on the state it draws with: the state, the entry it was
// served from, and the release that `using` runs on every exit of the
// holder's scope (return and throw alike). Released exactly once.
export interface Hold extends Disposable {
  readonly entry: CacheEntry;
  readonly state: DslRenderState;
}

// A render's hold on the session's view it draws through, and the state the
// view is of — both released by the one `using`.
export interface SessionHold extends Hold {
  readonly view: SessionView;
}

// Why a view stopped being served: its state did (reload, evict, close), its
// session's latest render resolved to another entry (`moved`), or no render
// read it across a whole sweep (`idle`).
export type ViewClose = Teardown["reason"] | "moved" | "idle";

// A view's lifetime, as a state's (StateHold), and whether a render read it
// since the last sweep.
interface ViewHold {
  holders: number;
  retired: { readonly reason: ViewClose; readonly held: number } | null;
  read: boolean;
}

// [LAW:nothing-unseen] The states renders are drawing with now, and those
// retired but not yet reclaimed because one still is (`daemon-stats`):
// `retired` climbing while `size` holds is a render that never returned.
export interface RenderCacheStats {
  readonly size: number;
  readonly held: number;
  readonly retired: number;
  // Distinct compiles the cache holds — below `size` exactly when entries
  // share them.
  readonly compiles: number;
  // Sessions' views served now: one per session at most.
  readonly views: number;
  // Views retired but not yet disposed because a render still holds one: as
  // `retired` is for states, climbing while `views` holds is a render that
  // never returned.
  readonly retiredViews: number;
  // What the entries the map serves are charged against the budget.
  readonly accountedBytes: number;
  readonly budgetBytes: number;
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
  // The sessionState injection makes `kind: "state"` variables read/write the
  // same per-session store the click verbs mutate. `default_empty_value`
  // is honored from globals — it's the fallback used by input/env/etc.
  // sources when neither the path resolves nor the declaration carries
  // its own `default`. The loader validates it as a string; the registry
  // default ("") matches the historical behavior when omitted.
  const registry = new SourceRegistry(
    store,
    config.globals.default_empty_value ?? "",
    deps.sessionState,
  );

  let registration: Registration;
  try {
    // [LAW:one-source-of-truth] The compile holds no store: each render binds
    // its own (drawDsl), so the entry's registry is the store its renders read
    // — and the compile can be one shared by every entry whose config
    // compiles alike (brandon-unfiled-3248.8yp).
    registration = registerCompiled(
      config,
      registry,
      cwd,
      deps.compile ?? compileAlone,
      DIRECTORY_SCOPE,
    );
    // [LAW:dataflow-not-control-flow] Partial-load warnings (variable
    // declaration failures that didn't abort the load) flow through the
    // same warning channel as collision warnings; both visible at once —
    // appended before the validator pass so a derive throw still carries
    // them.
    warnings.push(...registration.loadWarnings);
    // [LAW:single-enforcer] A session value that cannot declare (a template
    // that does not parse) is a fact of the config, so the load finds it, as
    // it finds a directory source's: the session values are declared once into
    // a view no session draws, then disposed. Every session's view declares
    // them identically and reports nothing (openView).
    const probe = registry.view();
    warnings.push(...declareDslVariables(config, probe, cwd, VIEW_SCOPE));
    probe.dispose();
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
    compileKey: registration.compileKey,
    store,
    registry,
    compiled: registration.compiled,
    neededInputPaths: neededPrefixesByPreset(config),
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

// The scopes a render cache entry and a session's view declare.
const DIRECTORY_SCOPE: ReadonlySet<VarScope> = new Set(["directory"]);
const VIEW_SCOPE: ReadonlySet<VarScope> = new Set(["view"]);

// [LAW:one-source-of-truth] A session's view of one entry's state
// (brandon-unfiled-3248.8ro6, step 2): the session's own values — its inputs,
// its state reads, its derivations, the sources keyed on them — in a store
// over the entry's directory store, which it reads through to. Each session
// renders through its own, so a request writes only its own session's values
// and no other session's render re-runs, reads, or reports them.
//
// `holds` is what the session's renders read of the daemon's shared entries (a
// repo, a pane, a memento reading), as the view's declaration takes them
// (openView), so their owners' periods visit them while the view's preset and
// request name them and stop when it is disposed; the directory home reads
// none itself, so it holds none (brandon-unfiled-3248.8ro6).
//
// `lastRenderCellsBySegment` is the per-segment StripCell sink that renderDsl
// writes on each render — pre-layout cells, NOT serialized ANSI. Storing cells
// (not strings) keeps the hot path free of the per-segment renderStripCells
// call: the debug projection serializes on demand only when a `debug segments`
// request actually arrives. The map identity is stable for the view's
// lifetime; renderDsl clears + repopulates it in place. A segment hidden by
// `when` is absent from the map — its presence in the keys is the "this
// segment rendered" signal.
export interface SessionView {
  readonly sessionId: string;
  readonly state: DslRenderState;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly holds: Holds;
  // The request the view's renders draw by — the keys its declaration takes
  // its holds at. A render of the same request changes nothing.
  requested(facts: ViewFacts): void;
  // The request the view draws by now: the one it opened with, or a later
  // one `requested` named.
  facts(): ViewFacts;
  // The lanes the view's latest declaration handed it: what its draws read
  // of the daemon's shared entries.
  lanes(): DeclaredLanes;
  readonly lastRenderCellsBySegment: Map<string, readonly RichText[]>;
  // [LAW:single-enforcer] The view's one teardown: its holds close and its
  // registry is disposed, so no caller of openView can release one and leak
  // the other. Returns how many computeds the registry's store released.
  dispose(): number;
}

// What a view declares into its holds: every keyed entry `closure` reads, at
// the keys `facts` name. Returns the lanes it took, and what threw.
export type Declare = (
  holds: Holds,
  facts: ViewFacts,
  closure: ReadonlySet<string>,
) => Declaration;

export const DECLARES_NOTHING: Declare = () => ({
  lanes: settledLanes(ABSENT),
  faults: [],
});

// What a view reads to keep its declaration current.
export interface ViewDeclaring {
  readonly sessionState: SessionStateReader;
  readonly declare: Declare;
  readonly log: DaemonLogger;
}

// [LAW:single-enforcer] The one way a view is built: the state's directory
// registry opens a view registry, and the config's view-scoped variables are
// declared into it, in `cwd` — the entry's, where its shells run.
//
// [LAW:no-ambient-temporal-coupling] Its holds are declared by one reaction,
// over the request its renders draw by and the preset the session's picks
// resolve to (brandon-unfiled-3248.8ro6, step 3): a request naming other keys,
// or a click moving the preset, declares again in the turn it lands, so the
// sources a preset newly places are read before any draw asks for them, and
// those it stops placing are released at once.
//
// [LAW:types-are-the-program] A view is never undeclared (step 4): it opens
// with the request it is drawn for and declares in its opening turn, so its
// lanes always hold its latest declaration's.
export function openView(
  state: DslRenderState,
  cwd: string,
  sessionId: string,
  facts: ViewFacts,
  { sessionState, declare, log }: ViewDeclaring,
): SessionView {
  const registry = state.registry.view();
  const holds = new Holds();
  // What fails to declare here failed in the load's probe (buildRenderState),
  // which reported it: a declaration reads only the config.
  declareDslVariables(state.config, registry, cwd, VIEW_SCOPE);
  const presetNow = () =>
    presetOf(state.config, (key) => sessionState.get(sessionId, key));
  // [LAW:no-silent-failure] The closure is computed here, beside the
  // declaration, where a throw is logged — a reaction's tracked expression
  // that throws reaches only the console MobX prints to, which nobody reads in
  // a detached daemon. A declaration that throws keeps the holds it had, and
  // its lanes answer its failure, naming the cause.
  const lanesFor = (facts: ViewFacts, preset: string): DeclaredLanes => {
    try {
      const reads = state.neededInputPaths(preset);
      const {
        result: { lanes: taken, faults },
        acquired,
        released,
      } = holds.declare(() => declare(holds, facts, reads));
      for (const fault of faults) {
        log(
          "error",
          `session view declaration threw sid=${JSON.stringify(sessionId)} ${fault}`,
        );
      }
      // [LAW:verifiable-goals] A declaration that moved a hold — a preset
      // click, a request naming another key — says so; one that kept what
      // the view held, every other request's, writes nothing.
      if (acquired + released > 0) {
        log(
          "info",
          `session view declared sid=${JSON.stringify(sessionId)} acquired=${acquired} released=${released} held=${holds.size}`,
        );
      }
      return taken;
    } catch (e) {
      log(
        "error",
        `session view declaration threw sid=${JSON.stringify(sessionId)}: ${String(e)}`,
      );
      return settledLanes(failed(`view declaration threw: ${String(e)}`));
    }
  };
  // [LAW:no-ambient-temporal-coupling] The opening declaration, and each
  // request's, runs in its own call, never as a reaction's run: MobX holds a
  // reaction inside a batch (a reaction's effect, an action) until the batch
  // ends, and a frame drawn in that batch would read a view declared for a
  // request it is not drawn for.
  //
  // [LAW:one-source-of-truth] The view's one record of what it is declared
  // for, and the lanes that declaration handed it.
  const declaration = (facts: ViewFacts, preset: string) =>
    ({ facts, preset, lanes: lanesFor(facts, preset) }) as const;
  let declared = declaration(facts, presetNow());
  // [LAW:single-enforcer] A (request, preset) pair is declared once.
  const redeclare = (facts: ViewFacts, preset: string): void => {
    if (facts === declared.facts && preset === declared.preset) return;
    declared = declaration(facts, preset);
  };
  // The preset moves with the session's picks, which the reaction tracks: its
  // first run, whenever it comes, declares only a preset moved since.
  const stop = reaction(
    presetNow,
    (preset) => redeclare(declared.facts, preset),
    { fireImmediately: true },
  );
  return {
    sessionId,
    state,
    store: registry.variableStore,
    registry,
    holds,
    requested: (next) => redeclare(next, presetNow()),
    facts: () => declared.facts,
    lanes: () => declared.lanes,
    lastRenderCellsBySegment: new Map<string, readonly RichText[]>(),
    dispose: () => {
      stop();
      holds.close();
      return registry.dispose();
    },
  };
}

// [LAW:no-ambient-temporal-coupling] The cache's one timer, armed by the first
// render and stopped with the last entry: every interval it closes each view
// no render read since the interval before, which releases the view's holds,
// so an owner's period stops visiting a repo, pane or memento reading 2.5 to 5
// minutes after the session's last render. A view still drawn holds what its
// declaration takes (openView), and a period resumed after a gap reads at once.
export const HOLD_SWEEP_MS = 150_000;

export class RenderCache {
  private readonly entries = new Map<string, CacheEntry>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  // Every state the map serves or served, until reclaimed.
  private readonly holds = new Map<DslRenderState, StateHold>();
  // [LAW:one-source-of-truth] Each session's ONE view: of the entry its latest
  // render resolved to. A render from another entry replaces it.
  private readonly views = new Map<string, SessionView>();
  // Every view the cache serves or served, until reclaimed.
  private readonly viewHolds = new Map<SessionView, ViewHold>();
  // [LAW:one-source-of-truth] One compile per compile key, shared by every
  // state carrying that key, and dropped with the last of them (reclaim).
  private readonly compiles = new Map<string, CompiledConfig>();
  private readonly deps: RenderDeps & StateDeps;
  private readonly log: DaemonLogger;
  // Read when an eviction is decided: the budget is a boot-time fact.
  private readonly budgetBytes: () => number;
  private readonly maxEntries: number;
  private readonly observers: RenderCacheObservers;

  constructor(
    deps: RenderDeps,
    opts: {
      budgetBytes: () => number;
      maxEntries?: number;
      observers?: RenderCacheObservers;
    },
  ) {
    this.deps = {
      ...deps,
      compile: (key, input) => this.compileOf(key, input),
    };
    this.log = deps.log ?? quietLogger;
    this.budgetBytes = opts.budgetBytes;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    this.observers = opts.observers ?? {};
  }

  // The compile a served state carries for `key`, else a new one — which the
  // table learns only when a state carrying it is served, so a load that fails
  // after compiling leaves nothing behind.
  private compileOf(key: string, input: CompileInput): CompiledConfig {
    return this.compiles.get(key) ?? compileDslConfig(input);
  }

  // [LAW:one-source-of-truth] Read off the map the cache serves: an entry's
  // own heap, plus each compile its entries carry once, however many share it.
  private accountedBytes(): number {
    const keys = new Set(
      [...this.entries.values()].map((e) => e.state.compileKey),
    );
    return (
      this.entries.size * ENTRY_BYTES +
      keys.size * COMPILE_BYTES +
      this.views.size * VIEW_BYTES
    );
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

    const loaded = this.load(projectDir, cwd, configFile);
    if (loaded.state !== null)
      this.log("info", pluginLoadLine(loaded.layers, loaded.state));
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
    this.serve(entry.state);
    // [LAW:single-enforcer] Insert, bound, watch, then notify — in that
    // order. From the moment the entry is in the map it is reachable for
    // eviction and dispose, so a throwing observer cannot strand a registry
    // outside it, and a reentrant getOrCreate for this key finds the entry
    // rather than building a duplicate. The bound runs first because it is a
    // fact about the MAP, complete at insertion: nothing later (including an
    // observer throwing) can skip it. [LAW:dataflow-not-control-flow]
    this.entries.set(key, entry);
    this.fit(entry);
    this.log(
      "info",
      `render-cache entry projectDir=${projectDir} cwd=${cwd} compile=${entry.state.compileKey.slice(0, 12)} entries=${this.entries.size} compiles=${this.compiles.size} accounted=${mb(this.accountedBytes())}/${mb(this.budgetBytes())}MB`,
    );
    this.refreshWatcher(entry, loaded);
    this.observers.onReload?.(entry);

    return entry;
  }

  // [LAW:no-ambient-temporal-coupling] A render holds the state it draws
  // with for as long as it runs — across the payload await, where another
  // session's first render can evict its entry and a saved file can reload
  // it. Either retires the state; the cache disposes it when this hold is
  // released, so the render finishes on the state it resolved its payload
  // from (brandon-unfiled-3248.6rc). `using` at the call site releases on
  // every exit, a throw included.
  hold(projectDir: string, cwd: string, configFile: string | undefined): Hold {
    const entry = this.getOrCreate(projectDir, cwd, configFile);
    const { state } = entry;
    const hold = this.holdOf(state);
    hold.holders++;
    this.armSweep();
    let released = false;
    return {
      entry,
      state,
      [Symbol.dispose]: () => {
        // [LAW:no-silent-failure] A second release would count a render that
        // is not there, and a later render's hold would then read as none.
        if (released) throw new Error("render-cache hold released twice");
        released = true;
        hold.holders--;
        this.reclaim(state, hold);
      },
    };
  }

  // [LAW:no-ambient-temporal-coupling] A render's hold on the session's view
  // of the state it draws with, for the same reason as `hold`: a move, a
  // reload, an eviction or an idle sweep retires the view, and the cache
  // disposes it when this hold is released.
  //
  // [LAW:single-enforcer] `facts` is the request the render is drawn for: the
  // view is declared with it here, opened (openView) or kept (`requested`),
  // so no view is drawn declared for another request.
  holdSession(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
    sessionId: string,
    facts: ViewFacts,
  ): SessionHold {
    const held = this.hold(projectDir, cwd, configFile);
    let view: SessionView;
    let lease: ViewHold;
    try {
      view = this.viewOf(sessionId, held.entry, held.state, facts);
      lease = this.leaseOf(view);
    } catch (err) {
      // [LAW:no-ambient-temporal-coupling] The state hold is this call's
      // until the returned hold carries it: a throw before then releases it,
      // or the state could never be reclaimed.
      held[Symbol.dispose]();
      throw err;
    }
    lease.holders++;
    lease.read = true;
    let released = false;
    return {
      entry: held.entry,
      state: held.state,
      view,
      [Symbol.dispose]: () => {
        if (released) throw new Error("render-cache view hold released twice");
        released = true;
        lease.holders--;
        this.reclaimView(view, lease);
        held[Symbol.dispose]();
      },
    };
  }

  // The session's view of `state`: the one it has, or a new one replacing it.
  private viewOf(
    sessionId: string,
    entry: CacheEntry,
    state: DslRenderState,
    facts: ViewFacts,
  ): SessionView {
    const current = this.views.get(sessionId);
    if (current?.state === state) {
      // Move to end (most recently used), as getOrCreate does an entry.
      this.views.delete(sessionId);
      this.views.set(sessionId, current);
      // A request declares again before its refresh; a frame's facts, the
      // session's latest request, are already declared and change nothing.
      current.requested(facts);
      return current;
    }
    // [LAW:no-ambient-temporal-coupling] The new view is declared before the
    // old one is retired, as a reload's successor is, so a move between two
    // directories of one repo keeps the repo held across it. It enters at the
    // end, the most recently used, as a kept view moves there.
    // The old view is retired whether or not the new one opens: the session's
    // render resolved to another entry either way.
    this.views.delete(sessionId);
    let view: SessionView;
    try {
      view = this.opened(sessionId, entry, state, facts, false);
    } finally {
      if (current !== undefined) this.retireView(current, "moved");
    }
    // A view is charged to the budget like an entry.
    this.fit(entry);
    return view;
  }

  // [LAW:single-enforcer] The one way the cache opens a view: declared with
  // `facts` in this turn (openView) and entered — `read` whether a render
  // read the session's view since the last sweep. Its caller charges it to
  // the budget, once however many it opens.
  private opened(
    sessionId: string,
    entry: CacheEntry,
    state: DslRenderState,
    facts: ViewFacts,
    read: boolean,
  ): SessionView {
    const view = openView(state, entry.cwd, sessionId, facts, {
      sessionState: this.deps.sessionState,
      declare: this.deps.declare,
      log: this.log,
    });
    this.views.set(sessionId, view);
    this.viewHolds.set(view, { holders: 0, retired: null, read });
    this.log(
      "info",
      `session view opened sid=${JSON.stringify(sessionId)} cwd=${entry.cwd} views=${this.views.size}`,
    );
    return view;
  }

  private leaseOf(view: SessionView): ViewHold {
    const lease = this.viewHolds.get(view);
    // [LAW:no-silent-failure] As holdOf: every view handed out was entered.
    if (lease === undefined) throw new Error("render-cache view never served");
    return lease;
  }

  // The cache stopped serving `view`; its teardown is due now, or when the
  // last render holding it returns.
  private retireView(view: SessionView, reason: ViewClose): void {
    if (this.views.get(view.sessionId) === view)
      this.views.delete(view.sessionId);
    const lease = this.leaseOf(view);
    lease.retired = { reason, held: lease.holders };
    this.reclaimView(view, lease);
  }

  // [LAW:single-enforcer] The one place a view is disposed: retired and unheld.
  private reclaimView(view: SessionView, lease: ViewHold): void {
    if (lease.retired === null || lease.holders > 0) return;
    this.viewHolds.delete(view);
    this.log(
      "info",
      `session view closed sid=${JSON.stringify(view.sessionId)} reason=${lease.retired.reason} released=${view.dispose()} held=${lease.retired.held} views=${this.views.size}`,
    );
  }

  private armSweep(): void {
    if (this.sweep !== null) return;
    this.sweep = setInterval(() => this.releaseIdle(), HOLD_SWEEP_MS);
    this.sweep.unref?.();
  }

  // One sweep. Public so a test can run it at an instant it chose.
  releaseIdle(): void {
    // A view no render read across the whole interval is closed: its session
    // ended, or draws from another daemon's bar no more.
    for (const [view, lease] of this.viewHolds) {
      if (lease.retired !== null) continue;
      if (lease.read) lease.read = false;
      else this.retireView(view, "idle");
    }
    if (this.entries.size === 0 && this.sweep !== null) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  }

  // The cache's teardown: the sweep stops, and every entry is dropped, so its
  // state is disposed now or when the render holding it returns. The sweep and
  // the entries' watchers would otherwise keep the cache, and every compile it
  // serves, alive for as long as the process runs.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
    const entries = this.entries.size;
    for (const [key, entry] of this.entries) this.drop(key, entry, "close");
    // [LAW:one-source-of-truth] Every state left in `holds` is retired and
    // waits on a render, so `retired` is the count of teardowns deferred.
    this.log(
      "info",
      `render-cache closed entries=${entries} deferred=${this.stats.retired}`,
    );
  }

  // [LAW:single-enforcer] The one place the cache loads a state, so a closed
  // cache refuses every way one would be built — a new entry, a reload, a
  // config watch firing after the close.
  // [LAW:no-silent-failure] A closed cache disposed every state it built; one
  // built after would hold timers and watchers nothing tears down.
  private load(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
  ): LoadOutcome {
    if (this.closed) throw new Error("render cache used after close");
    return loadFromDisk(projectDir, cwd, configFile, this.deps);
  }

  // [LAW:single-enforcer] The one way an entry leaves the map: its watcher
  // goes, the map stops serving it, and its state is retired.
  private drop(
    key: string,
    entry: CacheEntry,
    reason: Teardown["reason"],
  ): void {
    entry.watcher?.release();
    this.entries.delete(key);
    this.retire(entry.state, reason, null);
  }

  get stats(): RenderCacheStats {
    let held = 0;
    let retired = 0;
    for (const hold of this.holds.values()) {
      if (hold.holders > 0) held++;
      if (hold.retired !== null) retired++;
    }
    let retiredViews = 0;
    for (const lease of this.viewHolds.values()) {
      if (lease.retired !== null) retiredViews++;
    }
    return {
      size: this.entries.size,
      held,
      retired,
      compiles: this.compiles.size,
      views: this.views.size,
      retiredViews,
      accountedBytes: this.accountedBytes(),
      budgetBytes: this.budgetBytes(),
    };
  }

  // [LAW:single-enforcer] The one place the cache's bounds are enforced — its
  // bytes and its count — run after every change to what the map serves (an
  // insertion, a reload): least recently used first, until the map fits both
  // — never `served`, the entry the change was for, which a render is about
  // to draw.
  private fit(served: CacheEntry): void {
    const fits = (): boolean =>
      this.entries.size <= this.maxEntries &&
      this.accountedBytes() <= this.budgetBytes();
    for (const [key, evicted] of this.entries) {
      if (fits()) return;
      if (evicted === served) continue;
      this.drop(key, evicted, "evict");
    }
    // [LAW:no-silent-failure] Nothing left to evict: the entry served and its
    // sessions' views alone exceed the budget.
    if (!fits())
      this.log(
        "warn",
        `render-cache over budget entries=${this.entries.size} views=${this.views.size} accounted=${mb(this.accountedBytes())}/${mb(this.budgetBytes())}MB`,
      );
  }

  // The cache starts serving `state`: unheld, and not yet retired — and the
  // compile it carries is the table's for its key.
  private serve(state: DslRenderState): void {
    const held = this.compiles.get(state.compileKey);
    // [LAW:no-silent-failure] compileOf hands a build the table's compile for
    // its key, so a second compile under one key is a cache bug: overwriting
    // it would leave the first alive and uncounted.
    if (held !== undefined && held !== state.compiled)
      throw new Error(
        `render cache: a second compile for key ${state.compileKey.slice(0, 12)}`,
      );
    this.holds.set(state, { holders: 0, retired: null });
    this.compiles.set(state.compileKey, state.compiled);
    if (held === undefined)
      this.log(
        "info",
        `render-cache compile built key=${state.compileKey.slice(0, 12)} compiles=${this.compiles.size}`,
      );
  }

  private holdOf(state: DslRenderState): StateHold {
    const hold = this.holds.get(state);
    // [LAW:no-silent-failure] Every state the map serves was entered at its
    // creation or its reload; one that was not is a cache bug, not a miss.
    if (hold === undefined) throw new Error("render-cache state never served");
    return hold;
  }

  // The cache stopped serving `state`: it left the map, or a reload
  // replaced it with `successor`. Its teardown is due — now, or at its last
  // holder's return.
  private retire(
    state: DslRenderState,
    reason: Teardown["reason"],
    successor: {
      readonly entry: CacheEntry;
      readonly state: DslRenderState;
    } | null,
  ): void {
    // [LAW:single-enforcer] A view is a child of its state: the state going
    // retires every view of it first, so each is disposed before or with it.
    // [LAW:no-ambient-temporal-coupling] A reload opens each view's successor
    // over the new state first, declared with the request the old one drew by,
    // so the session's repo, pane and memento scope stay held across it and
    // the next frame draws a declared view (brandon-unfiled-3248.8ro6, 4a).
    for (const view of [...this.views.values()]) {
      if (view.state !== state) continue;
      if (successor !== null) {
        // [LAW:no-silent-failure] A successor that fails to open is said, and
        // the old view is still retired, so the reload never leaves a state
        // half torn down; the session's next render opens its view.
        try {
          // The successor is the session's view going on: a session no
          // render read since the last sweep is still closed by the next.
          this.opened(
            view.sessionId,
            successor.entry,
            successor.state,
            view.facts(),
            this.leaseOf(view).read,
          );
        } catch (e) {
          this.log(
            "error",
            `session view reopen failed sid=${JSON.stringify(view.sessionId)}: ${String(e)}`,
          );
        }
      }
      this.retireView(view, reason);
    }
    const hold = this.holdOf(state);
    hold.retired = { reason, held: hold.holders };
    this.reclaim(state, hold);
  }

  // [LAW:single-enforcer] The one place a state is disposed: once it is
  // retired AND unheld, from whichever of the two transitions came last. The
  // registry owns timers, fs watchers and MobX reactions — dropping it
  // without dispose leaks every handle the config declared.
  private reclaim(state: DslRenderState, hold: StateHold): void {
    if (hold.retired === null || hold.holders > 0) return;
    this.holds.delete(state);
    this.log("info", configDisposeLine(hold.retired, state.registry.dispose()));
    // [LAW:one-source-of-truth] `holds` lists every state not yet reclaimed,
    // so a compile no state left there carries has no render to draw it.
    if (![...this.holds.keys()].some((s) => s.compileKey === state.compileKey))
      this.compiles.delete(state.compileKey);
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
  // - Load success: swap the fresh state in, retire the prior one.
  // - Load failure: keep the prior state (the bundled default before any
  //   config has loaded), set lastError.
  //
  // [LAW:single-enforcer] hot-reload contract: any reload that produces a
  // new DslConfig retires the old state, and `reclaim` disposes its
  // SourceRegistry — at once when no render holds it, else when the last
  // one returns. Dropping the reference without that would leak every
  // timer, watcher and MobX reaction it owns.
  //
  // [LAW:single-enforcer] One publish point for "this reload completed":
  // straight-line, so the signal structurally cannot be skipped by whichever
  // arm the load took.
  private reloadInto(entry: CacheEntry): void {
    const loaded = this.load(entry.projectDir, entry.cwd, entry.configFile);
    entry.lastWarning = loaded.warning;
    entry.lastError = loaded.error;
    if (loaded.state !== null) {
      this.log("info", pluginLoadLine(loaded.layers, loaded.state));
      const retired = entry.state;
      entry.state = loaded.state;
      this.serve(loaded.state);
      this.retire(retired, "reload", { entry, state: loaded.state });
    }
    // A reload can move the entry onto a compile no other entry carries, and
    // charges the views it reopened, once their predecessors are retired.
    this.fit(entry);
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
    this.log(
      "info",
      `config change detected for entry projectDir=${entry.projectDir} cwd=${entry.cwd}`,
    );
    this.reloadInto(entry);
  }

  get size(): number {
    return this.entries.size;
  }

  // [LAW:single-enforcer] One read path for "any session's view" used by
  // the debug protocol's introspection (`debug vars` / `segments` / `config`).
  // Reads existing views — does NOT open one, so debug introspection never
  // has the side effect of creating a fresh cache entry (with its own
  // SourceRegistry timers/watchers) tied to the daemon's own `process.cwd()`.
  // The most recently rendered session's, since `views` is kept in use order.
  // Null while no session's view is open; debug responses are empty in that
  // case by construction.
  latestView(): SessionView | null {
    return [...this.views.values()].at(-1) ?? null;
  }
}
