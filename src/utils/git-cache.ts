import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { debug } from "./logger";

const CACHE_DIR = path.join(homedir(), ".claude", "powerline", "git");
const TTL_MS = 1500;

interface CacheEntry<T> {
  data: T;
  ts: number;
}

function keyToFile(key: string): string {
  const h = createHash("sha1").update(key).digest("hex").substring(0, 16);
  return path.join(CACHE_DIR, `${h}.json`);
}

export async function withGitCache<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const file = keyToFile(key);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < ttlMs) {
      const raw = fs.readFileSync(file, "utf-8");
      const entry = JSON.parse(raw) as CacheEntry<T>;
      debug(`[git-cache] hit ${key}`);
      return entry.data;
    }
  } catch {}

  const data = await compute();
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ data, ts: Date.now() }));
    fs.renameSync(tmp, file);
  } catch (e) {
    debug(`[git-cache] write failed: ${(e as Error).message}`);
  }
  return data;
}

export const GIT_CACHE_TTL_MS = TTL_MS;
