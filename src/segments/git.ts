import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { debug } from "../utils/logger";
import { CacheManager } from "../utils/cache";

const execAsync = promisify(exec);

export interface GitInfo {
  branch: string;
  status: "clean" | "dirty" | "conflicts";
  ahead: number;
  behind: number;
  sha?: string;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  conflicts?: number;
  operation?: string;
  tag?: string;
  timeSinceCommit?: number;
  stashCount?: number;
  upstream?: string;
  repoName?: string;
  isWorktree?: boolean;
}

export class GitService {
  private memoryCache: Map<
    string,
    { data: GitInfo | null; timestamp: number }
  > = new Map();
  private readonly CACHE_TTL = 1000;
  private lastGitStateCache: Map<string, string> = new Map();

  private async hasGitChanged(gitDir: string): Promise<boolean> {
    try {
      const indexPath = path.join(gitDir, ".git", "index");
      const headPath = path.join(gitDir, ".git", "HEAD");

      const [indexStat, headStat] = await Promise.all([
        fs.promises.stat(indexPath).catch(() => null),
        fs.promises.stat(headPath).catch(() => null),
      ]);

      const indexTime = indexStat?.mtime.getTime() || 0;
      const headTime = headStat?.mtime.getTime() || 0;
      const stateKey = `${indexTime}-${headTime}`;

      const lastStateKey = this.lastGitStateCache.get(gitDir);

      if (lastStateKey === stateKey) {
        debug(`Git state unchanged for ${gitDir}, extending cache`);
        return false;
      }

      this.lastGitStateCache.set(gitDir, stateKey);
      debug(`Git state changed for ${gitDir}, invalidating cache`);
      return true;
    } catch (error) {
      debug(`Error checking git state for ${gitDir}:`, error);
      return true;
    }
  }

  private isGitRepo(workingDir: string): boolean {
    try {
      return fs.existsSync(path.join(workingDir, ".git"));
    } catch {
      return false;
    }
  }

  async getGitInfo(
    workingDir: string,
    options: {
      showSha?: boolean;
      showWorkingTree?: boolean;
      showOperation?: boolean;
      showTag?: boolean;
      showTimeSinceCommit?: boolean;
      showStashCount?: boolean;
      showUpstream?: boolean;
      showRepoName?: boolean;
    } = {},
    projectDir?: string
  ): Promise<GitInfo | null> {
    const gitDir =
      projectDir && this.isGitRepo(projectDir) ? projectDir : workingDir;

    const optionsKey = JSON.stringify(options);
    const cacheKey = `${gitDir}:${optionsKey}`;
    const now = Date.now();

    if (!this.isGitRepo(gitDir)) {
      return null;
    }

    const memCached = this.memoryCache.get(cacheKey);
    if (memCached && now - memCached.timestamp < this.CACHE_TTL) {
      debug(`Using memory cached git info for ${gitDir}`);
      return memCached.data;
    }

    const diskCached = await CacheManager.getGitCache(gitDir);
    const gitChanged = await this.hasGitChanged(gitDir);
    const dynamicTTL = gitChanged ? this.CACHE_TTL : this.CACHE_TTL * 10;

    if (diskCached && now - (Date.now() - 100) < dynamicTTL) {
      this.memoryCache.clear();
      this.memoryCache.set(cacheKey, { data: diskCached, timestamp: now });
      debug(`Using CacheManager disk cached git info for ${gitDir}`);
      return diskCached;
    }

    try {
      const [branch, status, aheadBehind] = await Promise.all([
        this.getBranchAsync(gitDir),
        this.getStatusAsync(gitDir),
        this.getAheadBehindAsync(gitDir),
      ]);

      const result: GitInfo = {
        branch: branch || "detached",
        status,
        ahead: aheadBehind.ahead,
        behind: aheadBehind.behind,
      };

      const optionalOperations: Record<string, Promise<any>> = {};

      if (options.showSha) {
        optionalOperations.sha = this.getShaAsync(gitDir);
      }

      if (options.showWorkingTree) {
        optionalOperations.workingTree = this.getWorkingTreeCountsAsync(gitDir);
      }

      if (options.showTag) {
        optionalOperations.tag = this.getNearestTagAsync(gitDir);
      }

      if (options.showTimeSinceCommit) {
        optionalOperations.timeSinceCommit =
          this.getTimeSinceLastCommitAsync(gitDir);
      }

      if (options.showStashCount) {
        optionalOperations.stashCount = this.getStashCountAsync(gitDir);
      }

      if (options.showUpstream) {
        optionalOperations.upstream = this.getUpstreamAsync(gitDir);
      }

      if (options.showRepoName) {
        optionalOperations.repoName = this.getRepoNameAsync(gitDir);
      }

      const optionalResults = await Promise.allSettled(
        Object.entries(optionalOperations).map(async ([key, promise]) => ({
          key,
          value: await promise,
        }))
      );

      const resultMap = new Map<string, any>();
      optionalResults.forEach((result) => {
        if (result.status === "fulfilled") {
          resultMap.set(result.value.key, result.value.value);
        }
      });

      if (options.showSha) {
        result.sha = resultMap.get("sha") || undefined;
      }

      if (options.showWorkingTree) {
        const counts = resultMap.get("workingTree");
        if (counts) {
          result.staged = counts.staged;
          result.unstaged = counts.unstaged;
          result.untracked = counts.untracked;
          result.conflicts = counts.conflicts;
        }
      }

      if (options.showOperation) {
        result.operation = this.getOngoingOperation(gitDir) || undefined;
      }

      if (options.showTag) {
        result.tag = resultMap.get("tag") || undefined;
      }

      if (options.showTimeSinceCommit) {
        result.timeSinceCommit = resultMap.get("timeSinceCommit") || undefined;
      }

      if (options.showStashCount) {
        result.stashCount = resultMap.get("stashCount") || 0;
      }

      if (options.showUpstream) {
        result.upstream = resultMap.get("upstream") || undefined;
      }

      if (options.showRepoName) {
        result.repoName = resultMap.get("repoName") || undefined;
        result.isWorktree = this.isWorktree(gitDir);
      }

      this.memoryCache.clear();
      this.memoryCache.set(cacheKey, { data: result, timestamp: now });
      await CacheManager.setGitCache(gitDir, result);

      CacheManager.cleanupOldCache().catch(() => {});

      return result;
    } catch {
      this.memoryCache.set(cacheKey, { data: null, timestamp: now });
      return null;
    }
  }

  private async getWorkingTreeCountsAsync(workingDir: string): Promise<{
    staged: number;
    unstaged: number;
    untracked: number;
    conflicts: number;
  }> {
    try {
      const result = await execAsync("git status --porcelain", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const gitStatus = result.stdout;

      let staged = 0;
      let unstaged = 0;
      let untracked = 0;
      let conflicts = 0;

      if (!gitStatus.trim()) {
        return { staged, unstaged, untracked, conflicts };
      }

      const lines = gitStatus.split("\n");
      for (const line of lines) {
        if (!line || line.length < 2) continue;
        const indexStatus = line.charAt(0);
        const worktreeStatus = line.charAt(1);

        if (indexStatus === "?" && worktreeStatus === "?") {
          untracked++;
          continue;
        }

        const statusPair = indexStatus + worktreeStatus;
        if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(statusPair)) {
          conflicts++;
          continue;
        }

        if (indexStatus !== " " && indexStatus !== "?") {
          staged++;
        }
        if (worktreeStatus !== " " && worktreeStatus !== "?") {
          unstaged++;
        }
      }

      return { staged, unstaged, untracked, conflicts };
    } catch (error) {
      debug(`Git working tree counts failed in ${workingDir}:`, error);
      return { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
    }
  }

  private async getShaAsync(workingDir: string): Promise<string | null> {
    try {
      const result = await execAsync("git rev-parse --short=7 HEAD", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const sha = result.stdout.trim();

      return sha || null;
    } catch {
      return null;
    }
  }

  private getOngoingOperation(workingDir: string): string | null {
    try {
      const gitDir = path.join(workingDir, ".git");

      if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return "MERGE";
      if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")))
        return "CHERRY-PICK";
      if (fs.existsSync(path.join(gitDir, "REVERT_HEAD"))) return "REVERT";
      if (fs.existsSync(path.join(gitDir, "BISECT_LOG"))) return "BISECT";
      if (
        fs.existsSync(path.join(gitDir, "rebase-merge")) ||
        fs.existsSync(path.join(gitDir, "rebase-apply"))
      )
        return "REBASE";

      return null;
    } catch {
      return null;
    }
  }

  private async getNearestTagAsync(workingDir: string): Promise<string | null> {
    try {
      const result = await execAsync("git describe --tags --abbrev=0", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const tag = result.stdout.trim();

      return tag || null;
    } catch {
      return null;
    }
  }

  private async getTimeSinceLastCommitAsync(
    workingDir: string
  ): Promise<number | null> {
    try {
      const result = await execAsync("git log -1 --format=%ct", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const timestamp = result.stdout.trim();

      if (!timestamp) return null;

      const commitTime = parseInt(timestamp) * 1000;
      const now = Date.now();
      return Math.floor((now - commitTime) / 1000);
    } catch {
      return null;
    }
  }

  private async getStashCountAsync(workingDir: string): Promise<number> {
    try {
      const result = await execAsync("git stash list", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const stashList = result.stdout.trim();

      if (!stashList) return 0;
      return stashList.split("\n").length;
    } catch {
      return 0;
    }
  }

  private async getUpstreamAsync(workingDir: string): Promise<string | null> {
    try {
      const result = await execAsync("git rev-parse --abbrev-ref @{u}", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const upstream = result.stdout.trim();

      return upstream || null;
    } catch {
      return null;
    }
  }

  private async getRepoNameAsync(workingDir: string): Promise<string | null> {
    try {
      const result = await execAsync("git config --get remote.origin.url", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const remoteUrl = result.stdout.trim();

      if (!remoteUrl) return path.basename(workingDir);

      const match = remoteUrl.match(/\/([^/]+?)(\.git)?$/);
      return match?.[1] || path.basename(workingDir);
    } catch {
      return path.basename(workingDir);
    }
  }

  private isWorktree(workingDir: string): boolean {
    try {
      const gitDir = path.join(workingDir, ".git");
      if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async getBranchAsync(workingDir: string): Promise<string | null> {
    try {
      const result = await execAsync("git branch --show-current", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const branch = result.stdout.trim();
      if (branch) {
        return branch;
      }
    } catch {
      try {
        const result = await execAsync("git symbolic-ref --short HEAD", {
          cwd: workingDir,
          encoding: "utf8",
          timeout: 2000,
        });
        const branch = result.stdout.trim();
        if (branch) {
          return branch;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  private async getStatusAsync(
    workingDir: string
  ): Promise<"clean" | "dirty" | "conflicts"> {
    try {
      const result = await execAsync("git status --porcelain", {
        cwd: workingDir,
        encoding: "utf8",
        timeout: 2000,
      });
      const gitStatus = result.stdout.trim();

      if (!gitStatus) return "clean";

      if (
        gitStatus.includes("UU") ||
        gitStatus.includes("AA") ||
        gitStatus.includes("DD")
      ) {
        return "conflicts";
      }

      return "dirty";
    } catch (error) {
      debug(`Git status command failed in ${workingDir}:`, error);
      return "clean";
    }
  }

  private async getAheadBehindAsync(workingDir: string): Promise<{
    ahead: number;
    behind: number;
  }> {
    try {
      const [aheadResult, behindResult] = await Promise.all([
        execAsync("git rev-list --count @{u}..HEAD", {
          cwd: workingDir,
          encoding: "utf8",
          timeout: 2000,
        }),
        execAsync("git rev-list --count HEAD..@{u}", {
          cwd: workingDir,
          encoding: "utf8",
          timeout: 2000,
        }),
      ]);

      return {
        ahead: parseInt(aheadResult.stdout.trim()) || 0,
        behind: parseInt(behindResult.stdout.trim()) || 0,
      };
    } catch (error) {
      debug(`Git ahead/behind command failed in ${workingDir}:`, error);
      return { ahead: 0, behind: 0 };
    }
  }
}
