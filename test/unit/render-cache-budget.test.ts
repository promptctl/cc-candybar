import {
  COMPILE_BYTES,
  ENTRY_BYTES,
  renderCacheBudget,
  SESSIONS_AT_DEFAULT_LIMIT,
  VIEW_BYTES,
} from "../../src/renderer/render-cache";
import { memoryLimitBytes } from "../../src/daemon/limits";

const MB = 1024 * 1024;
// What n sessions on one compile are charged: an entry and a view each.
const sessions = (n: number) => n * (ENTRY_BYTES + VIEW_BYTES) + COMPILE_BYTES;

describe("the render cache's share of the memory limit", () => {
  // A small limit's share is the quarter it has always had.
  test.each([64, 96, 128])(
    "at %i MB the share is a quarter of the limit",
    (limitMb) => {
      expect(renderCacheBudget(limitMb * MB)).toBe((limitMb * MB) / 4);
    },
  );

  // A lowered limit still holds more than the session being served, after
  // both processes' reserve: its quarter, five sessions.
  test("at 160 MB it holds several sessions", () => {
    expect(renderCacheBudget(160 * MB)).toBeGreaterThanOrEqual(sessions(5));
  });

  test("at the default limit it holds the sessions it is sized for", () => {
    expect(renderCacheBudget(memoryLimitBytes({}))).toBeGreaterThanOrEqual(
      sessions(SESSIONS_AT_DEFAULT_LIMIT),
    );
  });
});
