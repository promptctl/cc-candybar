import type {
  DaySums,
  SessionUsageStore,
} from "../../src/daemon/cache/session-usage-store";
import { oneDay, projectToday } from "../../src/daemon/cache/today-facts";
import { RefreshFaults } from "../../src/daemon/refresh-faults";
import { todayReading } from "../../src/daemon/render-payload";
import type { ClaudeHookData } from "../../src/utils/claude";
import type { Holds } from "../../src/utils/holds";
import type { Instant } from "../../src/utils/instant";
import { pendingOf } from "../../src/utils/outcome";
import { laneOutcome } from "../../src/utils/reading";

// `today` once its set's first scan has landed: the set declared, the
// session's own refresh and the scan awaited here (a request awaits only the
// refresh), then the day of the fact at `at`.
export async function todayInfo(
  store: SessionUsageStore,
  holds: Holds,
  hookData: ClaudeHookData | undefined,
  claudeConfigDir: string | undefined,
  at: Instant,
) {
  const lane = store.declareToday(holds, claudeConfigDir);
  await store.refreshToday(hookData);
  await laneOutcome(lane);
  return projected(store, lane, hookData, at);
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
  const lane = store.declareToday(holds, claudeConfigDir);
  if (lane.current().kind === "pending") return pendingOf("unread");
  return projected(store, lane, hookData, at);
}

// The `today` fact as the document reads it (`todayReading`), projected at the
// draw's instant: what a draw shows.
function projected(
  store: SessionUsageStore,
  lane: ReturnType<SessionUsageStore["declareToday"]>,
  hookData: ClaudeHookData | undefined,
  at: Instant,
) {
  const fact = todayReading(
    lane,
    new RefreshFaults(),
    store,
    hookData?.session_id ?? "",
  );
  return fact.kind === "ok" ? projectToday(fact.value, at) : fact;
}

// The day sums of a directory set holding one day: `cost` and `tokens` on the
// day `at` falls in, with no roots.
export function sumsOf(at: Instant, cost: number, tokens: number): DaySums {
  return { roots: [], sums: oneDay(at, cost, tokens) };
}
