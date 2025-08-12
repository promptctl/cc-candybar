import type { ColorTheme } from "../types/config";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";

export const BUILT_IN_THEMES: Record<string, ColorTheme> = {
  dark: darkTheme,
  light: lightTheme,
};

export function getTheme(themeName: string): ColorTheme | null {
  return BUILT_IN_THEMES[themeName] || null;
}

export { darkTheme, lightTheme };
