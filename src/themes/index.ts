import type { ColorTheme } from "../types/config";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { nordTheme } from "./nord";
import { tokyoNightTheme } from "./tokyo-night";
import { rosePineTheme } from "./rose-pine";

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
