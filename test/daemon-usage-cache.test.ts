// [LAW:single-enforcer] CachedUsageProvider is the daemon's transcript-
// parse cache. These tests pin its observable contract: cache-hit on
// unchanged transcript mtime, cache-miss when mtime advances, LRU eviction
// at the size cap, and stale-age sweep behavior.
//
// The provider's underlying compute path (UsageProvider.getUsageInfo
// → JSONL parse + pricing math) is exercised by var-system tests
// elsewhere; this file mocks the parent class via subclassing so we
// observe call counts without spinning up real transcript files.

import { writeFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CachedUsageProvider } from "../src/daemon/cache/usage";
import { UsageProvider } from "../src/segments/session";
import type { UsageInfo } from "../src/segments/session";
import type { ClaudeHookData } from "../src/utils/claude";

// [LAW:single-enforcer] Patch the parent UsageProvider's compute method
// so the cache's `super.getUsageInfo(...)` (its cache-miss path) lands on
// our counter. We do NOT override on the cache subclass — that would
// bypass the caching logic we're trying to test.
const origParentImpl = UsageProvider.prototype.getUsageInfo;
let computeCalls = 0;
beforeEach(() => {
  computeCalls = 0;
  UsageProvider.prototype.getUsageInfo = async function (
    _sessionId: string,
    _hookData?: ClaudeHookData,
  ): Promise<UsageInfo> {
    computeCalls++;
    return {
      session: {
        cost: 0,
        calculatedCost: 0,
        officialCost: 0,
        tokens: 0,
        tokenBreakdown: null,
      },
    };
  };
});
afterAll(() => {
  UsageProvider.prototype.getUsageInfo = origParentImpl;
});

describe("CachedUsageProvider", () => {
  test("returns the no-session-id passthrough without caching", async () => {
    const cache = new CachedUsageProvider({ sweepIntervalMs: 0 });
    try {
      await cache.getUsageInfo("", undefined);
      await cache.getUsageInfo("", undefined);
      // Two calls with empty sessionId — both pass through, neither cached.
      expect(computeCalls).toBe(2);
      expect(cache.getStats().hits).toBe(0);
      expect(cache.getStats().misses).toBe(0);
    } finally {
      cache.close();
    }
  });

  test("cache hit when transcript mtime unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-candybar-usage-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, "");
    const cache = new CachedUsageProvider({ sweepIntervalMs: 0 });
    try {
      const hd = { transcript_path: transcript } as ClaudeHookData;
      await cache.getUsageInfo("session-A", hd);
      expect(computeCalls).toBe(1);
      // Second call with same mtime → cache hit, compute not invoked again.
      await cache.getUsageInfo("session-A", hd);
      expect(computeCalls).toBe(1);
      expect(cache.getStats().hits).toBe(1);
      expect(cache.getStats().misses).toBe(1);
    } finally {
      cache.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cache miss when transcript mtime advances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-candybar-usage-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, "");
    const cache = new CachedUsageProvider({ sweepIntervalMs: 0 });
    try {
      const hd = { transcript_path: transcript } as ClaudeHookData;
      await cache.getUsageInfo("session-A", hd);
      expect(computeCalls).toBe(1);
      // Bump mtime deterministically. `utimesSync` takes seconds for
      // atime/mtime; jumping a full hour into the future guarantees
      // mtimeMs differs at any filesystem granularity.
      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(transcript, future, future);
      await cache.getUsageInfo("session-A", hd);
      expect(computeCalls).toBe(2);
      expect(cache.getStats().misses).toBe(2);
    } finally {
      cache.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("LRU eviction at the size cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-candybar-usage-"));
    const cache = new CachedUsageProvider({
      maxEntries: 2,
      sweepIntervalMs: 0,
    });
    try {
      // Each session needs its own transcript so mtime read finds the
      // file (otherwise statMtimeMs returns 0 for every entry and they
      // all collide on mtime=0).
      for (const sid of ["a", "b", "c"]) {
        const t = join(dir, `${sid}.jsonl`);
        writeFileSync(t, "");
        await cache.getUsageInfo(sid, { transcript_path: t } as ClaudeHookData);
      }
      // Cap is 2; oldest (`a`) is evicted. Asking for `a` again must
      // miss and recompute.
      const tA = join(dir, "a.jsonl");
      const beforeMisses = cache.getStats().misses;
      await cache.getUsageInfo("a", { transcript_path: tA } as ClaudeHookData);
      expect(cache.getStats().misses).toBe(beforeMisses + 1);
    } finally {
      cache.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sweepStale drops entries older than staleAgeMs", async () => {
    const cache = new CachedUsageProvider({
      sweepIntervalMs: 0,
      staleAgeMs: 1, // anything inserted is immediately stale after 1ms
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "cc-candybar-usage-"));
      const t = join(dir, "a.jsonl");
      writeFileSync(t, "");
      await cache.getUsageInfo("a", { transcript_path: t } as ClaudeHookData);
      await new Promise((r) => setTimeout(r, 10));
      const dropped = cache.sweepStale();
      expect(dropped).toBe(1);
      expect(cache.getStats().sweeps).toBe(1);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      cache.close();
    }
  });
});
