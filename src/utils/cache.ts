import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { debug } from "./logger";
import { sleep, type Timekeeper } from "../time";

interface ErrnoError extends Error {
  code?: string;
}

// [LAW:effects-at-boundaries] What the cache waits and dates entries on: every
// method that sleeps or stamps takes the owner's clock, so a test holds it.
export type CacheClock = Pick<Timekeeper, "now" | "monotonic" | "after">;

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class CacheManager {
  // [LAW:one-source-of-truth] Every method takes the cache's root directory
  // (the host's `cacheDir`), so the layout under it is derived here alone.
  private static usageDir(root: string): string {
    return path.join(root, "usage");
  }

  private static locksDir(root: string): string {
    return path.join(root, "locks");
  }

  private static isLocked(root: string, name: string): boolean {
    const lockFile = path.join(this.locksDir(root), name);
    if (!fs.existsSync(lockFile)) {
      return false;
    }

    try {
      const lockContent = fs.readFileSync(lockFile, "utf-8");
      const pid = parseInt(lockContent.trim(), 10);

      if (isNaN(pid)) {
        debug(`Invalid PID in lock file ${name}, removing stale lock`);
        fs.unlinkSync(lockFile);
        return false;
      }

      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as ErrnoError).code === "ESRCH") {
          debug(`Removing stale lock file ${name} for dead process ${pid}`);
          fs.unlinkSync(lockFile);
          return false;
        }
        debug(`Error checking process ${pid} for lock ${name}:`, error);
        return true;
      }
    } catch (error) {
      debug(`Error reading lock file ${name}:`, error);
      return true;
    }
  }

  private static async acquireLock(
    root: string,
    clock: CacheClock,
    name: string,
    timeout = 5000,
  ): Promise<boolean> {
    const RETRY_DELAY_MS = 50;
    const FILE_CREATE_FLAG = "wx";

    await this.ensureCacheDirectories(root);
    const lockFile = path.join(this.locksDir(root), name);
    const startTime = clock.monotonic();
    const lockContent = String(process.pid);

    while (clock.monotonic() - startTime < timeout) {
      try {
        await fs.promises.writeFile(lockFile, lockContent, {
          flag: FILE_CREATE_FLAG,
        });
        debug(`Lock acquired for ${name}`);
        return true;
      } catch (error) {
        if ((error as ErrnoError).code === "EEXIST") {
          await sleep(clock, RETRY_DELAY_MS);
        } else {
          throw error;
        }
      }
    }
    debug(`Failed to acquire lock for ${name} within ${timeout}ms`);
    return false;
  }

  private static async releaseLock(root: string, name: string): Promise<void> {
    const lockFile = path.join(this.locksDir(root), name);
    try {
      await fs.promises.unlink(lockFile);
      debug(`Lock released for ${name}`);
    } catch (error) {
      if ((error as ErrnoError).code !== "ENOENT") {
        debug(`Error releasing lock for ${name}:`, error);
      }
    }
  }

  static async ensureCacheDirectories(root: string): Promise<void> {
    try {
      await Promise.all([
        fs.promises.mkdir(root, { recursive: true }),
        fs.promises.mkdir(this.usageDir(root), { recursive: true }),
        fs.promises.mkdir(this.locksDir(root), { recursive: true }),
      ]);
    } catch (error) {
      debug("Failed to create cache directories:", error);
    }
  }

  static createProjectHash(projectPath: string): string {
    return createHash("md5").update(projectPath).digest("hex").substring(0, 8);
  }

  static async getUsageCache(
    root: string,
    clock: CacheClock,
    cacheType: "pricing",
    latestMtime?: number,
  ): Promise<unknown> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 75;
    const FILE_ENCODING = "utf-8";

    await this.ensureCacheDirectories(root);
    const cachePath = path.join(this.usageDir(root), `${cacheType}.json`);
    const lockName = `${cacheType}.usage.lock`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const isCurrentlyLocked = this.isLocked(root, lockName);
      if (isCurrentlyLocked) {
        debug(`Cache for ${cacheType} is locked, waiting...`);
        await sleep(clock, RETRY_DELAY_MS);
        continue;
      }

      try {
        const content = await fs.promises.readFile(cachePath, FILE_ENCODING);
        const cached: CacheEntry<unknown> = JSON.parse(content);
        const cacheIsValid = !latestMtime || cached.timestamp >= latestMtime;

        if (cacheIsValid) {
          debug(`[CACHE-HIT] ${cacheType} disk cache: found`);
          return this.deserializeDates(cached.data);
        } else {
          debug(
            `${cacheType} cache outdated: cache=${cached.timestamp}, latest=${latestMtime}`,
          );
          return null;
        }
      } catch (error) {
        if ((error as ErrnoError).code === "ENOENT") {
          debug(`No shared ${cacheType} usage cache found`);
          return null;
        }
        const attemptNumber = attempt + 1;
        debug(
          `Attempt ${attemptNumber} failed to read ${cacheType} cache: ${(error as Error).message}. Retrying...`,
        );
        await sleep(clock, RETRY_DELAY_MS);
      }
    }

    debug(`Failed to read ${cacheType} cache after ${MAX_RETRIES} attempts.`);
    return null;
  }

  private static deserializeDates(data: unknown): unknown {
    if (Array.isArray(data)) {
      return data.map((entry) => ({
        ...entry,
        timestamp: new Date(entry.timestamp),
      }));
    }
    return data;
  }

  static async setUsageCache(
    root: string,
    clock: CacheClock,
    cacheType: "pricing",
    data: unknown,
    latestMtime?: number,
  ): Promise<void> {
    const lockName = `${cacheType}.usage.lock`;
    const lockAcquired = await this.acquireLock(root, clock, lockName);
    if (!lockAcquired) {
      debug(`Could not acquire lock to set usage cache for ${cacheType}`);
      return;
    }

    try {
      await this.ensureCacheDirectories(root);
      const cachePath = path.join(this.usageDir(root), `${cacheType}.json`);
      const cacheTimestamp = latestMtime || clock.now();
      const cacheEntry: CacheEntry<unknown> = {
        data,
        timestamp: cacheTimestamp,
      };
      const cacheContent = JSON.stringify(cacheEntry);

      await fs.promises.writeFile(cachePath, cacheContent, "utf-8");
      debug(`[CACHE-SET] ${cacheType} disk cache stored`);
    } catch (error) {
      debug(`Failed to save ${cacheType} usage cache:`, error);
    } finally {
      await this.releaseLock(root, lockName);
    }
  }
}
