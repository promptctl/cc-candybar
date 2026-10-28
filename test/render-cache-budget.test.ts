import {
  COMPILE_BYTES,
  ENTRY_BYTES,
  renderCacheBudget,
  VIEW_BYTES,
} from "../src/daemon/cache/render";
import { memoryLimitBytes } from "../src/daemon/limits";

const MB = 1024 * 1024;
// What n sessions on one compile are charged: an entry and a view each.
const sessions = (n: number) => n * (ENTRY_BYTES + VIEW_BYTES) + COMPILE_BYTES;

// Whether the reserve covers the rest of the daemon is measured, not derived:
// the load gate serves a hundred sessions at the default limit without the
// backstop firing, charged less than the 560 MB the share accounts for them.
describe("the render cache's share of the memory limit", () => {
  // Below that the share is the quarter a small limit has always had.
  test.each([64, 96, 128])(
    "at %i MB the share is a quarter of the limit",
    (limitMb) => {
      expect(renderCacheBudget(limitMb * MB)).toBe((limitMb * MB) / 4);
    },
  );

  // A lowered limit still holds more than the session being served.
  test("at 160 MB it holds several sessions", () => {
    expect(renderCacheBudget(160 * MB)).toBeGreaterThanOrEqual(sessions(8));
  });

  test("at the default limit it holds the load gate's hundred sessions", () => {
    expect(renderCacheBudget(memoryLimitBytes({}))).toBeGreaterThanOrEqual(
      sessions(100),
    );
  });
});
