import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { debug } from "./logger";
import { getClaudePaths, findProjectPaths, getFileModificationDate } from "./claude";

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class CacheManager {
  private static readonly CACHE_DIR = path.join(homedir(), ".claude", "powerline");
  private static readonly GIT_CACHE_DIR = path.join(this.CACHE_DIR, "git");
  private static readonly USAGE_CACHE_DIR = path.join(this.CACHE_DIR, "usage");
  private static readonly LOCKS_DIR = path.join(this.CACHE_DIR, "locks");

  private static isLocked(name: string): boolean {
    const lockFile = path.join(this.LOCKS_DIR, name);
    return fs.existsSync(lockFile);
  }

  private static async acquireLock(name: string, timeout = 5000): Promise<boolean> {
    const RETRY_DELAY_MS = 50;
    const FILE_CREATE_FLAG = 'wx';
    
    await this.ensureCacheDirectories();
    const lockFile = path.join(this.LOCKS_DIR, name);
    const startTime = Date.now();
    const lockContent = String(process.pid);

    while (Date.now() - startTime < timeout) {
      try {
        await fs.promises.writeFile(lockFile, lockContent, { flag: FILE_CREATE_FLAG });
        debug(`Lock acquired for ${name}`);
        return true;
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          await setTimeout(RETRY_DELAY_MS);
        } else {
          throw error;
        }
      }
    }
    debug(`Failed to acquire lock for ${name} within ${timeout}ms`);
    return false;
  }

  private static async releaseLock(name: string): Promise<void> {
    const lockFile = path.join(this.LOCKS_DIR, name);
    try {
      await fs.promises.unlink(lockFile);
      debug(`Lock released for ${name}`);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        debug(`Error releasing lock for ${name}:`, error);
      }
    }
  }

  static async ensureCacheDirectories(): Promise<void> {
    try {
      await Promise.all([
        fs.promises.mkdir(this.CACHE_DIR, { recursive: true }),
        fs.promises.mkdir(this.GIT_CACHE_DIR, { recursive: true }),
        fs.promises.mkdir(this.USAGE_CACHE_DIR, { recursive: true }),
        fs.promises.mkdir(this.LOCKS_DIR, { recursive: true }),
      ]);
    } catch (error) {
      debug("Failed to create cache directories:", error);
    }
  }

  static createProjectHash(projectPath: string): string {
    return createHash("md5").update(projectPath).digest("hex").substring(0, 8);
  }

  static async getGitCache(projectPath: string): Promise<any | null> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 75;
    const CACHE_TTL_MS = 500;
    const FILE_ENCODING = "utf-8";
    
    await this.ensureCacheDirectories();
    const hash = this.createProjectHash(projectPath);
    const cachePath = path.join(this.GIT_CACHE_DIR, `${hash}.json`);
    const lockName = `${hash}.git.lock`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const isCurrentlyLocked = this.isLocked(lockName);
      if (isCurrentlyLocked) {
        debug(`Cache for git project ${hash} is locked, waiting...`);
        await setTimeout(RETRY_DELAY_MS);
        continue;
      }

      try {
        const content = await fs.promises.readFile(cachePath, FILE_ENCODING);
        const cached: CacheEntry<any> = JSON.parse(content);
        const cacheAge = Date.now() - cached.timestamp;
        const isCacheValid = cacheAge < CACHE_TTL_MS;

        if (isCacheValid) {
          debug(`Using shared git cache for ${projectPath}`);
          return cached.data;
        }
        return null;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          debug(`No shared git cache found for ${projectPath}`);
          return null;
        }
        const attemptNumber = attempt + 1;
        debug(`Attempt ${attemptNumber} failed to read git cache for ${projectPath}: ${error.message}. Retrying...`);
        await setTimeout(RETRY_DELAY_MS);
      }
    }

    debug(`Failed to read git cache for ${projectPath} after ${MAX_RETRIES} attempts.`);
    return null;
  }

  static async setGitCache(projectPath: string, data: any): Promise<void> {
    const hash = this.createProjectHash(projectPath);
    const lockName = `${hash}.git.lock`;

    if (!(await this.acquireLock(lockName))) {
      debug(`Could not acquire lock to set git cache for ${projectPath}`);
      return;
    }

    try {
      await this.ensureCacheDirectories();
      const cachePath = path.join(this.GIT_CACHE_DIR, `${hash}.json`);
      const cacheEntry: CacheEntry<any> = {
        data,
        timestamp: Date.now(),
      };
      await fs.promises.writeFile(
        cachePath,
        JSON.stringify(cacheEntry),
        "utf-8"
      );
      debug(`Saved shared git cache for ${projectPath}`);
    } catch (error) {
      debug(`Failed to save git cache for ${projectPath}:`, error);
    } finally {
      await this.releaseLock(lockName);
    }
  }

  static async getUsageCache(cacheType: 'today' | 'block' | 'pricing', latestMtime?: number): Promise<any | null> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 75;
    const FILE_ENCODING = "utf-8";
    
    await this.ensureCacheDirectories();
    const cachePath = path.join(this.USAGE_CACHE_DIR, `${cacheType}.json`);
    const lockName = `${cacheType}.usage.lock`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const isCurrentlyLocked = this.isLocked(lockName);
      if (isCurrentlyLocked) {
        debug(`Cache for ${cacheType} is locked, waiting...`);
        await setTimeout(RETRY_DELAY_MS);
        continue;
      }

      try {
        const content = await fs.promises.readFile(cachePath, FILE_ENCODING);
        const cached: CacheEntry<any> = JSON.parse(content);
        const cacheIsValid = !latestMtime || cached.timestamp >= latestMtime;
        
        if (cacheIsValid) {
          debug(`Using shared ${cacheType} usage cache`);
          return this.deserializeDates(cached.data);
        } else {
          debug(`${cacheType} cache outdated: cache=${cached.timestamp}, latest=${latestMtime}`);
          return null;
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          debug(`No shared ${cacheType} usage cache found`);
          return null;
        }
        const attemptNumber = attempt + 1;
        debug(`Attempt ${attemptNumber} failed to read ${cacheType} cache: ${error.message}. Retrying...`);
        await setTimeout(RETRY_DELAY_MS);
      }
    }
    
    debug(`Failed to read ${cacheType} cache after ${MAX_RETRIES} attempts.`);
    return null;
  }

  private static deserializeDates(data: any): any {
    if (Array.isArray(data)) {
      return data.map(entry => ({
        ...entry,
        timestamp: new Date(entry.timestamp)
      }));
    }
    return data;
  }
  
  static async setUsageCache(cacheType: 'today' | 'block' | 'pricing', data: any, latestMtime?: number): Promise<void> {
    const lockName = `${cacheType}.usage.lock`;
    const lockAcquired = await this.acquireLock(lockName);
    if (!lockAcquired) {
      debug(`Could not acquire lock to set usage cache for ${cacheType}`);
      return;
    }

    try {
      await this.ensureCacheDirectories();
      const cachePath = path.join(this.USAGE_CACHE_DIR, `${cacheType}.json`);
      const cacheTimestamp = latestMtime || Date.now();
      const cacheEntry: CacheEntry<any> = {
        data,
        timestamp: cacheTimestamp,
      };
      const cacheContent = JSON.stringify(cacheEntry);
      
      await fs.promises.writeFile(cachePath, cacheContent, "utf-8");
      debug(`Saved shared ${cacheType} usage cache`);
    } catch (error) {
      debug(`Failed to save ${cacheType} usage cache:`, error);
    } finally {
      await this.releaseLock(lockName);
    }
  }

  static async getLatestTranscriptMtime(): Promise<number> {
    try {
      const claudePaths = getClaudePaths();
      const projectPaths = await findProjectPaths(claudePaths);
      
      let latestMtime = 0;
      
      for (const projectPath of projectPaths) {
        try {
          const files = await fs.promises.readdir(projectPath);
          const jsonlFiles = files.filter((file) => file.endsWith(".jsonl"));
          
          for (const file of jsonlFiles) {
            const filePath = path.join(projectPath, file);
            const mtime = await getFileModificationDate(filePath);
            if (mtime && mtime.getTime() > latestMtime) {
              latestMtime = mtime.getTime();
            }
          }
        } catch (error) {
          debug(`Failed to read project directory ${projectPath}:`, error);
          continue;
        }
      }
      
      return latestMtime;
    } catch (error) {
      debug("Failed to get latest transcript mtime:", error);
      return Date.now();
    }
  }


  static async cleanupOldCache(maxAge = 24 * 60 * 60 * 1000): Promise<void> {
    await this.ensureCacheDirectories();
    
    const now = Date.now();
    const cleanupMarker = path.join(this.CACHE_DIR, ".cleanup");

    try {
      const lastCleanup = await fs.promises.readFile(cleanupMarker, "utf-8");
      if (now - parseInt(lastCleanup) < 60 * 60 * 1000) {
        return;
      }
    } catch {
    }

    try {
      const dirs = [this.GIT_CACHE_DIR, this.USAGE_CACHE_DIR];
      
      for (const dir of dirs) {
        try {
          const files = await fs.promises.readdir(dir);
          
          for (const file of files) {
            const filePath = path.join(dir, file);
            const stats = await fs.promises.stat(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
              await fs.promises.unlink(filePath);
              debug(`Cleaned up old cache file: ${file}`);
            }
          }
        } catch (error) {
          debug(`Error cleaning directory ${dir}:`, error);
        }
      }

      await fs.promises.writeFile(cleanupMarker, now.toString());
      debug("Cache cleanup completed");
    } catch (error) {
      debug("Error during cache cleanup:", error);
    }
  }
}
