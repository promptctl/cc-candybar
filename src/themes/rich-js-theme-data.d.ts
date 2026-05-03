declare module "rich-js/themes/data" {
  interface ThemePaletteData {
    readonly name: string;
    readonly dark: boolean;
    readonly vars: Readonly<Record<string, string>>;
  }

  export const THEMES: Record<string, ThemePaletteData>;
}

declare module "rich-js/themes/registry" {
  import type { Palette } from "rich-js";
  export function listThemePalettes(): readonly string[];
  export function getThemePalette(name: string): Palette | null;
}
