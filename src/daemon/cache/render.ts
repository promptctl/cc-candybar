import { PowerlineRenderer } from "../../powerline";
import { loadConfigFromCLI } from "../../config/loader";
import type { GitService } from "../../segments/git";
import type { UsageProvider } from "../../segments/session";
import type { ToolbarStateReader } from "../toolbar-state";
import type { ThemeStateReader } from "../theme-state";

const MAX_ENTRIES = 16;

export interface RenderDeps {
  gitService: GitService;
  usageProvider: UsageProvider;
  toolbarState: ToolbarStateReader;
  themeState: ThemeStateReader;
}

interface CacheEntry {
  config: ReturnType<typeof loadConfigFromCLI>;
  renderer: PowerlineRenderer;
}

// [LAW:one-source-of-truth] Cache key includes every input to loadConfigFromCLI.
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

    const config = loadConfigFromCLI(args, projectDir, cwd);
    const renderer = new PowerlineRenderer(config, {
      gitService: this.deps.gitService,
      usageProvider: this.deps.usageProvider,
      toolbarState: this.deps.toolbarState,
      themeState: this.deps.themeState,
    });
    const entry: CacheEntry = { config, renderer };

    this.entries.set(key, entry);
    // Evict oldest entry if over limit.
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

    return entry;
  }

  clearAll(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
