import { BlockProvider } from "../src/segments/block";
import { TodayProvider } from "../src/segments/today";
import { VersionProvider } from "../src/segments/version";
import { loadEntriesFromProjects } from "../src/utils/claude";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "node:child_process";

jest.mock("../src/utils/claude", () => ({
  loadEntriesFromProjects: jest.fn(),
}));

jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
  exec: jest
    .fn()
    .mockImplementation((cmd: string, _options: any, callback: any) => {
      let result = "1.0.81 (Claude Code)";
      if (typeof callback === "function") {
        callback(null, { stdout: result, stderr: "" });
      }
      return result;
    }),
}));

const mockLoadEntries = loadEntriesFromProjects as jest.MockedFunction<
  typeof loadEntriesFromProjects
>;

describe("Segment Time Logic", () => {
  let tempDir: string;
  let mockEntries: any[];

  beforeEach(() => {
    tempDir = join(tmpdir(), `powerline-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const now = new Date();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const hoursSinceMidnight = now.getHours();
    const blockNumber = Math.floor(hoursSinceMidnight / 5);
    const blockStart = new Date();
    blockStart.setHours(blockNumber * 5, 0, 0, 0);

    mockEntries = [
      {
        timestamp: new Date(midnight.getTime() + 2 * 60 * 60 * 1000),
        message: {
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 50,
          },
          model: "claude-3-5-sonnet",
        },
        costUSD: 25.5,
        raw: {},
      },
      {
        timestamp: new Date(blockStart.getTime() + 60 * 60 * 1000),
        message: {
          usage: {
            input_tokens: 2000,
            output_tokens: 1000,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 100,
          },
          model: "claude-3-5-sonnet",
        },
        costUSD: 45.75,
        raw: {},
      },
    ];

    mockLoadEntries.mockResolvedValue(mockEntries);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe("Block Segment", () => {
    it("should only include entries from current 5-hour window", async () => {
      const now = new Date();
      const hoursSinceMidnight = now.getHours();
      const blockNumber = Math.floor(hoursSinceMidnight / 5);
      const blockStart = new Date();
      blockStart.setHours(blockNumber * 5, 0, 0, 0);
      const blockEnd = new Date();
      blockEnd.setHours((blockNumber + 1) * 5, 0, 0, 0);

      const currentBlockEntry = {
        timestamp: new Date(blockStart.getTime() + 60 * 60 * 1000),
        message: {
          usage: {
            input_tokens: 2000,
            output_tokens: 1000,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 100,
          },
          model: "claude-3-5-sonnet",
        },
        costUSD: 45.75,
        raw: {},
      };

      mockLoadEntries.mockResolvedValue([currentBlockEntry]);

      const blockProvider = new BlockProvider();
      const blockInfo = await blockProvider.getActiveBlockInfo();

      expect(blockInfo.cost).toBe(45.75);
      expect(blockInfo.tokens).toBe(3300);
      expect(blockInfo.timeRemaining).toBeGreaterThan(0);
      expect(blockInfo.timeRemaining).toBeLessThanOrEqual(360);
    });

    it("should calculate correct time remaining in current block", async () => {
      const now = new Date();
      const hoursSinceMidnight = now.getHours();
      const blockNumber = Math.floor(hoursSinceMidnight / 5);
      const blockStart = new Date();
      blockStart.setHours(blockNumber * 5, 0, 0, 0);

      const mockEntry = {
        timestamp: new Date(blockStart.getTime() + 30 * 60 * 1000),
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          model: "claude-3-5-sonnet",
        },
        costUSD: 1.0,
        raw: {},
      };

      mockLoadEntries.mockResolvedValue([mockEntry]);

      const blockProvider = new BlockProvider();
      const blockInfo = await blockProvider.getActiveBlockInfo();

      const blockEnd = new Date();
      blockEnd.setHours((blockNumber + 1) * 5, 0, 0, 0);
      const expectedRemaining = Math.max(
        0,
        Math.round((blockEnd.getTime() - now.getTime()) / (1000 * 60))
      );

      expect(blockInfo.timeRemaining).toBe(expectedRemaining);
    });
  });

  describe("Today Segment", () => {
    it("should include all entries since midnight", async () => {
      const todayProvider = new TodayProvider();
      const todayInfo = await todayProvider.getTodayInfo();

      expect(todayInfo.cost).toBe(71.25);
      expect(todayInfo.tokens).toBe(4950);

      expect(todayInfo.tokenBreakdown).toBeDefined();
      expect(todayInfo.tokenBreakdown!.input).toBe(3000);
      expect(todayInfo.tokenBreakdown!.output).toBe(1500);
      expect(todayInfo.tokenBreakdown!.cacheCreation).toBe(300);
      expect(todayInfo.tokenBreakdown!.cacheRead).toBe(150);
    });

    it("should format date consistently using local time", async () => {
      const todayProvider = new TodayProvider();
      const todayInfo = await todayProvider.getTodayInfo();

      const expectedDate = new Date();
      const year = expectedDate.getFullYear();
      const month = String(expectedDate.getMonth() + 1).padStart(2, "0");
      const day = String(expectedDate.getDate()).padStart(2, "0");
      const expectedDateStr = `${year}-${month}-${day}`;

      expect(todayInfo.date).toBe(expectedDateStr);
    });
  });

  describe("Time Zone Consistency", () => {
    it("should use local time consistently across segments", async () => {
      const now = new Date();

      const hoursSinceMidnight = now.getHours();
      const blockNumber = Math.floor(hoursSinceMidnight / 5);
      const blockStart = new Date();
      blockStart.setHours(blockNumber * 5, 0, 0, 0);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      expect(blockStart.getTimezoneOffset()).toBe(now.getTimezoneOffset());
      expect(todayStart.getTimezoneOffset()).toBe(now.getTimezoneOffset());

      expect(blockStart.getTime()).toBeGreaterThanOrEqual(todayStart.getTime());
    });
  });

  describe("Edge Cases", () => {
    it("should handle no entries gracefully", async () => {
      mockLoadEntries.mockResolvedValue([]);

      const blockProvider = new BlockProvider();
      const todayProvider = new TodayProvider();

      const blockInfo = await blockProvider.getActiveBlockInfo();
      const todayInfo = await todayProvider.getTodayInfo();

      expect(blockInfo.cost).toBeNull();
      expect(blockInfo.tokens).toBeNull();
      expect(blockInfo.timeRemaining).toBeNull();

      expect(todayInfo.cost).toBeNull();
      expect(todayInfo.tokens).toBeNull();
      expect(todayInfo.tokenBreakdown).toBeNull();
    });

    it("should handle entries without usage data", async () => {
      const entriesWithoutUsage = [
        {
          timestamp: new Date(),
          message: {},
          costUSD: 0,
          raw: {},
        },
      ];

      mockLoadEntries.mockResolvedValue(entriesWithoutUsage);

      const blockProvider = new BlockProvider();
      const blockInfo = await blockProvider.getActiveBlockInfo();

      expect(blockInfo.cost).toBeNull();
      expect(blockInfo.tokens).toBeNull();
    });
  });

  describe("Version Segment", () => {
    it("should get Claude version", async () => {
      const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
      mockExecSync.mockReturnValue("1.0.81 (Claude Code)" as any);

      const provider = new VersionProvider();
      const info = await provider.getVersionInfo();

      expect(info.version).toBe("v1.0.81");
    });
  });
});
