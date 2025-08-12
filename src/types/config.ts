export interface SegmentConfig {
  enabled: boolean;
}

export interface GitSegmentConfig extends SegmentConfig {
  showSha: boolean;
}

export interface UsageSegmentConfig extends SegmentConfig {
  type: "cost" | "tokens" | "both" | "breakdown";
}

export interface BlockSegmentConfig extends SegmentConfig {
  type?: "cost" | "tokens";
}

export interface TmuxSegmentConfig extends SegmentConfig {}

export type AnySegmentConfig =
  | SegmentConfig
  | GitSegmentConfig
  | UsageSegmentConfig
  | BlockSegmentConfig
  | TmuxSegmentConfig;

export interface SegmentColor {
  bg: string;
  fg: string;
}

export interface ColorTheme {
  directory: SegmentColor;
  git: SegmentColor;
  model: SegmentColor;
  session: SegmentColor;
  today: SegmentColor;
  block: SegmentColor;
  tmux: SegmentColor;
}

export interface LineConfig {
  segments: {
    directory?: SegmentConfig;
    git?: GitSegmentConfig;
    model?: SegmentConfig;
    session?: UsageSegmentConfig;
    today?: UsageSegmentConfig;
    block?: BlockSegmentConfig;
    tmux?: TmuxSegmentConfig;
  };
}

export interface DisplayConfig {
  lines: LineConfig[];
  style?: "minimal" | "powerline";
}

export interface BudgetItemConfig {
  amount?: number;
  warningThreshold?: number;
}

export interface BudgetConfig {
  session?: BudgetItemConfig;
  today?: BudgetItemConfig;
}

export interface PowerlineConfig {
  theme: "light" | "dark" | "nord" | "tokyo-night" | "rose-pine" | "custom";
  display: DisplayConfig;
  colors?: {
    custom: ColorTheme;
  };
  budget?: BudgetConfig;
}

export interface ConfigLoadOptions {
  configPath?: string;
  ignoreEnvVars?: boolean;
  cliOverrides?: Partial<PowerlineConfig>;
  projectDir?: string;
}
