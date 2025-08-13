import { MetricsProvider } from "../src/segments/metrics";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as claudePaths from "../src/utils/claude";

describe("Metrics Provider", () => {
  let tempDir: string;
  let metricsProvider: MetricsProvider;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metrics-test-"));
    metricsProvider = new MetricsProvider();
  });

  afterEach(() => {
    try {
      unlinkSync(join(tempDir, "test.jsonl"));
    } catch {}
  });

  it("calculates metrics from valid transcript", async () => {
    const transcriptContent = [
      '{"timestamp": "2024-01-01T10:00:00Z", "type": "user", "message": {"content": "Hello"}}',
      '{"timestamp": "2024-01-01T10:00:05Z", "type": "assistant", "message": {"content": "Hi!", "usage": {"input_tokens": 10, "output_tokens": 20}}, "costUSD": 0.001}',
      '{"timestamp": "2024-01-01T10:01:00Z", "type": "user", "message": {"content": "How are you?"}}',
      '{"timestamp": "2024-01-01T10:01:03Z", "type": "assistant", "message": {"content": "Good!", "usage": {"input_tokens": 15, "output_tokens": 25}}, "costUSD": 0.0015}'
    ].join("\n");

    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, transcriptContent);

    jest.spyOn(claudePaths, "findTranscriptFile").mockResolvedValue(transcriptPath);

    const metrics = await metricsProvider.getMetricsInfo("test-session");

    expect(metrics.messageCount).toBe(2);
    expect(metrics.sessionDuration).toBeGreaterThan(0);
    expect(metrics.responseTime).toBeGreaterThan(0);
    expect(metrics.costBurnRate).toBeGreaterThan(0);
    expect(metrics.tokenBurnRate).toBeGreaterThan(0);
  });

  it("handles missing transcript gracefully", async () => {
    jest.spyOn(claudePaths, "findTranscriptFile").mockResolvedValue(null);

    const metrics = await metricsProvider.getMetricsInfo("nonexistent-session");

    expect(metrics.messageCount).toBeNull();
    expect(metrics.sessionDuration).toBeNull();
    expect(metrics.responseTime).toBeNull();
    expect(metrics.costBurnRate).toBeNull();
    expect(metrics.tokenBurnRate).toBeNull();
  });

  it("handles empty transcript gracefully", async () => {
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, "");

    jest.spyOn(claudePaths, "findTranscriptFile").mockResolvedValue(transcriptPath);

    const metrics = await metricsProvider.getMetricsInfo("empty-session");

    expect(metrics.messageCount).toBeNull();
    expect(metrics.sessionDuration).toBeNull();
    expect(metrics.responseTime).toBeNull();
    expect(metrics.costBurnRate).toBeNull();
    expect(metrics.tokenBurnRate).toBeNull();
  });
});