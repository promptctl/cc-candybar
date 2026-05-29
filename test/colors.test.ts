import {
  hexToBasicAnsi,
  hexToAnsi,
  hexTo256Ansi,
  extractBgToFg,
} from "../src/utils/colors";
import { getColorSupport } from "../src/utils/color-support";
import { listAvailableThemes, STYLE_ORDER } from "../src/themes";

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

  describe("Style policy", () => {
    it("should include all four styles in STYLE_ORDER", () => {
      expect(STYLE_ORDER).toEqual(["surface", "muted", "button", "hue"]);
    });
  });
});
