// The session's usage as the renderer composes it: the store's transcript
// totals with the hook's cost laid over them (`usageOver`), read through a
// request's refresh or as a draw reads them between requests.

import type { SessionUsageStore } from "../../src/daemon/cache/session-usage-store";
import { usageOver } from "../../src/segments/session";
import type { ClaudeHookData } from "../../src/utils/claude";

export async function usageInfo(
  store: SessionUsageStore,
  sessionId: string,
  hookData: ClaudeHookData,
) {
  return usageOver(
    await store.request(sessionId, hookData.transcript_path).usage(),
    hookData,
  );
}

export function drawnUsage(
  store: SessionUsageStore,
  sessionId: string,
  hookData: ClaudeHookData,
) {
  return usageOver(store.usageOf(sessionId), hookData);
}
