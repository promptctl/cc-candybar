import fs from "node:fs";
import path from "node:path";
import {
  PaletteResolver,
  getThemePalette,
  type RichText,
} from "@promptctl/rich-js";
import { buildNeededPrefixes } from "../render-payload.js";
import {
  loadConfig,
  validateConfig,
  resolveDslConfigPath,
  dslConfigCandidatePaths,
  detectConfigCollisions,
  ConfigError,
} from "../../config/dsl-loader.js";
import type { ValidatedConfig } from "../../config/dsl-types.js";
import { registerDslConfig, type CompiledSegments } from "../../dsl/render.js";
import { VariableStore } from "../../var-system/store.js";
import { SourceRegistry } from "../../var-system/sources.js";
import { resolvePaletteName } from "../../themes/index.js";
import type { GitDataProvider } from "./git.js";
import type { SessionStateRW } from "../session-state.js";
import type { WatcherRegistry, WatcherHandle } from "./watchers.js";
import { dlog } from "../log.js";

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
// owned data providers like UsageProvider/TodayProvider/etc. live in
// `payloadDeps` (server.ts) and feed `buildRenderPayload`; they are not
// part of cache identity or lifecycle.
export interface RenderDeps {
  gitService: GitDataProvider;
  sessionState: SessionStateRW;
  watchers: WatcherRegistry;
}

// [LAW:types-are-the-program] The DSL render state for an entry is one
// optionally-null bundle, not five independently-optional fields. Either
// every field is populated (a render is possible) or all are null (parse
// failed and we never had a valid config) — the type makes any other
// combination unrepresentable.
//
// `neededInputPaths` is the layout-reachable closure of input paths,
// computed once at registration. The daemon's payload builder reads it
// to gate provider invocation.
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
  readonly compiled: CompiledSegments;
  readonly basePalette: PaletteResolver;
  readonly neededInputPaths: ReadonlySet<string>;
  readonly lastRenderCellsBySegment: Map<string, readonly RichText[]>;
}

// [LAW:one-source-of-truth] Each entry tracks the last *valid* DSL state +
// the last error AND last warning from a reload attempt. We never overwrite
// a valid state with nothing — a parse error means "show the warning but
// keep rendering with what we had". Errors are scoped to the cache key
// (which includes cwd / projectDir) so a broken config in repo A cannot
// pollute repo B.
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
// is the (`~`-expanded) value of the client's `--config` flag — present
// when overriding the standard precedence chain, undefined otherwise. The
// type carries the optionality where it actually exists.
export interface CacheEntry {
  projectDir: string;
  cwd: string;
  configFile: string | undefined;
  configFilePath: string | null;
  lastError: string | null;
  lastWarning: string | null;
  state: DslRenderState | null;
  watcher: WatcherHandle | null;
}

// [LAW:one-source-of-truth] Cache key includes every input that affects DSL
// resolution: projectDir, cwd, and the resolved `--config` file (if provided).
// `projectDir`/`cwd` are real strings by construction (validated upstream);
// `configFile` collapses absent → empty in the key, distinct from any real path.
function cacheKey(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
): string {
  return projectDir + "\0" + cwd + "\0" + (configFile ?? "");
}

export class RenderCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly deps: RenderDeps;
  private readonly maxEntries: number;

  constructor(deps: RenderDeps, opts: { maxEntries?: number } = {}) {
    this.deps = deps;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  }

  // [LAW:dataflow-not-control-flow] One uniform shape: every entry has the
  // same fields, populated to nulls when reload failed. The renderer reads
  // the data; no special-case branches between "first load", "reload",
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

    const entry: CacheEntry = {
      projectDir,
      cwd,
      configFile,
      configFilePath: null,
      lastError: null,
      lastWarning: null,
      state: null,
      watcher: null,
    };
    this.reloadInto(entry);
    this.entries.set(key, entry);

    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.entries.get(oldest);
        // [LAW:single-enforcer] dispose the registry on eviction — it owns
        // timers, fs watchers, and git subscriptions. Dropping the entry
        // without dispose leaks every async handle the config declared.
        evicted?.state?.registry.dispose();
        evicted?.watcher?.release();
        this.entries.delete(oldest);
      }
    }

    return entry;
  }

  // Populate (or re-populate) `entry` from the current state of disk.
  //
  // - Parse success: dispose the prior state (if any), build fresh store +
  //   registry + compiled, clear lastError.
  // - Parse failure: keep the prior state, set lastError. First-time
  //   failures leave state null (startup-error case).
  //
  // [LAW:single-enforcer] hot-reload contract: any reload that produces a
  // new DslConfig disposes the old SourceRegistry before constructing a new
  // one. The registry owns timers, watchers, MobX reactions, and git
  // subscriptions — dropping it without dispose leaks every handle.
  private reloadInto(entry: CacheEntry): void {
    const resolvedPath = resolveDslConfigPath(
      entry.projectDir,
      entry.cwd,
      entry.configFile,
    );

    // [LAW:dataflow-not-control-flow] Collision detection runs every reload,
    // independent of load success — even if the .json5 fails to parse, the
    // user still wants to know they have a shadowed .json sibling. Pure
    // file-existence checks, so cheap. The watcher already monitors every
    // candidate path, so creating/removing a duplicate triggers reload and
    // re-detection automatically; nothing else needs to invalidate this.
    entry.lastWarning = detectConfigCollisions(entry.projectDir, entry.cwd);

    // [LAW:dataflow-not-control-flow] One uniform shape: build the new
    // state into locals first, dispose the old registry ONLY after every
    // construction step has succeeded. A failure at any step — parse,
    // registration, palette resolution — leaves `entry.state` and
    // `entry.state.registry` untouched, so the daemon keeps rendering the
    // last-known-good config plus a warning icon (composeWithDiagnostics
    // reads `entry.lastError` and `entry.lastWarning`). The
    // "[LAW:single-enforcer] dispose before swap" contract holds for the
    // swap; the construction is upstream of it.
    let newState: DslRenderState;
    try {
      newState = this.buildState(entry, resolvedPath);
    } catch (err) {
      entry.lastError =
        err instanceof ConfigError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // Watch the broken file (and its sibling candidates) so an in-place
      // save OR a higher-precedence file appearing recovers.
      this.refreshWatcher(entry, resolvedPath);
      return;
    }

    // [LAW:single-enforcer] Dispose-before-swap: the old registry owns
    // timers, fs watchers, MobX reactions, and git subscriptions. Dropping
    // the reference without dispose() would leak every handle.
    entry.state?.registry.dispose();
    entry.lastError = null;
    entry.state = newState;
    this.refreshWatcher(entry, resolvedPath);
  }

  // [LAW:single-enforcer] Construct the full new state — parsed config,
  // store, registry, compiled segments, palette — as one transaction. Any
  // failure inside disposes the partially-built registry so we don't leak
  // timers/watchers from a half-constructed reload, then rethrows so the
  // caller (reloadInto) preserves the prior `entry.state` unchanged.
  private buildState(
    entry: CacheEntry,
    resolvedPath: string | null,
  ): DslRenderState {
    // [LAW:dataflow-not-control-flow][LAW:single-enforcer] Three primitives,
    // straight-line composition. `loadConfig(null)` returns the bundled
    // default (uniform merge against empty raw); `validateConfig` is the
    // sole producer of `ValidatedConfig`. The renderer accepts only
    // `ValidatedConfig`, so the compiler enforces the chain — there is no
    // "skip validate" path that typechecks downstream.
    const merged = loadConfig(resolvedPath);
    const config = validateConfig(merged, resolvedPath ?? "<default>");

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
      this.deps.gitService,
      this.deps.sessionState,
    );

    let compiled: CompiledSegments;
    try {
      // [LAW:locality-or-seam] Pass the store so the config's `widget`
      // references can read session.id + current picker values from the same
      // source the rest of the render reads.
      compiled = registerDslConfig(config, registry, {
        cwd: entry.cwd,
        store,
      });
    } catch (err) {
      registry.dispose();
      throw err;
    }

    const paletteName = resolvePaletteName(
      config.globals.palette ?? "textual-dark",
    );
    const palette = getThemePalette(paletteName);
    if (palette === null) {
      // [LAW:single-enforcer] The loader validates palette names against
      // the resolver's set; an unresolvable name here is registry/resolver
      // drift, not user error.
      registry.dispose();
      throw new Error(
        `Palette "${paletteName}" did not resolve in the theme registry`,
      );
    }

    return {
      config,
      store,
      registry,
      compiled,
      basePalette: new PaletteResolver(palette),
      neededInputPaths: buildNeededPrefixes(config),
      lastRenderCellsBySegment: new Map<string, readonly RichText[]>(),
    };
  }

  // [LAW:single-enforcer] One watcher-rebind decision per reload. If the
  // resolved path changed (including null↔non-null transitions), or no
  // watcher is currently held, install a fresh watcher set keyed by the
  // current resolved path (or `<none>` when nothing exists). The "watch all
  // candidates when no file exists" behavior lives in rebindWatcher.
  private refreshWatcher(entry: CacheEntry, resolvedPath: string | null): void {
    if (resolvedPath !== entry.configFilePath || entry.watcher === null) {
      entry.configFilePath = resolvedPath;
      this.rebindWatcher(entry, resolvedPath);
    }
  }

  private rebindWatcher(entry: CacheEntry, targetPath: string | null): void {
    if (entry.watcher) {
      entry.watcher.release();
      entry.watcher = null;
    }
    // [LAW:dataflow-not-control-flow] Two outcomes from one rule:
    //   resolved path exists → watch THAT file + its parent dir (catches
    //     in-place writes and atomic-rename writes that replace the inode)
    //   no resolved path     → watch EVERY candidate's parent dir so the
    //     creation of any file in the resolution chain triggers reload.
    // Either way the watcher set is built from a single list of (dir,
    // filename-filter) tuples; the only variability is whether the
    // currently-resolved file is also added to `files` for inode-level
    // watching.
    // [LAW:dataflow-not-control-flow] fs.watch on a non-existent directory
    // throws; on a fresh install $XDG_CONFIG_HOME/cc-candybar doesn't exist
    // yet. Filter candidates to those whose parent directory exists *at
    // this moment* — that's the bounded set of locations we can usefully
    // watch. (A user creating the XDG dir later would only get hot-reload
    // for the project-local / cwd locations until the daemon next builds
    // an entry; this is a documented limitation, not a contract violation.)
    // [LAW:single-enforcer] Same enumerator the resolver uses, so the watcher
    // covers the exact same set of paths the next reload would consult — a
    // `--config` override collapses to one candidate; absent, the precedence
    // chain unfolds in full.
    const candidates = dslConfigCandidatePaths(
      entry.projectDir,
      entry.cwd,
      entry.configFile,
    );
    const dirSet = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const dir = path.dirname(candidate);
      if (!fs.existsSync(dir)) continue;
      const base = path.basename(candidate);
      if (!dirSet.has(dir)) dirSet.set(dir, new Set());
      dirSet.get(dir)!.add(base);
    }
    const dirs = [...dirSet.entries()].map(([dirPath, names]) => ({
      path: dirPath,
      filenames: [...names],
    }));

    // [LAW:single-enforcer] Watcher keys are per-cache-entry, not per-file.
    // WatcherRegistry.acquire() is share-by-key — multiple entries that
    // resolve to the same config file would otherwise share one watcher
    // slot whose `onInvalidate` is overwritten by the last acquire, and
    // earlier entries would never reload on file changes. Including
    // (projectDir, cwd, configFile) in every key guarantees each entry owns
    // its own watcher slot bound to its own reload callback.
    const key = `config:${entry.projectDir}:${entry.cwd}:${entry.configFile ?? ""}:${targetPath ?? "<none>"}`;

    entry.watcher = this.deps.watchers.acquire(
      key,
      {
        files: targetPath !== null ? [targetPath] : [],
        dirs,
      },
      () => this.onConfigChanged(entry),
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

  // [LAW:single-enforcer] One read path for "any populated state" used by
  // the debug protocol's introspection (`debug vars` / `segments` / `config`).
  // Iterates existing entries — does NOT call getOrCreate, so debug
  // introspection never has the side effect of creating a fresh cache entry
  // (with its own SourceRegistry timers/watchers) tied to the daemon's own
  // `process.cwd()`. Returns null when the cache has no successfully-loaded
  // entry; debug responses are empty in that case by construction.
  firstPopulatedState(): DslRenderState | null {
    for (const entry of this.entries.values()) {
      if (entry.state !== null) return entry.state;
    }
    return null;
  }
}
