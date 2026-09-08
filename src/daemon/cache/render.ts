import fs from "node:fs";
import path from "node:path";
import type { RichText } from "@promptctl/rich-js";
import { buildNeededPrefixes } from "../render-payload.js";
import {
  loadConfig,
  validateConfig,
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
import {
  deriveActionValidators,
  registerStateValidator,
} from "../verbs/state-validators.js";
import {
  deriveConfigActionValidators,
  registerConfigValidator,
} from "../verbs/config-validators.js";
import { presetNames, presetRoot } from "../../config/presets.js";
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

// [LAW:one-source-of-truth] An entry owns the live DSL state for one (projectDir, cwd) tuple; the cap bounds the watchers and timers they hold.
const MAX_ENTRIES = 256;

// [LAW:single-enforcer] Cache identity/lifecycle deps only, not payload providers.
export interface RenderDeps {
  gitService: GitDataProvider;
  sessionState: SessionStateRW;
  watchers: WatcherRegistry;
}

// [LAW:no-ambient-temporal-coupling] The cache's outward lifecycle signal: a reload
// runs on the cache's own debounced schedule, so only it can say one completed.
// [LAW:locality-or-seam] A named bag, so a new observer is one field, not a
// constructor signature every caller re-counts.
export interface RenderCacheObservers {
  // Fires once per completed reload, success or failure alike, after the
  // entry's fields and watcher settle. Trusted non-throwing.
  readonly onReload?: (entry: ReloadedEntry) => void;
}

export type ReloadedEntry = Readonly<
  Pick<
    CacheEntry,
    | "projectDir"
    | "cwd"
    | "configFile"
    | "configFilePath"
    | "lastError"
    | "lastWarning"
  >
> & { readonly state: Readonly<Pick<DslRenderState, "config">> };

// [LAW:types-are-the-program] Never null — an entry can ALWAYS render: seeded
// with the bundled default, replaced by each config that loads, left as it was
// when one fails.
export interface DslRenderState {
  readonly config: ValidatedConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly compiled: CompiledConfig;
  readonly neededInputPaths: ReadonlySet<string>;
  readonly lastRenderCellsBySegment: Map<string, readonly RichText[]>;
  // [LAW:one-source-of-truth] Preset names whose tree the config FILE authors — what `.preset.customized` means. From the same raw parse as `config`.
  readonly authoredRoots: ReadonlySet<string>;
  // [LAW:single-enforcer] Disposed on swap/eviction with the SourceRegistry, so a reload never shadows the next config's keys.
  readonly validatorDisposers: ReadonlyArray<() => void>;
}

// [LAW:one-source-of-truth] A state is only ever replaced by a state: a failed
// load keeps rendering what we had. Errors are scoped to the cache key, so a
// broken config in repo A cannot pollute repo B.
// [LAW:one-type-per-behavior] `lastError` is load-fatal, `lastWarning` advisory.
export interface CacheEntry {
  projectDir: string;
  cwd: string;
  configFile: string | undefined;
  configFilePath: string | null;
  lastError: string | null;
  lastWarning: string | null;
  state: DslRenderState;
  watcher: WatcherHandle | null;
  // The key `watcher` was acquired under — the identity of its target set.
  watcherKey: string | null;
}

function cacheKey(
  projectDir: string,
  cwd: string,
  configFile: string | undefined,
): string {
  return projectDir + "\0" + cwd + "\0" + (configFile ?? "");
}

// [LAW:one-source-of-truth] `config` must be the MERGED tree: edit chrome
// materializes an explicit `presets.<n>.root`, so the validated tree would read
// every file as pristine.
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

// [LAW:dataflow-not-control-flow] One rule — nearest EXISTING ancestor plus the
// component below it — so the mkdir a first durable write performs is itself a
// reload trigger.
function nearestWatchTarget(candidate: string): {
  readonly dir: string;
  readonly name: string;
} {
  let name = path.basename(candidate);
  let dir = path.dirname(candidate);
  while (!fs.existsSync(dir)) {
    name = path.basename(dir);
    dir = path.dirname(dir);
  }
  return { dir, name };
}

// [LAW:single-enforcer] The resolver's own enumerator, so the watch set is what
// the next reload consults. The resolved file is watched by inode too, so an
// in-place write fires as well as a rename; equal sets spell equal keys.
function watchTargetsFor(
  entry: CacheEntry,
  resolvedPath: string | null,
): WatchTargets {
  const byDir = new Map<string, Set<string>>();
  for (const candidate of dslConfigCandidatePaths(
    entry.projectDir,
    entry.cwd,
    entry.configFile,
  )) {
    const { dir, name } = nearestWatchTarget(candidate);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir)!.add(name);
  }
  return {
    files: resolvedPath !== null ? [resolvedPath] : [],
    dirs: [...byDir.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dirPath, names]) => ({
        path: dirPath,
        filenames: [...names].sort(),
      })),
  };
}

// The warning channel is ONE string; an empty list of advisories is null.
function joinWarnings(parts: ReadonlyArray<string | null>): string | null {
  return parts.filter(Boolean).join("\n") || null;
}

// [LAW:types-are-the-program] A state XOR an error, never both, never neither.
type LoadOutcome = {
  readonly resolvedPath: string | null;
  readonly warning: string | null;
} & (
  | { readonly state: DslRenderState; readonly error: null }
  | { readonly state: null; readonly error: string }
);

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

    const loaded = this.loadFromDisk(projectDir, cwd, configFile);
    // [LAW:no-silent-failure] A config failing its FIRST load still yields a bar — the bundled default, with the error loud on the strip above it.
    const entry: CacheEntry = {
      projectDir,
      cwd,
      configFile,
      configFilePath: null,
      lastError: loaded.error,
      lastWarning: loaded.warning,
      state: loaded.state ?? this.buildState(cwd, null),
      watcher: null,
      watcherKey: null,
    };
    // [LAW:single-enforcer] Insert, bound, watch, then notify: from insertion
    // the entry is reachable for dispose, so a throwing observer cannot strand
    // a registry outside the map.
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (oldest !== undefined) {
        const [oldestKey, evicted] = oldest;
        evicted.state.registry.dispose();
        evicted.state.validatorDisposers.forEach((dispose) => dispose());
        evicted.watcher?.release();
        this.entries.delete(oldestKey);
      }
    }
    this.refreshWatcher(entry, loaded.resolvedPath);
    this.observers.onReload?.(entry);

    return entry;
  }

  // Re-populate `entry` from disk: success swaps a fresh state in, failure keeps
  // the prior one and sets lastError.
  // [LAW:single-enforcer] One publish point for "this reload completed",
  // straight-line so neither arm can skip it.
  private reloadInto(entry: CacheEntry): void {
    const loaded = this.loadFromDisk(
      entry.projectDir,
      entry.cwd,
      entry.configFile,
    );
    entry.lastWarning = loaded.warning;
    entry.lastError = loaded.error;
    if (loaded.state !== null) {
      // [LAW:single-enforcer] Dispose-before-swap, or the reload leaks handles.
      entry.state.registry.dispose();
      entry.state.validatorDisposers.forEach((dispose) => dispose());
      entry.state = loaded.state;
    }
    this.refreshWatcher(entry, loaded.resolvedPath);
    this.observers.onReload?.(entry);
  }

  // [LAW:effects-at-boundaries] Touches no entry, so the state it builds is never constructed-then-discarded.
  private loadFromDisk(
    projectDir: string,
    cwd: string,
    configFile: string | undefined,
  ): LoadOutcome {
    const resolution = resolveDslConfig(projectDir, cwd, configFile);
    const resolvedPath = resolution.kind === "file" ? resolution.path : null;

    // [LAW:dataflow-not-control-flow] Advisories run every load, independent of load success: a shadowed sibling matters even when nothing parsed.
    const advisories = [
      detectConfigCollisions(projectDir, cwd),
      configResolutionNotice(resolution),
    ];

    // [LAW:dataflow-not-control-flow] Any failure is the `error` arm; the caller's prior state stays untouched.
    let state: DslRenderState;
    try {
      state = this.buildState(cwd, resolvedPath);
    } catch (err) {
      return {
        resolvedPath,
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
      resolvedPath,
      warning: joinWarnings([...advisories, ...state.compiled.loadWarnings]),
      state,
      error: null,
    };
  }

  // [LAW:single-enforcer] One transaction: any failure disposes the partially-built registry, then rethrows so the caller keeps its prior state.
  private buildState(cwd: string, resolvedPath: string | null): DslRenderState {
    // [LAW:one-source-of-truth] Thread the source through so cross-ref diagnostics carry real line numbers; loadConfig already read the file.
    const {
      config: merged,
      raw,
      source,
    } = loadConfig(resolvedPath, DEFAULT_DSL_CONFIG);
    const config = validateConfig(merged, resolvedPath ?? "<default>", source);

    const store = new VariableStore();
    const registry = new SourceRegistry(
      store,
      config.globals.default_empty_value ?? "",
      this.deps.gitService,
      this.deps.sessionState,
    );

    let compiled: CompiledConfig;
    // [LAW:single-enforcer] Validators join the registry's construction transaction: any failure disposes every handle built so far.
    const validatorDisposers: Array<() => void> = [];
    try {
      compiled = registerDslConfig(config, registry, { cwd });
      // [LAW:one-source-of-truth] Merging before registration lets a trigger's literal "0" be absorbed into a picker's int page gate, not collide.
      for (const { key, spec } of deriveActionValidators(config)) {
        validatorDisposers.push(registerStateValidator(key, spec));
      }
      for (const { key, spec } of deriveConfigActionValidators(config)) {
        validatorDisposers.push(registerConfigValidator(key, spec));
      }
    } catch (err) {
      for (const dispose of validatorDisposers) dispose();
      registry.dispose();
      throw err;
    }

    // [LAW:one-source-of-truth] basePalette is NOT frozen here: one entry serves
    // many sessions and the effective theme is per-session, so the server
    // resolves it per render.
    return {
      config,
      store,
      registry,
      compiled,
      neededInputPaths: buildNeededPrefixes(config),
      lastRenderCellsBySegment: new Map<string, readonly RichText[]>(),
      validatorDisposers,
      authoredRoots: authoredRoots(merged, raw),
    };
  }

  // [LAW:single-enforcer] The watch target set is DERIVED from disk and rebinds
  // exactly when it differs, so no separate "did the path change" test can drift.
  private refreshWatcher(entry: CacheEntry, resolvedPath: string | null): void {
    entry.configFilePath = resolvedPath;
    const targets = watchTargetsFor(entry, resolvedPath);
    // [LAW:one-source-of-truth] WatcherRegistry keeps the FIRST acquire's targets, so the key must name the target set.
    const key = `config:${entry.projectDir}:${entry.cwd}:${entry.configFile ?? ""}:${JSON.stringify(targets)}`;
    if (entry.watcher !== null && entry.watcherKey === key) return;
    entry.watcher?.release();
    entry.watcherKey = key;
    entry.watcher = this.deps.watchers.acquire(key, targets, () =>
      this.onConfigChanged(entry),
    );
  }

  // [LAW:single-enforcer] One dispatcher per entry: it re-resolves its own chain, so a higher-precedence file appearing supersedes a lower one.
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

  // [LAW:single-enforcer] Reads existing entries only, so debug introspection never creates one (with its own timers/watchers) for the daemon's cwd.
  firstState(): DslRenderState | null {
    return this.entries.values().next().value?.state ?? null;
  }
}
