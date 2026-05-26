import path from "node:path";
import { PaletteResolver } from "@promptctl/rich-js";
import {
  loadDslConfig,
  resolveDslConfigPath,
  dslConfigCandidatePaths,
  ConfigError,
} from "../../config/dsl-loader.js";
import { DEFAULT_DSL_CONFIG } from "../../config/default-dsl-config.js";
import type { DslConfig } from "../../config/dsl-types.js";
import { registerDslConfig, type CompiledSegments } from "../../dsl/render.js";
import { VariableStore } from "../../var-system/store.js";
import { SourceRegistry } from "../../var-system/sources.js";
import { resolvePaletteName } from "../../themes/index.js";
import { getThemePalette } from "../../themes/palette-registry.js";
import type { GitDataProvider } from "./git.js";
import type { SessionStateRW } from "../session-state.js";
import type { WatcherRegistry, WatcherHandle } from "./watchers.js";
import { dlog } from "../log.js";

// [LAW:one-source-of-truth] Each cache entry owns the live DSL state for a
// (args, projectDir, cwd) tuple: the parsed config, the variable store +
// registry it was registered against, the compiled segment closures, and
// the resolved base palette. registerDslConfig + renderDslLine are the
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
// `lastRenderBySegment` is the per-segment standalone ANSI text sink that
// renderDslLine writes on each render. The map identity is stable for the
// lifetime of the entry (renderDslLine clears + repopulates it in place),
// so the debug projection holds a long-lived reference. A segment hidden
// by `when` is absent from the map — its presence in the keys is the
// "this segment rendered" signal.
export interface DslRenderState {
  readonly config: DslConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly compiled: CompiledSegments;
  readonly basePalette: PaletteResolver;
  readonly lastRenderBySegment: Map<string, string>;
}

// [LAW:one-source-of-truth] Each entry tracks the last *valid* DSL state +
// the last error from a reload attempt. We never overwrite a valid state
// with nothing — a parse error means "show the warning but keep rendering
// with what we had". Errors are scoped to the cache key (which includes
// cwd / projectDir) so a broken config in repo A cannot pollute repo B.
export interface CacheEntry {
  args: string[];
  projectDir: string | undefined;
  cwd: string | undefined;
  configFilePath: string | null;
  lastError: string | null;
  state: DslRenderState | null;
  watcher: WatcherHandle | null;
}

// [LAW:one-source-of-truth] Cache key includes every input that affects DSL
// resolution. Args is intentionally *excluded* — bzh.2 retired the CLI
// override flag apparatus, so args no longer influence config resolution
// or rendering. Including it would let a legacy client churn the LRU by
// varying flags that the daemon now ignores, creating duplicate entries
// (each with their own SourceRegistry timers/watchers) for the same
// behavior. The signature still threads `args` (the wire protocol carries
// it) but the value is dropped at the boundary.
function cacheKey(projectDir?: string, cwd?: string): string {
  return (projectDir ?? "") + "\0" + (cwd ?? "");
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
    args: string[],
    projectDir: string | undefined,
    cwd: string | undefined,
  ): CacheEntry {
    const key = cacheKey(projectDir, cwd);
    const existing = this.entries.get(key);
    if (existing) {
      // Move to end (most recently used) for LRU eviction.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }

    const entry: CacheEntry = {
      args,
      projectDir,
      cwd,
      configFilePath: null,
      lastError: null,
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
    const resolvedPath = resolveDslConfigPath(entry.projectDir, entry.cwd);

    // [LAW:dataflow-not-control-flow] One uniform shape: build the new
    // state into locals first, dispose the old registry ONLY after every
    // construction step has succeeded. A failure at any step — parse,
    // registration, palette resolution — leaves `entry.state` and
    // `entry.state.registry` untouched, so the daemon keeps rendering the
    // last-known-good config plus a warning icon (composeWithError reads
    // `entry.lastError`). The "[LAW:single-enforcer] dispose before swap"
    // contract holds for the swap; the construction is upstream of it.
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
    const config: DslConfig =
      resolvedPath !== null ? loadDslConfig(resolvedPath) : DEFAULT_DSL_CONFIG;

    const store = new VariableStore();
    // [LAW:single-enforcer] Inject the daemon's shared GitDataProvider so
    // every config's `kind: "git"` declarations route through one cache +
    // watcher pool (rather than each registry standing up its own). The
    // sessionState injection makes `kind: "state"` variables read/write the
    // same per-session store the click verbs mutate.
    const registry = new SourceRegistry(
      store,
      "",
      this.deps.gitService,
      this.deps.sessionState,
    );

    let compiled: CompiledSegments;
    try {
      compiled = registerDslConfig(config, registry, { cwd: entry.cwd });
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
      lastRenderBySegment: new Map<string, string>(),
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
    const candidates = dslConfigCandidatePaths(entry.projectDir, entry.cwd);
    const dirSet = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const dir = path.dirname(candidate);
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
    // (projectDir, cwd) in every key guarantees each entry owns its own
    // watcher slot bound to its own reload callback.
    const key = `config:${entry.projectDir ?? ""}:${entry.cwd ?? ""}:${targetPath ?? "<none>"}`;

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
      `config change detected for entry projectDir=${entry.projectDir ?? "<none>"} cwd=${entry.cwd ?? "<none>"}`,
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
