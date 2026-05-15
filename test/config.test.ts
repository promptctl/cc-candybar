import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import { loadConfig, loadConfigFromCLI } from "../src/config/loader";

jest.mock("node:fs");
jest.mock("node:os");

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

describe("config", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOs.homedir.mockReturnValue("/home/user");
    jest.spyOn(process, "cwd").mockReturnValue("/project");
  });

  describe("DEFAULT_CONFIG", () => {
    it("should have valid structure", () => {
      expect(DEFAULT_CONFIG.theme).toBe("random");
      expect(DEFAULT_CONFIG.display.lines).toHaveLength(1);
      expect(DEFAULT_CONFIG.display.style).toBe("random");
      expect(DEFAULT_CONFIG.budget?.session).toBeDefined();
    });
  });

  describe("loadConfig", () => {
    it("should return defaults when no config exists", () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    });

    it("should merge project config over defaults", () => {
      const projectConfig = { theme: "dark" };
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".cc-candybar.json"),
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(projectConfig));

      const config = loadConfig();
      expect(config.theme).toBe("dark");
      expect(config.display).toEqual(DEFAULT_CONFIG.display);
    });

    it("should handle invalid JSON gracefully", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("invalid json");

      const config = loadConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("CLI argument parsing", () => {
    it("should parse theme from CLI with = syntax", () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = loadConfigFromCLI(["node", "script", "--theme=dark"]);
      expect(config.theme).toBe("dark");
    });

    it("should parse theme from CLI with space syntax", () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = loadConfigFromCLI(["node", "script", "--theme", "dark"]);
      expect(config.theme).toBe("dark");
    });

    it("should parse capsule style from CLI with = syntax", () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = loadConfigFromCLI(["node", "script", "--style=capsule"]);
      expect(config.display.style).toBe("capsule");
    });

    it("should parse capsule style from CLI with space syntax", () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--style",
        "capsule",
      ]);
      expect(config.display.style).toBe("capsule");
    });

    it("should preserve display lines when setting style via CLI", () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = loadConfigFromCLI(["node", "script", "--style=powerline"]);
      expect(config.display.style).toBe("powerline");
      expect(config.display.lines).toHaveLength(
        DEFAULT_CONFIG.display.lines.length,
      );
      expect(config.display.lines[0]?.segments).toEqual(
        DEFAULT_CONFIG.display.lines[0]?.segments,
      );
    });

    it("should preserve display lines when setting invalid style via CLI", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      mockFs.existsSync.mockReturnValue(false);
      const config = loadConfigFromCLI(["node", "script", "--style=invalid"]);
      expect(config.display.style).toBe("minimal");
      expect(config.display.lines).toHaveLength(
        DEFAULT_CONFIG.display.lines.length,
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid display style"),
      );
      consoleSpy.mockRestore();
    });

    it("should load config file with --config= syntax", () => {
      const customConfig = { theme: "nord" as const };
      mockFs.existsSync.mockImplementation(
        (path) => path === "/custom/config.json",
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(customConfig));

      const config = loadConfigFromCLI([
        "node",
        "script",
        "--config=/custom/config.json",
      ]);
      expect(config.theme).toBe("nord");
    });

    it("should load config file with --config space syntax", () => {
      const customConfig = { theme: "rose-pine" as const };
      mockFs.existsSync.mockImplementation(
        (path) => path === "/custom/config.json",
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(customConfig));

      const config = loadConfigFromCLI([
        "node",
        "script",
        "--config",
        "/custom/config.json",
      ]);
      expect(config.theme).toBe("rose-pine");
    });

    it("should expand tilde in --config path", () => {
      const customConfig = { theme: "gruvbox" as const };
      mockFs.existsSync.mockImplementation(
        (path) => path === "/home/user/.config/powerline.json",
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify(customConfig));

      const config = loadConfigFromCLI([
        "node",
        "script",
        "--config",
        "~/.config/powerline.json",
      ]);
      expect(config.theme).toBe("gruvbox");
    });

    it("should accept theme=random as a valid config value (resolution is per-session)", () => {
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".cc-candybar.json"),
      );
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "random" }));

      const config = loadConfig();
      expect(config.theme).toBe("random");
    });

    it("should accept theme=random from CLI override", () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--theme",
        "random",
      ]);
      expect(config.theme).toBe("random");
    });
  });

  describe("environment variables", () => {
    beforeEach(() => {
      delete process.env.CC_CANDYBAR_THEME;
      delete process.env.CC_CANDYBAR_STYLE;
    });

    it("should preserve display lines when setting style via environment", () => {
      mockFs.existsSync.mockReturnValue(false);
      process.env.CC_CANDYBAR_STYLE = "powerline";
      const config = loadConfig();
      expect(config.display.style).toBe("powerline");
      expect(config.display.lines).toHaveLength(
        DEFAULT_CONFIG.display.lines.length,
      );
    });

    it("should handle capsule style from environment", () => {
      mockFs.existsSync.mockReturnValue(false);
      process.env.CC_CANDYBAR_STYLE = "capsule";
      const config = loadConfig();
      expect(config.display.style).toBe("capsule");
      expect(config.display.lines).toHaveLength(
        DEFAULT_CONFIG.display.lines.length,
      );
    });

    it("should handle invalid style from environment", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      mockFs.existsSync.mockReturnValue(false);
      process.env.CC_CANDYBAR_STYLE = "invalid";
      const config = loadConfig();
      expect(config.display.style).toBe("minimal");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid display style"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("configuration precedence", () => {
    beforeEach(() => {
      delete process.env.CC_CANDYBAR_THEME;
      delete process.env.CC_CANDYBAR_STYLE;
    });

    it("should prioritize CLI over environment over file", () => {
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".cc-candybar.json"),
      );
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ theme: "light", display: { style: "minimal" } }),
      );
      process.env.CC_CANDYBAR_THEME = "nord";
      process.env.CC_CANDYBAR_STYLE = "powerline";

      const config = loadConfigFromCLI([
        "node",
        "script",
        "--theme=rose-pine",
        "--style=minimal",
      ]);
      expect(config.theme).toBe("rose-pine");
      expect(config.display.style).toBe("minimal");
    });
  });

  describe("invalid config file values", () => {
    beforeEach(() => {
      delete process.env.CC_CANDYBAR_THEME;
      delete process.env.CC_CANDYBAR_STYLE;
    });

    it("should fallback invalid theme in config file to dark", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".cc-candybar.json"),
      );
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ theme: "invalid-theme" }),
      );

      const config = loadConfig();
      expect(config.theme).toBe("dark");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid theme"),
      );
      consoleSpy.mockRestore();
    });

    it("should fallback invalid style in config file to minimal", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".cc-candybar.json"),
      );
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ display: { style: "invalid-style" } }),
      );

      const config = loadConfig();
      expect(config.display.style).toBe("minimal");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid display style"),
      );
      consoleSpy.mockRestore();
    });

    it("should accept capsule style in config file", () => {
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".cc-candybar.json"),
      );
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ display: { style: "capsule" } }),
      );

      const config = loadConfig();
      expect(config.display.style).toBe("capsule");
    });
  });

  describe("--layout flag", () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false);
      stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("should produce one line per pipe-separated group", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "directory model | git",
      ]);
      expect(config.display.lines).toHaveLength(2);
      expect(Object.keys(config.display.lines[0]!.segments)).toEqual([
        "directory",
        "model",
      ]);
      expect(Object.keys(config.display.lines[1]!.segments)).toEqual(["git"]);
    });

    it("should seed segments from DEFAULT_CONFIG", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "session today",
      ]);
      expect(config.display.lines[0]!.segments.session).toMatchObject({
        enabled: true,
        type: "tokens",
        costSource: "calculated",
      });
      expect(config.display.lines[0]!.segments.today).toMatchObject({
        enabled: true,
        type: "cost",
      });
    });

    it("should always set enabled=true even when default is false", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "block tmux",
      ]);
      expect(config.display.lines[0]!.segments.block?.enabled).toBe(true);
      expect(config.display.lines[0]!.segments.tmux?.enabled).toBe(true);
    });

    it("should warn and skip unknown segment names", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "directory bogus git",
      ]);
      expect(Object.keys(config.display.lines[0]!.segments)).toEqual([
        "directory",
        "git",
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown segment "bogus"'),
      );
    });
  });

});
