import {
  hexToBasicAnsi,
  hexToAnsi,
  hexTo256Ansi,
  extractBgToFg,
} from "../src/utils/colors";
import { getColorSupport } from "../src/utils/color-support";
import { resolveThemeColors, listAvailableThemes } from "../src/themes";
import { semanticMapping } from "../src/themes/default-mapping";

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

  describe("Theme Cascade", () => {
    it("should list available themes including old aliases", () => {
      const themes = listAvailableThemes();
      expect(themes).toContain("dark");
      expect(themes).toContain("light");
      expect(themes).toContain("nord");
      expect(themes).toContain("gruvbox");
      expect(themes).toContain("custom");
      expect(themes.length).toBeGreaterThanOrEqual(18);
    });

    it("should resolve theme colors for gruvbox", () => {
      const colors = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "truecolor",
      });
      expect(colors.modeBg).toBeTruthy();
      expect(colors.modeFg).toBeTruthy();
      expect(colors.gitBg).toBeTruthy();
      expect(colors.hex).toBeDefined();
      expect(colors.hex!.modeBg).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("should resolve theme colors for all built-in themes", () => {
      const themes = listAvailableThemes().filter((t) => t !== "custom");
      for (const name of themes) {
        const colors = resolveThemeColors({
          theme: name,
          colorSupport: "truecolor",
        });
        expect(colors.modeBg).toBeTruthy();
        expect(colors.hex!.modeBg).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    it("should produce distinct bg colors across segments", () => {
      const colors = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "truecolor",
      });
      const bgs = new Set([
        colors.hex!.modeBg,
        colors.hex!.gitBg,
        colors.hex!.modelBg,
        colors.hex!.sessionBg,
      ]);
      // Different palette variables should produce distinct colors
      expect(bgs.size).toBeGreaterThanOrEqual(3);
    });

    it("should apply user overrides per segment", () => {
      const base = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "truecolor",
      });
      const overridden = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "truecolor",
        themeMapping: {
          git: { bg: "error" },
        },
      });
      expect(overridden.hex!.gitBg).not.toBe(base.hex!.gitBg);
    });

    it("should apply fg overrides independently from bg", () => {
      const base = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "truecolor",
      });
      const overridden = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "truecolor",
        themeMapping: {
          directory: { fg: "text-primary" },
        },
      });
      expect(overridden.hex!.modeFg).not.toBe(base.hex!.modeFg);
      // bg should be unchanged
      expect(overridden.hex!.modeBg).toBe(base.hex!.modeBg);
    });

    it("should handle color compatibility modes", () => {
      const noneColors = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "none",
      });
      expect(noneColors.modeBg).toBe("");
      expect(noneColors.reset).toBe("");

      const ansi256Colors = resolveThemeColors({
        theme: "gruvbox",
        colorSupport: "ansi256",
      });
      expect(ansi256Colors.modeBg).toMatch(/^\x1b\[48;5;\d+m$/);
    });

    it("should throw for unknown themes", () => {
      expect(() =>
        resolveThemeColors({
          theme: "nonexistent-theme",
          colorSupport: "truecolor",
        }),
      ).toThrow(/Unknown theme palette/);
    });
  });

  describe("Default Mapping", () => {
    it("should have entries for all standard segments", () => {
      const segments = [
        "directory", "git", "gitTaculous", "model", "session",
        "block", "today", "tmux", "context", "contextWarning",
        "contextCritical", "metrics", "version", "env", "weekly",
      ];
      for (const seg of segments) {
        expect(semanticMapping[seg]).toBeDefined();
        expect(semanticMapping[seg]!.bg).toBeTruthy();
        expect(semanticMapping[seg]!.fg).toBeTruthy();
      }
    });

    it("should use warning/error for context warning/critical", () => {
      expect(semanticMapping.contextWarning!.bg).toBe("warning");
      expect(semanticMapping.contextCritical!.bg).toBe("error");
    });
  });
});
