import { stripAnsi, visibleLength } from "../src/utils/terminal";
import { DEFAULT_CONFIG } from "../src/config/defaults";

describe("terminal utilities", () => {
  describe("stripAnsi", () => {
    it("should remove ANSI color codes", () => {
      const input = "\x1b[38;2;255;0;0mred text\x1b[0m";
      expect(stripAnsi(input)).toBe("red text");
    });

    it("should handle multiple ANSI codes", () => {
      const input = "\x1b[48;2;0;0;255m\x1b[38;2;255;255;255m text \x1b[0m";
      expect(stripAnsi(input)).toBe(" text ");
    });

    it("should return unchanged string without ANSI codes", () => {
      const input = "plain text";
      expect(stripAnsi(input)).toBe("plain text");
    });

    it("should handle empty string", () => {
      expect(stripAnsi("")).toBe("");
    });
  });

  describe("visibleLength", () => {
    it("should return correct length without ANSI codes", () => {
      const input = "\x1b[38;2;255;0;0mhello\x1b[0m";
      expect(visibleLength(input)).toBe(5);
    });

    it("should return length of plain text", () => {
      expect(visibleLength("hello world")).toBe(11);
    });

    it("should return 0 for empty string", () => {
      expect(visibleLength("")).toBe(0);
    });

    it("should handle string with only ANSI codes", () => {
      expect(visibleLength("\x1b[0m\x1b[38;2;0;0;0m")).toBe(0);
    });
  });
});

describe("autoWrap functionality", () => {
  describe("configuration", () => {
    it("should have autoWrap true by default", () => {
      expect(DEFAULT_CONFIG.display.autoWrap).toBe(true);
    });
  });
});
