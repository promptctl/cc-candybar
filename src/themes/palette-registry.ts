import { Palette, parseRgbHex, parseRgbaHex } from "rich-js";
import type { ColorRgba } from "rich-js";
import { THEMES } from "rich-js/themes/data";

const cache = new Map<string, Palette>();

function hexToColorRgba(hex: string): ColorRgba {
  const stripped = hex.startsWith("#") ? hex.slice(1) : hex;
  return stripped.length <= 6
    ? parseRgbHex(stripped)
    : parseRgbaHex(stripped);
}

function paletteFromData(
  name: string,
  dark: boolean,
  vars: Record<string, string>,
): Palette {
  const map = new Map<string, ColorRgba>();
  for (const [key, hex] of Object.entries(vars)) {
    map.set(key, hexToColorRgba(hex));
  }
  return new Palette(name, dark, map);
}

const THEME_NAMES = Object.keys(THEMES).sort();

export function listThemePalettes(): readonly string[] {
  return THEME_NAMES;
}

export function getThemePalette(name: string): Palette | null {
  if (!(name in THEMES)) return null;
  const cached = cache.get(name);
  if (cached) return cached;
  const data = THEMES[name as keyof typeof THEMES]!;
  const palette = paletteFromData(data.name, data.dark, data.vars);
  cache.set(name, palette);
  return palette;
}
