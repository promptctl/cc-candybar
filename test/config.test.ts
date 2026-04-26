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
      expect(DEFAULT_CONFIG.theme).toBe("dark");
      expect(DEFAULT_CONFIG.display.lines).toHaveLength(1);
      expect(DEFAULT_CONFIG.display.style).toBe("minimal");
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
        (p) => p === path.join("/project", ".claude-powerline.json"),
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
  });

  describe("environment variables", () => {
    beforeEach(() => {
      delete process.env.CLAUDE_POWERLINE_THEME;
      delete process.env.CLAUDE_POWERLINE_STYLE;
    });

    it("should preserve display lines when setting style via environment", () => {
      mockFs.existsSync.mockReturnValue(false);
      process.env.CLAUDE_POWERLINE_STYLE = "powerline";
      const config = loadConfig();
      expect(config.display.style).toBe("powerline");
      expect(config.display.lines).toHaveLength(
        DEFAULT_CONFIG.display.lines.length,
      );
    });

    it("should handle capsule style from environment", () => {
      mockFs.existsSync.mockReturnValue(false);
      process.env.CLAUDE_POWERLINE_STYLE = "capsule";
      const config = loadConfig();
      expect(config.display.style).toBe("capsule");
      expect(config.display.lines).toHaveLength(
        DEFAULT_CONFIG.display.lines.length,
      );
    });

    it("should handle invalid style from environment", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      mockFs.existsSync.mockReturnValue(false);
      process.env.CLAUDE_POWERLINE_STYLE = "invalid";
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
      delete process.env.CLAUDE_POWERLINE_THEME;
      delete process.env.CLAUDE_POWERLINE_STYLE;
    });

    it("should prioritize CLI over environment over file", () => {
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".claude-powerline.json"),
      );
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ theme: "light", display: { style: "minimal" } }),
      );
      process.env.CLAUDE_POWERLINE_THEME = "nord";
      process.env.CLAUDE_POWERLINE_STYLE = "powerline";

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
      delete process.env.CLAUDE_POWERLINE_THEME;
      delete process.env.CLAUDE_POWERLINE_STYLE;
    });

    it("should fallback invalid theme in config file to dark", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".claude-powerline.json"),
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
        (p) => p === path.join("/project", ".claude-powerline.json"),
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
        (p) => p === path.join("/project", ".claude-powerline.json"),
      );
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ display: { style: "capsule" } }),
      );

      const config = loadConfig();
      expect(config.display.style).toBe("capsule");
    });
  });

  describe("grid config validation", () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
      stderrSpy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    function loadWithGrid(tui: any) {
      mockFs.existsSync.mockImplementation(
        (p) => p === path.join("/project", ".claude-powerline.json"),
      );
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ display: { style: "tui", tui } }),
      );
      return loadConfig();
    }

    it("should accept valid grid config", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session"],
            columns: ["1fr", "1fr"],
            align: ["left", "right"],
          },
        ],
      });
      expect(config.display.tui).toBeDefined();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("should reject grid config with no breakpoints", () => {
      const config = loadWithGrid({ breakpoints: [] });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("at least one breakpoint"),
      );
    });

    it("should reject grid config with missing breakpoints", () => {
      const config = loadWithGrid({});
      expect(config.display.tui).toBeUndefined();
    });

    it("should reject grid config with negative minWidth", () => {
      const config = loadWithGrid({
        breakpoints: [{ minWidth: -1, areas: ["block"], columns: ["1fr"] }],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("minWidth"),
      );
    });

    it("should reject grid config with column count mismatch", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session today"],
            columns: ["1fr", "1fr"], // 2 columns but 3 cells
          },
        ],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("cells but expected"),
      );
    });

    it("should reject grid config with unknown segment name", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block unknown_seg"],
            columns: ["1fr", "1fr"],
          },
        ],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("unknown segment"),
      );
    });

    it("should reject grid config with align length mismatch", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session"],
            columns: ["1fr", "1fr"],
            align: ["left"], // 1 align but 2 columns
          },
        ],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("align length"),
      );
    });

    it("should reject grid config with invalid align value", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session"],
            columns: ["1fr", "1fr"],
            align: ["left", "middle"],
          },
        ],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("invalid align"),
      );
    });

    it("should reject grid config with invalid column definition", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session"],
            columns: ["1fr", "minmax(10,1fr)"],
          },
        ],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("invalid column definition"),
      );
    });

    it("should reject grid config with non-contiguous spans", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session block"], // block is not contiguous
            columns: ["1fr", "1fr", "1fr"],
          },
        ],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("non-contiguous"),
      );
    });

    it("should reject grid config with segment on multiple rows", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session", "block today"],
            columns: ["1fr", "1fr"],
          },
        ],
      });
      expect(config.display.tui).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("multiple rows"),
      );
    });

    it("should allow . cells and --- divider rows", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block . session", "---", "git . dir"],
            columns: ["1fr", "auto", "1fr"],
          },
        ],
      });
      expect(config.display.tui).toBeDefined();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("should allow contiguous spans", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["context context context"],
            columns: ["1fr", "1fr", "1fr"],
          },
        ],
      });
      expect(config.display.tui).toBeDefined();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("should accept valid column types: auto, fr, fixed", () => {
      const config = loadWithGrid({
        breakpoints: [
          {
            minWidth: 0,
            areas: ["block session today"],
            columns: ["auto", "2fr", "20"],
          },
        ],
      });
      expect(config.display.tui).toBeDefined();
      expect(stderrSpy).not.toHaveBeenCalled();
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

  describe("--set flag", () => {
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

    it("should write a literal dotted path", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--set",
        "display.padding=2",
      ]);
      expect(config.display.padding).toBe(2);
    });

    it("should treat bareword as boolean true", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "git",
        "--set",
        "segment.git.showWorkingTree",
      ]);
      expect(config.display.lines[0]!.segments.git?.showWorkingTree).toBe(true);
    });

    it("should parse true/false/numbers", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "context",
        "--set",
        "segment.context.showPercentageOnly=false",
        "--set",
        "segment.context.autocompactBuffer=12345",
      ]);
      expect(
        config.display.lines[0]!.segments.context?.showPercentageOnly,
      ).toBe(false);
      expect(config.display.lines[0]!.segments.context?.autocompactBuffer).toBe(
        12345,
      );
    });

    it("should resolve segment.<name>.<key> via the layout", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "directory | git",
        "--set",
        "segment.git.showUpstream=true",
      ]);
      expect(config.display.lines[1]!.segments.git?.showUpstream).toBe(true);
    });

    it("should warn when segment.<name> is not in the layout", () => {
      loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "directory",
        "--set",
        "segment.git.showSha=true",
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('segment "git" is not in the layout'),
      );
    });

    it("should split color.<name>=#bg/#fg into bg+fg writes", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--set",
        "color.git=#3a3a3a/#d0d0d0",
      ]);
      expect(config.colors?.custom.git).toEqual({
        bg: "#3a3a3a",
        fg: "#d0d0d0",
      });
    });

    it("should write color.<name>.bg and color.<name>.fg separately", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--set",
        "color.session.bg=#5a5a5a",
        "--set",
        "color.session.fg=#b0b0b0",
      ]);
      expect(config.colors?.custom.session).toEqual({
        bg: "#5a5a5a",
        fg: "#b0b0b0",
      });
    });

    it("should warn when color.<name> value lacks a slash", () => {
      loadConfigFromCLI(["node", "script", "--set", "color.git=#aabbcc"]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('expects "#bg/#fg"'),
      );
    });

    it("should rewrite budget.<name>.<key>", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--set",
        "budget.today.amount=5",
        "--set",
        "budget.today.warningThreshold=80",
      ]);
      expect(config.budget?.today?.amount).toBe(5);
      expect(config.budget?.today?.warningThreshold).toBe(80);
    });

    it("should rewrite modelLimit.<name> to modelContextLimits.<name>", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--set",
        "modelLimit.sonnet=200000",
      ]);
      expect(config.modelContextLimits?.sonnet).toBe(200000);
    });

    it("should accept --set=KEY=VALUE syntax", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--set=theme=custom",
        "--set=display.style=capsule",
      ]);
      expect(config.theme).toBe("custom");
      expect(config.display.style).toBe("capsule");
    });

    it("should be repeatable", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "git",
        "--set",
        "segment.git.showWorkingTree",
        "--set",
        "segment.git.showUpstream",
        "--set",
        "segment.git.showTimeSinceCommit",
      ]);
      const git = config.display.lines[0]!.segments.git!;
      expect(git.showWorkingTree).toBe(true);
      expect(git.showUpstream).toBe(true);
      expect(git.showTimeSinceCommit).toBe(true);
    });
  });

  describe("--show flag", () => {
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

    it("should expand to multiple show* booleans", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "git",
        "--show",
        "git=workingTree,upstream,timeSinceCommit,repoName",
      ]);
      const git = config.display.lines[0]!.segments.git!;
      expect(git.showWorkingTree).toBe(true);
      expect(git.showUpstream).toBe(true);
      expect(git.showTimeSinceCommit).toBe(true);
      expect(git.showRepoName).toBe(true);
    });

    it("should accept already-capitalized flag names (idempotent)", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "git",
        "--show",
        "git=WorkingTree,Upstream",
      ]);
      const git = config.display.lines[0]!.segments.git!;
      expect(git.showWorkingTree).toBe(true);
      expect(git.showUpstream).toBe(true);
    });

    it("should accept --show=KEY=VALUE syntax", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "metrics",
        "--show=metrics=responseTime,duration,messageCount",
      ]);
      const metrics = config.display.lines[0]!.segments.metrics!;
      expect(metrics.showResponseTime).toBe(true);
      expect(metrics.showDuration).toBe(true);
      expect(metrics.showMessageCount).toBe(true);
    });

    it("should warn when format is missing the =", () => {
      loadConfigFromCLI(["node", "script", "--show", "gitnoEquals"]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("expects"),
      );
    });

    it("should warn when segment is not in the layout", () => {
      loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "directory",
        "--show",
        "git=workingTree",
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('segment "git" is not in the layout'),
      );
    });

    it("should be repeatable across multiple segments", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "git | metrics",
        "--show",
        "git=workingTree,upstream",
        "--show",
        "metrics=responseTime,duration",
      ]);
      expect(config.display.lines[0]!.segments.git?.showWorkingTree).toBe(
        true,
      );
      expect(config.display.lines[0]!.segments.git?.showUpstream).toBe(true);
      expect(
        config.display.lines[1]!.segments.metrics?.showResponseTime,
      ).toBe(true);
      expect(config.display.lines[1]!.segments.metrics?.showDuration).toBe(
        true,
      );
    });
  });

  describe("--display flag", () => {
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

    it("should write a single display.<k>=<v>", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--display",
        "autoWrap=false",
      ]);
      expect(config.display.autoWrap).toBe(false);
    });

    it("should write comma-separated display fields", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--display",
        "autoWrap=false,padding=2",
      ]);
      expect(config.display.autoWrap).toBe(false);
      expect(config.display.padding).toBe(2);
    });

    it("should warn on missing =", () => {
      loadConfigFromCLI(["node", "script", "--display", "noEquals"]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("expects"),
      );
    });

    it("should accept --display=KEY=VALUE syntax", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--display=padding=3",
      ]);
      expect(config.display.padding).toBe(3);
    });
  });

  describe("--segment flag", () => {
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

    it("should write a single segment.<seg>.<field>=<value>", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "block",
        "--segment",
        "block.type=weighted",
      ]);
      expect(config.display.lines[0]!.segments.block?.type).toBe("weighted");
    });

    it("should support multiple segments and fields in one flag", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "block | sessionId",
        "--segment",
        "block.type=weighted,sessionId.length=8",
      ]);
      expect(config.display.lines[0]!.segments.block?.type).toBe("weighted");
      expect(config.display.lines[1]!.segments.sessionId?.length).toBe(8);
    });

    it("should warn when entry has no segment.field structure", () => {
      loadConfigFromCLI(["node", "script", "--segment", "noDot=value"]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("expects"),
      );
    });

    it("should warn when segment is not in layout", () => {
      loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "directory",
        "--segment",
        "git.showSha=true",
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('segment "git" is not in the layout'),
      );
    });
  });

  describe("flag dispatch order", () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false);
    });

    it("should apply overrides in argv order across flag types", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "git",
        "--show",
        "git=workingTree",
        "--set",
        "segment.git.showWorkingTree=false",
      ]);
      expect(config.display.lines[0]!.segments.git?.showWorkingTree).toBe(
        false,
      );
    });

    it("should let later --show win over earlier --set", () => {
      const config = loadConfigFromCLI([
        "node",
        "script",
        "--layout",
        "git",
        "--set",
        "segment.git.showWorkingTree=false",
        "--show",
        "git=workingTree",
      ]);
      expect(config.display.lines[0]!.segments.git?.showWorkingTree).toBe(
        true,
      );
    });
  });
});
