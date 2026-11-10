// The store's transcript totals for a session, as a request's refresh reads
// them.

import type { SessionUsageStore } from "../../src/daemon/cache/session-usage-store";
import type { ClaudeHookData } from "../../src/utils/claude";

export function usageFold(
  store: SessionUsageStore,
  sessionId: string,
  hookData: ClaudeHookData,
) {
  return store.request(sessionId, hookData.transcript_path).usage();
}
