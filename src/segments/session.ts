// [LAW:decomposition] The type seam between the daemon's usage store and the payload.

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
