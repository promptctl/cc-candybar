import type { SessionUsageStore } from "../../src/daemon/cache/session-usage-store";
import type { ClaudeHookData } from "../../src/utils/claude";
import type { Holds } from "../../src/utils/holds";
import type { Instant } from "../../src/utils/instant";
import { PENDING } from "../../src/utils/outcome";
import { laneOutcome } from "../../src/utils/reading";

// `today` as a request reads it: the set declared, its first scan and the
// session's own refresh awaited, then the day of the sums at `at`.
export async function todayInfo(
  store: SessionUsageStore,
  holds: Holds,
  hookData: ClaudeHookData | undefined,
  claudeConfigDir: string | undefined,
  at: Instant,
) {
  const lane = store.declareToday(holds, claudeConfigDir);
  await store.refreshToday(lane, hookData);
  const set = await laneOutcome(lane);
  return set.kind === "ok" ? store.todayAt(set.value, hookData, at) : set;
}

// `today` as a frame reads it: the lane as it stands, a set no scan has
// answered being not answered yet.
export function todayNow(
  store: SessionUsageStore,
  holds: Holds,
  hookData: ClaudeHookData | undefined,
  claudeConfigDir: string | undefined,
  at: Instant,
) {
  const set = store.declareToday(holds, claudeConfigDir).current();
  if (set.kind === "pending") return PENDING;
  return set.kind === "ok" ? store.todayAt(set.value, hookData, at) : set;
}
