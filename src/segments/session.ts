// [LAW:decomposition] The session usage CONTRACT — the shapes the daemon's
// SessionUsageStore produces and the render payload reads. The transcript fold
// that produces them is incremental and lives in the store (its single owner);
// this module is the type seam both sides agree on.

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface SessionInfo {
  cost: number | null;
  calculatedCost: number | null;
  officialCost: number | null;
  tokens: number | null;
  tokenBreakdown: TokenBreakdown | null;
}

export interface UsageInfo {
  session: SessionInfo;
}
