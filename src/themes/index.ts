import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { nordTheme } from "./nord";
import { tokyoNightTheme } from "./tokyo-night";
import { rosePineTheme } from "./rose-pine";

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
  context: SegmentColor;
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
  contextBg: string;
  contextFg: string;
}

export const BUILT_IN_THEMES: Record<string, ColorTheme> = {
  dark: darkTheme,
  light: lightTheme,
  nord: nordTheme,
  "tokyo-night": tokyoNightTheme,
  "rose-pine": rosePineTheme,
};

export function getTheme(themeName: string): ColorTheme | null {
  return BUILT_IN_THEMES[themeName] || null;
}

export { darkTheme, lightTheme, nordTheme, tokyoNightTheme, rosePineTheme };
