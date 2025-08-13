import { PowerlineRenderer } from "../src/powerline";
import type { ClaudeHookData } from "../src/types";
import type { PowerlineConfig } from "../src/types/config";

jest.mock("ccusage/data-loader", () => ({
  loadSessionUsageById: jest.fn().mockResolvedValue({
    totalCost: 0.05,
    entries: [
      {
        message: {
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 50,
          },
        },
      },
    ],
  }),
  loadDailyUsageData: jest.fn().mockResolvedValue([
    {
      date: "2025-08-10",
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationTokens: 300,
      cacheReadTokens: 500,
      cost: 1.25,
    },
  ]),
  loadSessionBlockData: jest.fn().mockResolvedValue([
    {
      id: "2024-01-01T10:00:00.000Z",
      startTime: new Date("2024-01-01T10:00:00.000Z"),
      endTime: new Date("2024-01-01T15:00:00.000Z"),
      isActive: true,
      costUSD: 2.5,
      entries: [],
      tokenCounts: {
        inputTokens: 5000,
        outputTokens: 2000,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 100,
      },
    },
  ]),
  getClaudePaths: jest.fn().mockReturnValue(["/mock/path"]),
}));

jest.mock("ccusage/calculate-cost", () => ({
  calculateTotals: jest.fn().mockReturnValue({ totalCost: 1.25 }),
  getTotalTokens: jest.fn().mockReturnValue(7800),
}));

jest.mock("ccusage/logger", () => ({
  logger: { level: 1 },
}));

jest.mock("node:child_process", () => ({
  execSync: jest.fn().mockImplementation((cmd: string) => {
    if (cmd.includes("git branch --show-current")) return "main\n";
    if (cmd.includes("git status --porcelain")) return "";
    if (cmd.includes("tmux display-message -p '#S'")) return "mysession\n";
    return "";
  }),
}));

function createHookData(): ClaudeHookData {
  return {
    hook_event_name: "Status",
    session_id: "test-session-123",
    transcript_path: "/path/to/transcript.json",
    cwd: "/Users/test/claude-powerline",
    model: {
      id: "claude-opus-4",
      display_name: "Claude Opus",
    },
    workspace: {
      current_dir: "/Users/test/claude-powerline",
      project_dir: "/Users/test/claude-powerline",
    },
  };
}

function createConfig(segments: Record<string, unknown>): PowerlineConfig {
  return {
    theme: "light",
    display: { lines: [{ segments }] },
    budget: {
      today: { amount: 50, warningThreshold: 80 },
      session: { warningThreshold: 80 },
    },
  };
}

describe("PowerlineRenderer behavior", () => {
  describe("session usage display", () => {
    it("shows cost when type is cost", async () => {
      const config = createConfig({ session: { enabled: true, type: "cost" } });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("$0.05");
    });

    it("shows tokens when type is tokens", async () => {
      const config = createConfig({
        session: { enabled: true, type: "tokens" },
      });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("1.6K tokens");
    });

    it("shows both cost and tokens when type is both", async () => {
      const config = createConfig({ session: { enabled: true, type: "both" } });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("$0.05");
      expect(result).toContain("1.6K tokens");
    });
  });

  describe("budget warnings", () => {
    it("shows warning indicator when over threshold", async () => {
      const config = createConfig({ today: { enabled: true, type: "cost" } });
      config.budget!.today!.amount = 1.5;
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("!");
    });

    it("does not show percentage when no budget amount set", async () => {
      const config = createConfig({ today: { enabled: true, type: "cost" } });
      config.budget!.today = { warningThreshold: 80 };
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).not.toContain("%");
    });
  });

  describe("directory display", () => {
    it("shows project name when in project root", async () => {
      const config = createConfig({ directory: { enabled: true } });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("claude-powerline");
    });
  });

  describe("git integration", () => {
    it("shows branch name when git is available", async () => {
      const config = createConfig({ git: { enabled: true, showSha: false } });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("detached");
    });
  });

  describe("tmux integration", () => {
    it("shows session name when inside tmux", async () => {
      process.env.TMUX_PANE = "%1";

      const config = createConfig({ tmux: { enabled: true } });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("mysession");

      delete process.env.TMUX_PANE;
    });
  });

  describe("block segment", () => {
    it("shows cost rate by default", async () => {
      const config = createConfig({ block: { enabled: true } });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("$2.50");
      expect(result).toContain("/hr");
    });

    it("shows token rate when configured", async () => {
      const config = createConfig({ block: { enabled: true, type: "tokens" } });
      const renderer = new PowerlineRenderer(config);

      const result = await renderer.generateStatusline(createHookData());

      expect(result).toContain("tokens");
      expect(result).toContain("/hr");
    });
  });
});
