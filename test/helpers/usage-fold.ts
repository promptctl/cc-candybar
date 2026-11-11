// The store's transcript totals for a session, as a request's refresh reads
// them.

import type { SessionUsageStore } from "../../src/daemon/cache/session-usage-store";

export function usageFold(
  store: SessionUsageStore,
  sessionId: string,
  transcriptPath: string | undefined,
) {
  return store.request(sessionId, transcriptPath).usage();
}
