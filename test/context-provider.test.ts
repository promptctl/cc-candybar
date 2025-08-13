import { ContextProvider } from "../src/lib/context-provider";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ContextProvider", () => {
  let contextProvider: ContextProvider;
  let tempDir: string;

  beforeEach(() => {
    contextProvider = new ContextProvider();
    tempDir = mkdtempSync(join(tmpdir(), "context-test-"));
  });

  afterEach(() => {
    try {
      unlinkSync(join(tempDir, "transcript.ndjson"));
    } catch {}
  });

  describe("calculateContextTokens", () => {
    it("should calculate context tokens from most recent main chain entry", () => {
      const mockTranscript = [
        '{"type": "user", "timestamp": "2025-08-13T15:00:00.000Z"}',
        '{"type": "assistant", "message": {"usage": {"input_tokens": 25000, "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 2000}}, "isSidechain": false, "timestamp": "2025-08-13T15:00:10.000Z"}',
        '{"type": "assistant", "message": {"usage": {"input_tokens": 20000}}, "isSidechain": true, "timestamp": "2025-08-13T15:00:15.000Z"}',
        '{"type": "assistant", "message": {"usage": {"input_tokens": 35000, "cache_read_input_tokens": 8000}}, "isSidechain": false, "timestamp": "2025-08-13T15:00:20.000Z"}',
      ].join("\n");

      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, mockTranscript);

      const result = contextProvider.calculateContextTokens(
        transcriptPath,
        "claude-3-5-sonnet-20241022"
      );

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(43000);
      expect(result!.percentage).toBe(22);
      expect(result!.usablePercentage).toBe(27);
      expect(result!.contextLeftPercentage).toBe(73);
      expect(result!.maxTokens).toBe(200000);
      expect(result!.usableTokens).toBe(160000);
    });

    it("should use 200K limit for all models", () => {
      const mockTranscript = [
        '{"type": "assistant", "message": {"usage": {"input_tokens": 150000}}, "isSidechain": false, "timestamp": "2025-08-13T15:00:10.000Z"}',
      ].join("\n");

      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, mockTranscript);

      const models = [
        "claude-opus-4.1-20250101",
        "claude-3-5-haiku-20241022",
        "claude-unknown-model",
      ];

      for (const modelId of models) {
        const result = contextProvider.calculateContextTokens(
          transcriptPath,
          modelId
        );
        expect(result).toBeDefined();
        expect(result!.inputTokens).toBe(150000);
        expect(result!.percentage).toBe(75);
        expect(result!.usablePercentage).toBe(94);
        expect(result!.contextLeftPercentage).toBe(6);
        expect(result!.maxTokens).toBe(200000);
        expect(result!.usableTokens).toBe(160000);
      }
    });

    it("should default to 200K when no model provided", () => {
      const mockTranscript = [
        '{"type": "assistant", "message": {"usage": {"input_tokens": 150000}}, "isSidechain": false, "timestamp": "2025-08-13T15:00:10.000Z"}',
      ].join("\n");

      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, mockTranscript);

      const result = contextProvider.calculateContextTokens(transcriptPath);

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(150000);
      expect(result!.percentage).toBe(75);
      expect(result!.usablePercentage).toBe(94);
      expect(result!.contextLeftPercentage).toBe(6);
      expect(result!.maxTokens).toBe(200000);
      expect(result!.usableTokens).toBe(160000);
    });

    it("should ignore sidechain entries", () => {
      const mockTranscript = [
        '{"type": "assistant", "message": {"usage": {"input_tokens": 10000}}, "isSidechain": false, "timestamp": "2025-08-13T15:00:10.000Z"}',
        '{"type": "assistant", "message": {"usage": {"input_tokens": 50000}}, "isSidechain": true, "timestamp": "2025-08-13T15:00:20.000Z"}',
      ].join("\n");

      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, mockTranscript);

      const result = contextProvider.calculateContextTokens(transcriptPath);

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(10000);
      expect(result!.usablePercentage).toBe(6);
      expect(result!.contextLeftPercentage).toBe(94);
    });

    it("should return null for empty transcript file", () => {
      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, "");

      const result = contextProvider.calculateContextTokens(transcriptPath);

      expect(result).toBeNull();
    });

    it("should return null for invalid NDJSON", () => {
      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, "invalid json");

      const result = contextProvider.calculateContextTokens(transcriptPath);

      expect(result).toBeNull();
    });

    it("should return null when no main chain entries with usage data", () => {
      const mockTranscript = [
        '{"type": "user", "timestamp": "2025-08-13T15:00:00.000Z"}',
        '{"type": "assistant", "message": {"usage": {"input_tokens": 5000}}, "isSidechain": true, "timestamp": "2025-08-13T15:00:10.000Z"}',
      ].join("\n");

      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, mockTranscript);

      const result = contextProvider.calculateContextTokens(transcriptPath);

      expect(result).toBeNull();
    });

    it("should handle entries without timestamps", () => {
      const mockTranscript = [
        '{"type": "assistant", "message": {"usage": {"input_tokens": 10000}}, "isSidechain": false}',
        '{"type": "assistant", "message": {"usage": {"input_tokens": 20000}}, "isSidechain": false, "timestamp": "2025-08-13T15:00:10.000Z"}',
      ].join("\n");

      const transcriptPath = join(tempDir, "transcript.ndjson");
      writeFileSync(transcriptPath, mockTranscript);

      const result = contextProvider.calculateContextTokens(transcriptPath);

      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(20000);
      expect(result!.usablePercentage).toBe(13);
      expect(result!.contextLeftPercentage).toBe(87);
    });
  });

  describe("getContextUsageThresholds", () => {
    it("should return default thresholds", () => {
      const thresholds = contextProvider.getContextUsageThresholds();

      expect(thresholds.LOW).toBe(50);
      expect(thresholds.MEDIUM).toBe(80);
    });
  });
});
