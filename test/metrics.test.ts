import { MetricsProvider } from "../src/segments/metrics";
import {
  writeFileSync,
  appendFileSync,
  unlinkSync,
  mkdtempSync,
  utimesSync,
  chmodSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ClaudeHookData } from "../src/utils/claude";
import { clearParseCache } from "../src/utils/claude";

describe("Metrics Provider", () => {
  let tempDir: string;
  let metricsProvider: MetricsProvider;

  const createMockHookData = (
    sessionId: string,
    transcriptPath: string,
  ): ClaudeHookData => ({
    hook_event_name: "Status",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: "/test/cwd",
    model: {
      id: "claude-opus-4-1",
      display_name: "Opus",
    },
    workspace: {
      current_dir: "/test/workspace",
      project_dir: "/test/project",
      added_dirs: [],
    },
    version: "1.0.0",
    cost: {
      total_cost_usd: 0.5,
      total_duration_ms: 120000,
      total_api_duration_ms: 5000,
      total_lines_added: 25,
      total_lines_removed: 10,
    },
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metrics-test-"));
    metricsProvider = new MetricsProvider();
    clearParseCache();
  });

  afterEach(() => {
    try {
      unlinkSync(join(tempDir, "test.jsonl"));
    } catch {}
  });

  it("calculates metrics from valid transcript", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const transcriptContent = [
      `{"timestamp": "${new Date(oneHourAgo.getTime()).toISOString()}", "type": "user", "message": {"content": "Hello"}}`,
      `{"timestamp": "${new Date(oneHourAgo.getTime() + 5000).toISOString()}", "type": "assistant", "message": {"content": "Hi!", "usage": {"input_tokens": 10, "output_tokens": 20}}, "costUSD": 0.50}`,
      `{"timestamp": "${new Date(oneHourAgo.getTime() + 60000).toISOString()}", "type": "user", "message": {"content": "How are you?"}}`,
      `{"timestamp": "${new Date(oneHourAgo.getTime() + 63000).toISOString()}", "type": "assistant", "message": {"content": "Good!", "usage": {"input_tokens": 15, "output_tokens": 25}}, "costUSD": 0.75}`,
    ].join("\n");

    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, transcriptContent);

    const mockHookData = createMockHookData("test-session", transcriptPath);
    const outcome = await metricsProvider.getMetricsInfo(
      "test-session",
      mockHookData
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const metrics = outcome.value;
    expect(metrics.messageCount).toBe(2);
    expect(metrics.sessionDuration).toBe(120);
    expect(metrics.responseTime).toBe(5);
    expect(metrics.lastResponseTime).toBeGreaterThan(0);
    expect(metrics.linesAdded).toBe(25);
    expect(metrics.linesRemoved).toBe(10);
  });

  // A transcript that doesn't exist yet is the domain's "no entries" (new
  // session pre-first-write): the cost-block fields are real, the
  // transcript-derived counts are genuinely zero.
  it("handles missing transcript gracefully", async () => {
    const mockHookData = createMockHookData(
      "nonexistent-session",
      join(tempDir, "nonexistent.jsonl"),
    );
    const outcome = await metricsProvider.getMetricsInfo(
      "nonexistent-session",
      mockHookData
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.messageCount).toBe(0);
    expect(outcome.value.sessionDuration).toBe(120);
    expect(outcome.value.responseTime).toBe(5);
    expect(outcome.value.lastResponseTime).toBeNull();
    expect(outcome.value.linesAdded).toBe(25);
    expect(outcome.value.linesRemoved).toBe(10);
  });

  // [LAW:no-silent-failure] An UNREADABLE transcript (exists, can't be read)
  // is a loud `failed` carrying the reason — not a confident record with
  // zeros where the transcript-derived fields should be.
  it("maps an unreadable transcript to a failed outcome", async () => {
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, `{"type":"user"}`);
    chmodSync(transcriptPath, 0o000);

    const mockHookData = createMockHookData("locked-session", transcriptPath);
    const outcome = await metricsProvider.getMetricsInfo(
      "locked-session",
      mockHookData
    );
    chmodSync(transcriptPath, 0o644);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("locked-session");
  });

  it("reports absent when the hook data has no cost block", async () => {
    const mockHookData = {
      ...createMockHookData("no-cost-session", join(tempDir, "test.jsonl")),
      cost: undefined,
    };
    const outcome = await metricsProvider.getMetricsInfo(
      "no-cost-session",
      mockHookData
    );

    expect(outcome.kind).toBe("absent");
  });

  it("reuses the folded result when transcript mtime is unchanged (foldMetrics fast-hit, no re-read)", async () => {
    const transcriptPath = join(tempDir, "test.jsonl");
    const fixedMtime = new Date(Date.now() - 60_000);
    // Two `user` lines → messageCount 2. v2 flips the second line's type
    // "user" → "xxxx" (byte-length identical) → a fresh parse would count 1.
    // Each record is newline-terminated: the incremental reader consumes only
    // complete lines (a trailing partial line waits for its \n), matching how
    // Claude writes JSONL — so a complete transcript ends in \n.
    const line = (type: string, ts: string) =>
      `{"timestamp":"${ts}","type":"${type}","message":{"content":"hi"}}\n`;
    const t0 = new Date("2024-01-01T00:00:00.000Z").toISOString();
    const t1 = new Date("2024-01-01T00:00:01.000Z").toISOString();
    const v1 = line("user", t0) + line("user", t1);
    const v2 = line("user", t0) + line("xxxx", t1);

    const hookData = createMockHookData("cache-session", transcriptPath);

    writeFileSync(transcriptPath, v1);
    utimesSync(transcriptPath, fixedMtime, fixedMtime);
    const warm = await metricsProvider.getMetricsInfo("cache-session", hookData);
    expect(warm.kind === "ok" && warm.value.messageCount).toBe(2);

    // Mutate content but hold mtime identical: foldMetrics's mtime gate is
    // unchanged, so the fast-hit returns the folded 2; a re-read would observe
    // v2 and return 1.
    expect(v2.length).toBe(v1.length);
    writeFileSync(transcriptPath, v2);
    utimesSync(transcriptPath, fixedMtime, fixedMtime);
    const cached = await metricsProvider.getMetricsInfo(
      "cache-session",
      hookData,
    );
    expect(cached.kind === "ok" && cached.value.messageCount).toBe(2);
  });

  it("folds appended user lines incrementally — count increments by the new lines only", async () => {
    const transcriptPath = join(tempDir, "inc.jsonl");
    let t = 1_700_000_000_000;
    const userLine = () =>
      JSON.stringify({
        timestamp: new Date((t += 1000)).toISOString(),
        type: "user",
        message: { role: "user", content: "hi" },
      }) + "\n";
    // Two real user turns to start.
    writeFileSync(transcriptPath, userLine() + userLine());
    let mtime = 1_700_000_000;
    utimesSync(transcriptPath, mtime, mtime);
    const hd = createMockHookData("inc-session", transcriptPath);

    const first = await metricsProvider.getMetricsInfo("inc-session", hd);
    expect(first.kind === "ok" && first.value.messageCount).toBe(2);
    // No assistant turn yet → no user→assistant pair → no response time.
    expect(first.kind === "ok" && first.value.lastResponseTime).toBeNull();

    // Append ONE more user turn; advance mtime so the fold sees the change. A
    // correct incremental fold reports 3 (adds one), not a re-count from scratch
    // that happens to also be 3 — verified next by appending a non-user line.
    appendFileSync(transcriptPath, userLine());
    utimesSync(transcriptPath, ++mtime, mtime);
    const second = await metricsProvider.getMetricsInfo("inc-session", hd);
    expect(second.kind === "ok" && second.value.messageCount).toBe(3);
    expect(second.kind === "ok" && second.value.lastResponseTime).toBeNull();

    // Append an assistant line 1s after the last user turn — messageCount must
    // NOT change (only real user turns count), AND lastResponseTime must now
    // reflect that 1s user→assistant gap: proves the recent ring is maintained
    // incrementally (right entries, right order), not just the count.
    appendFileSync(
      transcriptPath,
      JSON.stringify({
        timestamp: new Date((t += 1000)).toISOString(),
        type: "assistant",
        message: { role: "assistant", content: "hello" },
      }) + "\n",
    );
    utimesSync(transcriptPath, ++mtime, mtime);
    const third = await metricsProvider.getMetricsInfo("inc-session", hd);
    expect(third.kind === "ok" && third.value.messageCount).toBe(3);
    expect(third.kind === "ok" && third.value.lastResponseTime).toBeCloseTo(
      1.0,
      3,
    );
  });

  it("handles empty transcript gracefully", async () => {
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, "");

    const mockHookData = createMockHookData("empty-session", transcriptPath);
    const outcome = await metricsProvider.getMetricsInfo(
      "empty-session",
      mockHookData
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.messageCount).toBe(0);
    expect(outcome.value.sessionDuration).toBe(120);
    expect(outcome.value.responseTime).toBe(5);
    expect(outcome.value.lastResponseTime).toBeNull();
    expect(outcome.value.linesAdded).toBe(25);
    expect(outcome.value.linesRemoved).toBe(10);
  });
});
