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
  test.each([256, 512, 1024, 4096])(
    "at %i MB, a full share and the reserve stay under the doctor's line",
    (limitMb) => {
      const limit = limitMb * MB;
      expect(
        approachingLimit(renderCacheBudget(limit) + RENDER_CACHE_RESERVE_BYTES, limit),
      ).toBe(false);
    },
  );

  // Below that the share is the quarter a small limit has always had.
  test.each([64, 96, 128])("at %i MB the share is a quarter of the limit", (limitMb) => {
    expect(renderCacheBudget(limitMb * MB)).toBe((limitMb * MB) / 4);
  });

  // A lowered limit still holds more than the session being served.
  test("at 160 MB it holds several sessions", () => {
    expect(renderCacheBudget(160 * MB)).toBeGreaterThanOrEqual(8 * 5.5 * MB + 10 * MB);
  });

  test("at the default limit it holds the load gate's hundred sessions", () => {
    // An entry (3 MB) and a view (2.5 MB) a session, on one compile (10 MB).
    expect(renderCacheBudget(memoryLimitBytes({}))).toBeGreaterThanOrEqual(
      100 * 5.5 * MB + 10 * MB,
    );
  });
});
