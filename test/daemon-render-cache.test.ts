import { RenderCache } from "../src/daemon/cache/render";
import { GitService } from "../src/segments/git";
import { UsageProvider } from "../src/segments/session";
import { SessionState } from "../src/daemon/session-state";

function makeDeps() {
  return {
    gitService: new GitService(),
    usageProvider: new UsageProvider(),
    sessionState: new SessionState(),
  };
}

describe("RenderCache", () => {
  test("same args returns identical renderer (=== identity)", () => {
    const cache = new RenderCache(makeDeps());
    const a = cache.getOrCreate(["--style=powerline"], undefined, undefined);
    const b = cache.getOrCreate(["--style=powerline"], undefined, undefined);
    expect(a.renderer).toBe(b.renderer);
    expect(a.config).toBe(b.config);
  });

  test("different args returns different renderer", () => {
    const cache = new RenderCache(makeDeps());
    const a = cache.getOrCreate(["--style=powerline"], undefined, undefined);
    const b = cache.getOrCreate(["--style=capsule"], undefined, undefined);
    expect(a.renderer).not.toBe(b.renderer);
  });

  test("different projectDir returns different renderer", () => {
    const cache = new RenderCache(makeDeps());
    const a = cache.getOrCreate([], "/project/a", undefined);
    const b = cache.getOrCreate([], "/project/b", undefined);
    expect(a.renderer).not.toBe(b.renderer);
  });

  test("different cwd returns different renderer", () => {
    const cache = new RenderCache(makeDeps());
    const a = cache.getOrCreate([], undefined, "/cwd/x");
    const b = cache.getOrCreate([], undefined, "/cwd/y");
    expect(a.renderer).not.toBe(b.renderer);
  });

  test("evicts oldest entry when exceeding max (16)", () => {
    const cache = new RenderCache(makeDeps());
    const first = cache.getOrCreate(["--style=powerline"], undefined, undefined);
    expect(cache.size).toBe(1);

    // Fill with 16 distinct entries (the first already counts as 1).
    for (let i = 0; i < 16; i++) {
      cache.getOrCreate([`--theme=dark-${i}`], undefined, undefined);
    }
    // First entry should have been evicted.
    expect(cache.size).toBe(16);

    // Requesting the first key again creates a new renderer.
    const firstAgain = cache.getOrCreate(
      ["--style=powerline"],
      undefined,
      undefined,
    );
    expect(firstAgain.renderer).not.toBe(first.renderer);
  });

  test("accessing an entry moves it to most-recent (LRU refresh)", () => {
    const cache = new RenderCache(makeDeps());
    const stale = cache.getOrCreate(["stale"], undefined, undefined);

    // Fill 15 more (16 total, stale is oldest).
    for (let i = 0; i < 15; i++) {
      cache.getOrCreate([`fill-${i}`], undefined, undefined);
    }
    expect(cache.size).toBe(16);

    // Re-access stale — should move it to most-recent.
    const refreshed = cache.getOrCreate(["stale"], undefined, undefined);
    expect(refreshed.renderer).toBe(stale.renderer);

    // Add one more — should evict fill-0 (now oldest), not stale.
    cache.getOrCreate(["extra"], undefined, undefined);
    expect(cache.size).toBe(16);

    // stale should still be present (same identity).
    const still = cache.getOrCreate(["stale"], undefined, undefined);
    expect(still.renderer).toBe(stale.renderer);
  });
});
