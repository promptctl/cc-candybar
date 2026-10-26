import {
  RENDER_CACHE_RESERVE_BYTES,
  renderCacheBudget,
} from "../src/daemon/cache/render";
import { approachingLimit, memoryLimitBytes } from "../src/daemon/limits";

const MB = 1024 * 1024;

// The cache's share is sized under the line the doctor calls near the limit:
// a share full at its charges, with the rest of the daemon reserved, never
// crosses it — at the default limit and at any limit an operator sets.
describe("the render cache's share of the memory limit", () => {
  test.each([128, 256, 512, 1024, 4096])(
    "at %i MB, a full share and the reserve stay under the doctor's line",
    (limitMb) => {
      const limit = limitMb * MB;
      const share = renderCacheBudget(limit);
      if (approachingLimit(RENDER_CACHE_RESERVE_BYTES, limit)) {
        // The rest of the daemon alone reaches the line: the cache holds
        // only what it serves.
        expect(share).toBe(0);
      } else {
        expect(share).toBeGreaterThan(0);
        expect(
          approachingLimit(share + RENDER_CACHE_RESERVE_BYTES, limit),
        ).toBe(false);
      }
    },
  );

  test("at the default limit it holds the load gate's hundred sessions", () => {
    // An entry (3 MB) and a view (2.5 MB) a session, on one compile (10 MB).
    expect(renderCacheBudget(memoryLimitBytes({}))).toBeGreaterThanOrEqual(
      100 * 5.5 * MB + 10 * MB,
    );
  });
});
