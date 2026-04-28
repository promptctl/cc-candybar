import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CachedUsageProvider } from "../src/daemon/cache/usage";
import type { UsageInfo } from "../src/segments";
import type { ClaudeHookData } from "../src/utils/claude";

function emptyInfo(): UsageInfo {
  return {
    session: {
      cost: null,
      calculatedCost: null,
      officialCost: null,
      tokens: null,
      tokenBreakdown: null,
    },
  };
}

class StubProvider extends CachedUsageProvider {
  public superCalls: string[] = [];
  public stub: Record<string, UsageInfo> = {};

  // Replace the parent's super.getUsageInfo (UsageProvider.getUsageInfo) with
  // a stub by overriding through prototype chain awareness: CachedUsageProvider
  // calls super.getUsageInfo(...). We cheat by re-declaring the method to look
  // at our own table.
  override async getUsageInfo(
    sessionId: string,
    hookData?: ClaudeHookData,
  ): Promise<UsageInfo> {
    // Replicate the parent caching logic by delegating to it but routing the
    // underlying compute through our stub.
    // Easier: monkey-patch (this as any).realCompute then call super.
    return super.getUsageInfo(sessionId, hookData);
  }
}

// We need a way to intercept the parent's super.getUsageInfo call. Easiest is
// to replace UsageProvider.prototype.getUsageInfo for the duration of a test,
// then restore.
import { UsageProvider } from "../src/segments";

function withStubbedUsage<T>(
  table: Record<string, UsageInfo>,
  calls: string[],
  body: () => Promise<T>,
): Promise<T> {
  const original = UsageProvider.prototype.getUsageInfo;
  UsageProvider.prototype.getUsageInfo = async function (
    sessionId: string,
  ): Promise<UsageInfo> {
    calls.push(sessionId);
    return table[sessionId] ?? emptyInfo();
  };
  return body().finally(() => {
    UsageProvider.prototype.getUsageInfo = original;
  });
}

function makeTranscript(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "powerline-usage-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, "{}\n");
  return { dir, file };
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function hook(sid: string, transcriptPath: string): ClaudeHookData {
  return { session_id: sid, transcript_path: transcriptPath } as ClaudeHookData;
}

describe("CachedUsageProvider", () => {
  test("second request with same transcript mtime is a hit", async () => {
    const { dir, file } = makeTranscript();
    const calls: string[] = [];
    const cache = new StubProvider({ sweepIntervalMs: 0 });

    await withStubbedUsage({}, calls, async () => {
      await cache.getUsageInfo("s1", hook("s1", file));
      await cache.getUsageInfo("s1", hook("s1", file));
    });

    expect(calls).toEqual(["s1"]);
    expect(cache.getStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
    cache.close();
    rmrf(dir);
  });

  test("transcript mtime change forces recompute", async () => {
    const { dir, file } = makeTranscript();
    const calls: string[] = [];
    const cache = new StubProvider({ sweepIntervalMs: 0 });

    await withStubbedUsage({}, calls, async () => {
      await cache.getUsageInfo("s1", hook("s1", file));

      // Bump mtime explicitly.
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(file, future, future);

      await cache.getUsageInfo("s1", hook("s1", file));
    });

    expect(calls).toEqual(["s1", "s1"]);
    cache.close();
    rmrf(dir);
  });

  test("LRU evicts oldest at cap", async () => {
    const { dir, file } = makeTranscript();
    const calls: string[] = [];
    const cache = new StubProvider({ maxEntries: 2, sweepIntervalMs: 0 });

    await withStubbedUsage({}, calls, async () => {
      await cache.getUsageInfo("a", hook("a", file));
      await cache.getUsageInfo("b", hook("b", file));
      await cache.getUsageInfo("c", hook("c", file));
    });

    expect(cache.getStats().size).toBe(2);
    cache.close();
    rmrf(dir);
  });

  test("sweep removes entries with lastSeenAt > 24h old", async () => {
    const { dir, file } = makeTranscript();
    const calls: string[] = [];
    const cache = new StubProvider({ sweepIntervalMs: 0 });

    await withStubbedUsage({}, calls, async () => {
      await cache.getUsageInfo("fresh", hook("fresh", file));
      await cache.getUsageInfo("stale", hook("stale", file));
    });

    // Backdate one entry.
    const internal = (cache as unknown as {
      entries: Map<string, { lastSeenAt: number }>;
    }).entries;
    const staleEntry = internal.get("stale")!;
    staleEntry.lastSeenAt = Date.now() - 25 * 60 * 60 * 1000;

    const dropped = cache.sweepStale();
    expect(dropped).toBe(1);
    expect(cache.getStats().size).toBe(1);
    expect(internal.has("fresh")).toBe(true);
    expect(internal.has("stale")).toBe(false);
    cache.close();
    rmrf(dir);
  });

  test("missing transcript path delegates to super every time", async () => {
    const calls: string[] = [];
    const cache = new StubProvider({ sweepIntervalMs: 0 });

    await withStubbedUsage({}, calls, async () => {
      await cache.getUsageInfo("s1", { session_id: "s1" } as ClaudeHookData);
      await cache.getUsageInfo("s1", { session_id: "s1" } as ClaudeHookData);
    });

    // Both calls reach super because mtime=0 means we never get a hit.
    expect(calls.length).toBe(2);
    cache.close();
  });

  test("close clears entries and stops sweep timer", async () => {
    const { dir, file } = makeTranscript();
    const calls: string[] = [];
    const cache = new StubProvider({ sweepIntervalMs: 0 });

    await withStubbedUsage({}, calls, async () => {
      await cache.getUsageInfo("s1", hook("s1", file));
    });

    expect(cache.getStats().size).toBe(1);
    cache.close();
    expect(cache.getStats().size).toBe(0);
    rmrf(dir);
  });
});
