import path from "node:path";
import { PowerlineRenderer } from "../../powerline";
import {
  loadConfigStrict,
  resolveConfigPathFromArgs,
  type PowerlineConfig,
} from "../../config/loader";
import type { GitService } from "../../segments/git";
import type { UsageProvider } from "../../segments/session";
import type { SessionStateRW } from "../session-state";
import type { WatcherRegistry, WatcherHandle } from "./watchers";
import { dlog } from "../log";

// Capacity sized for "many concurrent sessions in many repos". Each entry is
// a renderer + parsed config (~10-50KB), so 256 entries ≈ a few MB resident.
// LRU evicts when over the cap.
const MAX_ENTRIES = 256;

export interface RenderDeps {
  gitService: GitService;
  usageProvider: UsageProvider;
  sessionState: SessionStateRW;
  watchers: WatcherRegistry;
}

// [LAW:one-source-of-truth] Each entry tracks the last *valid* config + the
// last error from a reload attempt. We never overwrite a valid config with
// nothing — a parse error means "show the warning but keep rendering with
// what we had". Errors are scoped to the cache key (which includes cwd /
// projectDir) so a broken config in repo A cannot pollute repo B's render.
export interface CacheEntry {
  args: string[];
  projectDir: string | undefined;
  cwd: string | undefined;
  configFilePath: string | null;
  lastValidConfig: PowerlineConfig | null;
  lastError: string | null;
  renderer: PowerlineRenderer | null;
  watcher: WatcherHandle | null;
}

// [LAW:one-source-of-truth] Cache key includes every input to loadConfigStrict.
// Null-separator avoids ambiguity from args containing whitespace or pipes.
function cacheKey(args: string[], projectDir?: string, cwd?: string): string {
  return args.join("\0") + "\0" + (projectDir ?? "") + "\0" + (cwd ?? "");
}

export class RenderCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly deps: RenderDeps;

  constructor(deps: RenderDeps) {
    this.deps = deps;
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
    const key = cacheKey(args, projectDir, cwd);
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
      lastValidConfig: null,
      lastError: null,
      renderer: null,
      watcher: null,
    };
    this.reloadInto(entry);
    this.entries.set(key, entry);

    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.entries.get(oldest);
        evicted?.watcher?.release();
        this.entries.delete(oldest);
      }
    }

    return entry;
  }

  // Populate (or re-populate) `entry` from the current state of disk + args.
  // - On parse success: replaces lastValidConfig + renderer, clears lastError
  // - On parse failure: keeps the prior lastValidConfig + renderer, sets
  //   lastError. First-time failures leave them null (startup-error case).
  // Also (re)acquires a watcher on the resolved config file so subsequent
  // edits trigger reload.
  private reloadInto(entry: CacheEntry): void {
    let result: { config: PowerlineConfig; configFilePath: string | null };
    try {
      result = loadConfigStrict(entry.args, entry.projectDir, entry.cwd);
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      // Resolve the path independently so we can watch the broken file for
      // fixes — without this, a startup-error entry has no watcher and would
      // never recover. The parse error is *the* signal we want to react to.
      const resolvedPath = resolveConfigPathFromArgs(
        entry.args,
        entry.projectDir,
        entry.cwd,
      );
      if (
        resolvedPath !== entry.configFilePath ||
        (entry.watcher === null && resolvedPath !== null)
      ) {
        entry.configFilePath = resolvedPath;
        this.rebindWatcher(entry, resolvedPath);
      }
      return;
    }

    entry.lastError = null;
    entry.lastValidConfig = result.config;
    entry.renderer = new PowerlineRenderer(result.config, {
      gitService: this.deps.gitService,
      usageProvider: this.deps.usageProvider,
      sessionState: this.deps.sessionState,
    });

    // If the resolved path changed (e.g. user created a higher-precedence
    // file), rebind to the new path. If it didn't change, this is a no-op
    // beyond bumping the watcher's LRU position.
    if (result.configFilePath !== entry.configFilePath) {
      entry.configFilePath = result.configFilePath;
      this.rebindWatcher(entry, result.configFilePath);
    } else if (entry.watcher === null && result.configFilePath !== null) {
      // First successful load — establish the watcher.
      this.rebindWatcher(entry, result.configFilePath);
    }
  }

  private rebindWatcher(entry: CacheEntry, targetPath: string | null): void {
    if (entry.watcher) {
      entry.watcher.release();
      entry.watcher = null;
    }
    if (!targetPath) return;
    // [LAW:dataflow-not-control-flow] Watch BOTH the file and its parent
    // directory. fs.watch on the file alone is bound to its inode — atomic-
    // rename writes (sed -i, vim :w, most editors) replace the inode and
    // leave the watcher bound to a dead one. The parent-dir watcher fires
    // on rename-over-write because it sees the dirent change. The filename
    // filter avoids noise from siblings (e.g. ~/.claude/ has high churn).
    // After fire → reloadInto → rebindWatcher: a fresh file watcher binds
    // to the new inode for the next in-place write.
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    entry.watcher = this.deps.watchers.acquire(
      `config:${targetPath}`,
      {
        files: [targetPath],
        dirs: [{ path: dir, filenames: [base] }],
      },
      () => this.onConfigChanged(targetPath),
    );
  }

  // Fan out a config-file change to every cache entry that resolved to it.
  // Each entry re-runs loadConfigStrict so a project-local file changing
  // updates only sessions that resolved to that file, while a global
  // ~/.claude/cc-candybar.json change updates everyone who falls through to it.
  private onConfigChanged(changedPath: string): void {
    dlog("info", `config changed: ${changedPath} — reloading affected entries`);
    for (const entry of this.entries.values()) {
      if (entry.configFilePath === changedPath) {
        this.reloadInto(entry);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
