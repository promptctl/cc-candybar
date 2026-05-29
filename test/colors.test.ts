import {
  hexToBasicAnsi,
  hexToAnsi,
  hexTo256Ansi,
  extractBgToFg,
} from "../src/utils/colors";
import { getColorSupport } from "../src/utils/color-support";
import { listAvailableThemes, STYLE_ORDER } from "../src/themes";
import { rotateHue, rgbaToOklch } from "../src/themes/oklch";
import { ColorRgba } from "@promptctl/rich-js";

describe("Colors", () => {
  describe("Core Color Functions", () => {
    it("should convert hex to truecolor ANSI", () => {
      expect(hexToAnsi("#FF0000", false)).toBe("\x1b[38;2;255;0;0m");
      expect(hexToAnsi("#00FF00", true)).toBe("\x1b[48;2;0;255;0m");
    });

    it("should convert background to foreground ANSI", () => {
      expect(extractBgToFg("\x1b[48;2;255;100;50m")).toBe(
        "\x1b[38;2;255;100;50m",
      );
      expect(extractBgToFg("\x1b[41m")).toBe("\x1b[31m");
    });

    it("should handle transparent backgrounds", () => {
      expect(hexToAnsi("transparent", true)).toBe("\x1b[49m");
      expect(hexTo256Ansi("transparent", true)).toBe("\x1b[49m");
      expect(hexToBasicAnsi("transparent", true)).toBe("\x1b[49m");
    });
  });

  describe("Terminal Detection", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it("should detect macOS Terminal as ansi256", () => {
      process.env = {};
      process.env.TERM_PROGRAM = "Apple_Terminal";
      expect(getColorSupport()).toBe("ansi256");
    });

    it("should detect modern terminals as truecolor", () => {
      process.env = {};
      process.env.TERM_PROGRAM = "vscode";
      expect(getColorSupport()).toBe("truecolor");

      process.env = {};
      process.env.TERM = "alacritty";
      expect(getColorSupport()).toBe("truecolor");
    });

    it("should respect NO_COLOR", () => {
      process.env = {};
      process.env.NO_COLOR = "1";
      expect(getColorSupport()).toBe("none");
    });

    it("should respect FORCE_COLOR standard (overrides NO_COLOR)", () => {
      process.env = {};
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "1";
      expect(getColorSupport()).toBe("ansi");
    });

    it("should handle FORCE_COLOR values correctly", () => {
      process.env = {};
      process.env.FORCE_COLOR = "0";
      expect(getColorSupport()).toBe("none");

      process.env = {};
      process.env.FORCE_COLOR = "3";
      expect(getColorSupport()).toBe("truecolor");
    });

    it("should generate correct ANSI codes for different modes", () => {
      const ansi256 = hexTo256Ansi("#FF0000", false);
      expect(ansi256.startsWith("\u001b[38;5;")).toBe(true);

      expect(hexToBasicAnsi("#FF0000", true)).toBe("");
      expect(hexToBasicAnsi("#FF0000", false)).toContain("31");
    });
  });

  describe("Theme name policy", () => {
    it("should list available themes (excludes dark/light aliases)", () => {
      const themes = listAvailableThemes();
      expect(themes).toContain("nord");
      expect(themes).toContain("gruvbox");
      expect(themes).toContain("custom");
      expect(themes).not.toContain("dark");
      expect(themes).not.toContain("light");
      expect(themes.length).toBeGreaterThanOrEqual(16);
    });
  });

  describe("OKLCH Hue Rotation", () => {
    it("should be identity for 0 degree rotation", () => {
      const red = new ColorRgba(255, 0, 0);
      const result = rotateHue(red, 0);
      expect(result.red).toBe(255);
      expect(result.green).toBe(0);
      expect(result.blue).toBe(0);
    });

    it("should round-trip for 360 degree rotation", () => {
      const color = new ColorRgba(133, 165, 152);
      const result = rotateHue(color, 360);
      expect(Math.abs(result.red - 133)).toBeLessThanOrEqual(2);
      expect(Math.abs(result.green - 165)).toBeLessThanOrEqual(2);
      expect(Math.abs(result.blue - 152)).toBeLessThanOrEqual(2);
    });

    it("should produce perceptually equal hue steps", () => {
      const base = new ColorRgba(200, 50, 50);
      const oklch0 = rgbaToOklch(rotateHue(base, 0));
      const oklch60 = rgbaToOklch(rotateHue(base, 60));
      const oklch120 = rgbaToOklch(rotateHue(base, 120));
      const oklch180 = rgbaToOklch(rotateHue(base, 180));

      // Lightness should be preserved (within gamut clamp tolerance)
      expect(Math.abs(oklch0.L - oklch60.L)).toBeLessThan(0.05);
      expect(Math.abs(oklch0.L - oklch120.L)).toBeLessThan(0.05);
      expect(Math.abs(oklch0.L - oklch180.L)).toBeLessThan(0.05);

      // All four should have distinct hue angles
      const hues = [oklch0.H, oklch60.H, oklch120.H, oklch180.H];
      const uniqueHues = new Set(hues.map((h) => h.toFixed(3)));
      expect(uniqueHues.size).toBe(4);
    });

    it("should produce different RGB values for different hue offsets", () => {
      const base = new ColorRgba(100, 150, 200);
      const r0 = rotateHue(base, 0);
      const r90 = rotateHue(base, 90);
      const r180 = rotateHue(base, 180);
      const r270 = rotateHue(base, 270);

      // All four should be visually distinct
      const unique = new Set([
        `${r0.red},${r0.green},${r0.blue}`,
        `${r90.red},${r90.green},${r90.blue}`,
        `${r180.red},${r180.green},${r180.blue}`,
        `${r270.red},${r270.green},${r270.blue}`,
      ]);
      expect(unique.size).toBe(4);
    });
  });

  describe("Style policy", () => {
    it("should include all four styles in STYLE_ORDER", () => {
      expect(STYLE_ORDER).toEqual(["surface", "muted", "button", "hue"]);
    });
  });
});
