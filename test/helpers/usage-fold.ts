// The store's transcript totals for a session, as a request's refresh reads
// them.

import type { SessionUsageStore } from "../../src/daemon/cache/session-usage-store";
import type { SessionId } from "../../src/daemon/session-id";

export function usageFold(
  store: SessionUsageStore,
  sessionId: SessionId,
  transcriptPath: string | undefined,
) {
  return store.request(sessionId, transcriptPath).usage();
}
