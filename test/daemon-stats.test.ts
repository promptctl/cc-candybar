import { RuntimeStats } from "../src/daemon/stats";
import { formatStats } from "../src/daemon/client-stats";

describe("RuntimeStats.snapshot", () => {
  test("produces a stable shape with extras merged in", () => {
    const stats = new RuntimeStats();
    stats.requestsTotal = 10;
    stats.requestsErrored = 1;
    stats.requestsTimedOut = 2;
    stats.inFlight = 1;
    stats.watchersOpened = 5;
    stats.watchersClosed = 3;
    stats.watchersEvicted = 1;

    const snap = stats.snapshot({
      gitCache: {
        size: 4,
        hits: 100,
        misses: 20,
        invalidations: 3,
        watchers: 2,
      },
      usageCache: { size: 10, hits: 50, misses: 5, sweeps: 1 },
      watchersActive: 2,
    });

    expect(snap.requests).toEqual({
      total: 10,
      errored: 1,
      timedOut: 2,
      inFlight: 1,
    });
    expect(snap.gitCache.hits).toBe(100);
    expect(snap.usageCache.size).toBe(10);
    expect(snap.watchers).toEqual({
      active: 2,
      opened: 5,
      closed: 3,
      evicted: 1,
    });
    expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(snap.pid).toBe(process.pid);
    expect(snap.rssBytes).toBeGreaterThan(0);
  });
});

describe("formatStats", () => {
  test("renders human-readable output with hit rates", () => {
    const out = formatStats({
      pid: 1234,
      version: 2,
      startedAt: "2026-04-28T00:00:00.000Z",
      uptimeSec: 125,
      rssBytes: 50 * 1024 * 1024,
      heapUsedBytes: 20 * 1024 * 1024,
      requests: { total: 100, errored: 2, timedOut: 1, inFlight: 0 },
      gitCache: { size: 5, hits: 80, misses: 20, invalidations: 3, watchers: 5 },
      usageCache: { size: 3, hits: 40, misses: 10, sweeps: 0 },
      watchers: { active: 5, opened: 7, closed: 2, evicted: 0 },
    });
    expect(out).toContain("pid           1234");
    expect(out).toContain("uptime        2m5s");
    expect(out).toContain("rss           50.0MB");
    expect(out).toContain("hit rate      80.0%");
    expect(out).toContain("active        5");
  });

  test("hit rate is n/a when no observations", () => {
    const out = formatStats({
      pid: 1,
      version: 2,
      startedAt: "2026-04-28T00:00:00.000Z",
      uptimeSec: 0,
      rssBytes: 100,
      heapUsedBytes: 50,
      requests: { total: 0, errored: 0, timedOut: 0, inFlight: 0 },
      gitCache: { size: 0, hits: 0, misses: 0, invalidations: 0, watchers: 0 },
      usageCache: { size: 0, hits: 0, misses: 0, sweeps: 0 },
      watchers: { active: 0, opened: 0, closed: 0, evicted: 0 },
    });
    expect(out).toContain("hit rate      n/a");
  });
});
