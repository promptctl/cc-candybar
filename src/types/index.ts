export interface ClaudeHookData {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
  };
}

export interface PowerlineColors {
  reset: string;
  modeBg: string;
  modeFg: string;
  gitBg: string;
  gitFg: string;
  modelBg: string;
  modelFg: string;
  sessionBg: string;
  sessionFg: string;
  todayBg: string;
  todayFg: string;
  blockBg: string;
  blockFg: string;
  burnLowBg: string;
  burnFg: string;
  tmuxBg: string;
  tmuxFg: string;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  reasoning: number;
}

export interface UsageInfo {
  sessionCost: number;
  sessionTokens: number;
  sessionTokenBreakdown: TokenBreakdown;
  todayCost: number;
  todayTokens: number;
  todayTokenBreakdown: TokenBreakdown;
  todayBudget?: number;
  sessionBudget?: number;
}

export interface SessionBlockInfo {
  blockCost: number;
  blockTokens: number;
  blockTokenBreakdown: TokenBreakdown;
}
