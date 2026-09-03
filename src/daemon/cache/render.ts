import fs from "node:fs";
import path from "node:path";
import type { RichText } from "@promptctl/rich-js";
import { buildNeededPrefixes } from "../render-payload.js";
import {
  loadConfig,
  validateConfig,
  resolveDslConfigPath,
  dslConfigCandidatePaths,
  detectConfigCollisions,
  mergeWithDefault,
  applySegmentPaletteOverrides,
  ConfigError,
} from "../../config/dsl-loader.js";
import type { ValidatedConfig } from "../../config/dsl-types.js";
import { DEFAULT_DSL_CONFIG } from "../../config/default-dsl-config.js";
import { registerDslConfig, type CompiledConfig } from "../../dsl/render.js";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../verbs/state-validators.js";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../verbs/config-validators.js";
import { loadOverrides } from "../config-overrides-store.js";
import { configOverridesPath } from "../paths.js";
import {
  applyPresetRootOpsOverrides,
  sanitizePersistedPresetOverride,
  sanitizePersistedPresetRootOps,
} from "../../config/presets.js";
import { VariableStore } from "../../var-system/store.js";
import { SourceRegistry } from "../../var-system/sources.js";
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
// owned data providers like the SessionUsageStore/git provider/etc. live in
// `payloadDeps` (server.ts) and feed `buildRenderPayload`; they are not
// part of cache identity or lifecycle.
export interface RenderDeps {
  gitService: GitDataProvider;
  sessionState: SessionStateRW;
  watchers: WatcherRegistry;
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

// [LAW:types-are-the-program] The observer's view of an entry: read-only,
// and without the watcher handle — `Readonly` cannot stop a method call, and
// `release()` is the one reach that would silently break the rebind
// invariant (a released-but-non-null watcher never rebinds). Omission is
// the only type that closes it.
export type ReloadedEntry = Readonly<Omit<CacheEntry, "watcher">>;

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
  readonly compiled: CompiledConfig;
  readonly neededInputPaths: ReadonlySet<string>;
  readonly lastRenderCellsBySegment: Map<string, readonly RichText[]>;
  // [LAW:one-source-of-truth] The accumulated-ops record this reload read
  // from the overrides file, sanitized against THIS config's declared
  // presets (sanitizePersistedPresetRootOps — never the raw file content: a
  // stale entry naming a preset from a different project must not surface
  // as "customized" here either) — the exact input
  // applyPresetRootOpsOverrides replayed into `config.presets[name].root`
  // above. Carried alongside the replayed config because the replay
  // CONSUMES the op count: by the time a preset's tree is spliced/
  // validated, nothing about it says how many ops (if any) produced it.
  // brandon-layout-edit-2gc.5 reads this per render (keyed by the active
  // preset name) to answer "does the bar's current arrangement differ from
  // what's literally in the user's file" without a second overrides read
  // (this entry rebuilds on the SAME watcher that rebuilds `config`, so the
  // two never drift).
  readonly presetRootOps: Readonly<Record<string, readonly string[]>>;
  // [LAW:single-enforcer] Disposers for the SessionState validators this config
  // installed (derived from its action table). Disposed on swap/eviction in the
  // same dispose-before-swap transaction as the SourceRegistry, so a reload
  // never leaks a stale writable-key entry or shadows the next config's keys.
  readonly validatorDisposers: ReadonlyArray<() => void>;
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
    // [LAW:single-enforcer] Insert before the first load: from the moment the
    // entry owns live handles it is reachable for eviction and dispose, so a
    // throwing observer cannot strand a registry outside the map, and a
    // reentrant getOrCreate for this key finds the entry under construction
    // rather than building a duplicate.
    this.entries.set(key, entry);
    this.reloadInto(entry);

    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.entries.get(oldest);
        // [LAW:single-enforcer] dispose the registry on eviction — it owns
        // timers, fs watchers, and git subscriptions. Dropping the entry
        // without dispose leaks every async handle the config declared. The
        // validator disposers free this entry's writable-key entries too.
        evicted?.state?.registry.dispose();
        evicted?.state?.validatorDisposers.forEach((dispose) => dispose());
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
  //
  // [LAW:single-enforcer] One publish point for "this reload completed":
  // loadFromDisk owns the outcome (it returns through more than one arm),
  // and this wrapper is the only caller, so the signal structurally cannot
  // be skipped by whichever arm a reload takes — or by an arm added later.
  private reloadInto(entry: CacheEntry): void {
    this.loadFromDisk(entry);
    this.observers.onReload?.(entry);
  }

  private loadFromDisk(entry: CacheEntry): void {
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

    // [LAW:single-enforcer] Dispose-before-swap: the old registry owns timers,
    // fs watchers, MobX reactions, and git subscriptions; the old validator
    // disposers own this entry's writable-key entries in the global registry.
    // Both are disposed in one step before the swap — dropping either reference
    // without disposing would leak handles or shadow the new config's keys.
    entry.state?.registry.dispose();
    entry.state?.validatorDisposers.forEach((dispose) => dispose());
    entry.lastError = null;
    entry.state = newState;
    // [LAW:dataflow-not-control-flow] Partial-load warnings (variable
    // declaration failures that didn't abort the load) flow through the same
    // warning channel as collision warnings, already set above. Append rather
    // than replace so both can be visible at once.
    if (newState.compiled.loadWarnings.length > 0) {
      const vw = newState.compiled.loadWarnings.join("\n");
      entry.lastWarning = entry.lastWarning
        ? entry.lastWarning + "\n" + vw
        : vw;
    }
    this.refreshWatcher(entry, resolvedPath);
  }

  // [LAW:single-enforcer] Construct the full new state — parsed config,
  // store, registry, compiled segments, palette — as one transaction. Any
  // failure inside disposes the partially-built registry so we don't leak
  // timers/watchers from a half-constructed reload, then rethrows so the
  // caller (loadFromDisk) preserves the prior `entry.state` unchanged.
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
    // [LAW:one-source-of-truth] Thread the source through to validateConfig so
    // cross-ref diagnostics on the daemon path carry real line numbers and the
    // authored-surface (root vs layout) discriminator works — the file is read
    // once inside loadConfig, not re-read here.
    const { config: merged, source } = loadConfig(
      resolvedPath,
      DEFAULT_DSL_CONFIG,
    );
    // [LAW:one-source-of-truth] The persistent config-overrides layer
    // (candybar-config-engine-71o.2) is a SECOND application of the SAME
    // mergeWithDefault cascade the user file already went through — no new
    // merge semantics, just one more layer at bundled-default < user-file <
    // overrides precedence (a `persist` write changes the DEFAULT; a session
    // pick still overrides it per-session via effective* resolution,
    // unchanged). Always applied, even when the overrides file is empty —
    // an empty overrides object merges as a no-op, so there is no
    // "has overrides?" branch [LAW:dataflow-not-control-flow]. One
    // loadOverrides read serves BOTH halves below (globals + segment-palette)
    // — the overrides file backs two different merge shapes, not two reads.
    const overrides = loadOverrides(configOverridesPath(), dlog);
    // [LAW:no-silent-failure] `preset` is a per-config domain riding a
    // machine-global overrides file (src/config/presets.ts —
    // sanitizePersistedPresetOverride) — a persisted pick from another
    // project's config must not fail THIS config's load. Every other
    // globals field is registry-static (palette/style/charset/…), so this
    // is the one field that needs sanitizing before the merge below.
    const sanitizedGlobalsOverride = sanitizePersistedPresetOverride(
      overrides.globals,
      merged.presets,
    );
    const withGlobalsOverrides = mergeWithDefault(
      { globals: sanitizedGlobalsOverride },
      merged,
    );
    // [LAW:one-source-of-truth] The segment-scoped half of the SAME overrides
    // file (candybar-config-engine-71o.6) — a later, narrower merge step, not
    // a second override layer: mergeWithDefault's `segments` cascade replaces
    // a named segment WHOLESALE, so a one-field palette override rides its
    // own overlay (applySegmentPaletteOverrides) against the already-merged
    // config instead, patching `palette` without dropping the segment's other
    // fields. Order versus the globals merge above doesn't matter — the two
    // touch disjoint parts of the config (`globals` vs `segments[name]`).
    const withOverrides = applySegmentPaletteOverrides(
      withGlobalsOverrides,
      overrides.segmentPalette,
    );
    // [LAW:no-silent-failure] Drop any entry naming a preset THIS config
    // never declared before replay ever sees it — the shared overrides file
    // outlives any one project's preset names (brandon-layout-edit-2gc.5 PR
    // review: without this, a stale entry from a DIFFERENT project reaches
    // applyPresetRootOpsOverrides -> presetRoot -> presetByName, which
    // throws for an undeclared name, failing this unrelated project's
    // ENTIRE render). Sanitized against `merged.presets` — the SAME config
    // sanitizePersistedPresetOverride checks `globals.preset` against, two
    // lines up, for the identical reason.
    const sanitizedPresetRootOps = sanitizePersistedPresetRootOps(
      overrides.presetRootOps,
      merged.presets,
    );
    // [LAW:one-source-of-truth] brandon-layout-edit-2gc.1's replay step —
    // the SAME "patch an already-merged config" cascade as the segment-
    // palette overlay above, one field over (a preset's `root` instead of a
    // segment's `palette`). Runs last so validateConfig's cross-ref walk
    // proves the OPS-PATCHED tree, not the pre-edit one — a structural edit
    // that referenced a segment removed by a later config change is caught
    // exactly like a hand-authored preset root naming the same segment would
    // be.
    const withPresetRootOps = applyPresetRootOpsOverrides(
      withOverrides,
      sanitizedPresetRootOps,
    );
    const config = validateConfig(
      withPresetRootOps,
      resolvedPath ?? "<default>",
      source,
    );

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

    let compiled: CompiledConfig;
    // [LAW:single-enforcer] Validators this config installs (one per menu page
    // key) are part of the same construction transaction as the registry: any
    // failure (registration, a duplicate-key throw) disposes every handle built
    // so far — registry AND already-installed validators — before rethrowing, so
    // loadFromDisk preserves the prior last-known-good with nothing half-installed.
    const validatorDisposers: Array<() => void> = [];
    try {
      // [LAW:one-source-of-truth] The action runtime reads session.id + current
      // picker values from registry.variableStore — the same store this entry's
      // registry declares into — so no store reference is threaded separately.
      compiled = registerDslConfig(config, registry, {
        cwd: entry.cwd,
      });
      // [LAW:one-source-of-truth] Derive the writable-key validators from the
      // config's action table (the sole interaction authority) through one
      // coherence merge (deriveActionValidators), then register them so the click
      // wire accepts the picker's ←/→/apply-close writes and every other action
      // write alike. Merging before registration lets a trigger's literal "0" be
      // absorbed into a picker's int page gate instead of colliding.
      // registerStateValidator throws on a duplicate baseline key — caught here to
      // roll the whole reload back.
      for (const { key, spec } of deriveActionValidators(config)) {
        validatorDisposers.push(registerStateValidator(key, spec));
      }
      // [LAW:one-source-of-truth] The `persist` action table's twin
      // derivation, registered through the SAME dispose-before-swap
      // transaction — a config's persistent-config-writable-key surface
      // lives and dies with this cache entry exactly like its SessionState
      // surface does.
      for (const { key, spec } of deriveConfigActionValidators(config)) {
        validatorDisposers.push(registerConfigValidator(key, spec));
      }
    } catch (err) {
      for (const dispose of validatorDisposers) dispose();
      registry.dispose();
      throw err;
    }

    // [LAW:one-source-of-truth] basePalette is NOT frozen here. One cache entry
    // serves many sessions, but the effective theme is per-session SessionState;
    // freezing the palette per entry would let the rendered colors diverge from
    // the session's chosen theme. The server resolves basePalette per render
    // from the effective theme (paletteForThemeName ∘ effectiveThemeName).
    return {
      config,
      store,
      registry,
      compiled,
      neededInputPaths: buildNeededPrefixes(config),
      lastRenderCellsBySegment: new Map<string, readonly RichText[]>(),
      validatorDisposers,
      presetRootOps: sanitizedPresetRootOps,
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
    //
    // [LAW:dataflow-not-control-flow] configOverridesPath() rides the SAME
    // candidate list, not a second watch branch: "reload rides the existing
    // watcher" (candybar-config-engine-71o.2) means a persistent config write
    // is just one more file in the resolution chain the loop below already
    // handles uniformly (existence-gated, watched via its parent dir so the
    // file's first-ever creation also triggers reload).
    const candidates = [
      ...dslConfigCandidatePaths(entry.projectDir, entry.cwd, entry.configFile),
      configOverridesPath(),
    ];
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
