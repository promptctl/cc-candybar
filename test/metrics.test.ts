import { MetricsProvider, metricsOver } from "../src/segments/metrics";
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
import { ABSENT, failed, ok, pendingOf } from "../src/utils/outcome";
import { systemTimekeeper } from "../src/time";

describe("Metrics Provider", () => {
  let tempDir: string;
  let metricsProvider: MetricsProvider;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metrics-test-"));
    metricsProvider = new MetricsProvider({ clock: systemTimekeeper });
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

    const outcome = await metricsProvider.refresh(
      "test-session",
      transcriptPath,
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const metrics = outcome.value;
    expect(metrics.messageCount).toBe(2);
    expect(metrics.lastResponseTime).toBeGreaterThan(0);
  });

  // brandon-effects-2gka.2rm: Claude Code writes user entries no person typed (a
  // skill's body, a nudge to continue, a task notification); none is a message.
  it("counts prompts, and the other user entries apart from them", async () => {
    const t0 = Date.now() - 60 * 60 * 1000;
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(
      transcriptPath,
      [
        `{"timestamp": "${at(0)}", "type": "user", "message": {"role": "user", "content": "go"}}`,
        `{"timestamp": "${at(1)}", "type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a", "name": "Bash", "input": {}}]}}`,
        `{"timestamp": "${at(2)}", "type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": "ok"}]}}`,
        `{"timestamp": "${at(4)}", "type": "user", "isMeta": true, "message": {"role": "user", "content": [{"type": "text", "text": "Your previous response had no visible output. Please continue and produce a user-visible response."}]}}`,
        `{"timestamp": "${at(5)}", "type": "user", "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": "<task-notification>done</task-notification>"}}`,
        `{"timestamp": "${at(6)}", "type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user]"}]}}`,
        "",
      ].join("\n"),
    );

    const outcome = await metricsProvider.refresh(
      "meta-session",
      transcriptPath,
    );
    expect(outcome.kind === "ok" && outcome.value).toMatchObject({
      messageCount: 1,
      nonPrompts: 3,
    });
  });

  it("times the last response from the prompt, not from an entry Claude Code wrote mid-turn", async () => {
    const t0 = Date.now() - 60 * 60 * 1000;
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(
      transcriptPath,
      [
        `{"timestamp": "${at(0)}", "type": "user", "message": {"role": "user", "content": "go"}}`,
        `{"timestamp": "${at(10)}", "type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}}`,
        `{"timestamp": "${at(20)}", "type": "user", "isMeta": true, "message": {"role": "user", "content": [{"type": "text", "text": "Base directory for this skill: x"}]}}`,
        `{"timestamp": "${at(25)}", "type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}}`,
        "",
      ].join("\n"),
    );

    const outcome = await metricsProvider.refresh(
      "clock-session",
      transcriptPath,
    );
    expect(outcome.kind === "ok" && outcome.value.lastResponseTime).toBe(25);
  });

  it("restarts the clock where Claude Code opens another turn of the prompt", async () => {
    const t0 = Date.now() - 60 * 60 * 1000;
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(
      transcriptPath,
      [
        `{"timestamp": "${at(0)}", "type": "user", "message": {"role": "user", "content": "go"}}`,
        `{"timestamp": "${at(10)}", "type": "assistant", "message": {"content": [{"type": "text", "text": "started"}]}}`,
        `{"timestamp": "${at(1000)}", "type": "user", "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": "<task-notification>done</task-notification>"}}`,
        `{"timestamp": "${at(1005)}", "type": "assistant", "message": {"content": [{"type": "text", "text": "noted"}]}}`,
        "",
      ].join("\n"),
    );

    const outcome = await metricsProvider.refresh(
      "turn-session",
      transcriptPath,
    );
    expect(outcome.kind === "ok" && outcome.value.lastResponseTime).toBe(5);
  });

  // A transcript that doesn't exist yet is the domain's "no entries" (new
  // session pre-first-write): the counts are genuinely zero.
  it("handles missing transcript gracefully", async () => {
    const outcome = await metricsProvider.refresh(
      "nonexistent-session",
      join(tempDir, "nonexistent.jsonl"),
    );

    expect(outcome).toEqual(
      ok({ messageCount: 0, nonPrompts: 0, lastResponseTime: null }),
    );
  });

  // [LAW:no-silent-failure] An UNREADABLE transcript (exists, can't be read)
  // is a loud `failed` carrying the reason — not a confident record with
  // zeros where the transcript-derived fields should be.
  it("maps an unreadable transcript to a failed outcome", async () => {
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, `{"type":"user"}`);
    chmodSync(transcriptPath, 0o000);

    const outcome = await metricsProvider.refresh(
      "locked-session",
      transcriptPath,
    );
    chmodSync(transcriptPath, 0o644);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("locked-session");
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

    writeFileSync(transcriptPath, v1);
    utimesSync(transcriptPath, fixedMtime, fixedMtime);
    const warm = await metricsProvider.refresh("cache-session", transcriptPath);
    expect(warm.kind === "ok" && warm.value.messageCount).toBe(2);

    // Mutate content but hold mtime identical: foldMetrics's mtime gate is
    // unchanged, so the fast-hit returns the folded 2; a re-read would observe
    // v2 and return 1.
    expect(v2.length).toBe(v1.length);
    writeFileSync(transcriptPath, v2);
    utimesSync(transcriptPath, fixedMtime, fixedMtime);
    const cached = await metricsProvider.refresh(
      "cache-session",
      transcriptPath,
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
    const first = await metricsProvider.refresh("inc-session", transcriptPath);
    expect(first.kind === "ok" && first.value.messageCount).toBe(2);
    // No assistant turn yet → no user→assistant pair → no response time.
    expect(first.kind === "ok" && first.value.lastResponseTime).toBeNull();

    // Append ONE more user turn; advance mtime so the fold sees the change. A
    // correct incremental fold reports 3 (adds one), not a re-count from scratch
    // that happens to also be 3 — verified next by appending a non-user line.
    appendFileSync(transcriptPath, userLine());
    utimesSync(transcriptPath, ++mtime, mtime);
    const second = await metricsProvider.refresh("inc-session", transcriptPath);
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
    const third = await metricsProvider.refresh("inc-session", transcriptPath);
    expect(third.kind === "ok" && third.value.messageCount).toBe(3);
    expect(third.kind === "ok" && third.value.lastResponseTime).toBeCloseTo(
      1.0,
      3,
    );
  });

  it("handles empty transcript gracefully", async () => {
    const transcriptPath = join(tempDir, "test.jsonl");
    writeFileSync(transcriptPath, "");

    const outcome = await metricsProvider.refresh(
      "empty-session",
      transcriptPath,
    );

    expect(outcome).toEqual(
      ok({ messageCount: 0, nonPrompts: 0, lastResponseTime: null }),
    );
  });
});

// The session's metrics as the renderer composes them: the hook's durations
// and lines over the transcript's fold.
describe("metricsOver", () => {
  const fold = { messageCount: 2, nonPrompts: 1, lastResponseTime: 4 };
  const hook = (cost?: ClaudeHookData["cost"]) =>
    ({ session_id: "s", cost }) as ClaudeHookData;
  const cost = {
    total_cost_usd: 0.5,
    total_duration_ms: 120000,
    total_api_duration_ms: 5000,
    total_lines_added: 25,
    total_lines_removed: 10,
  };

  it("lays the hook's durations and lines over the fold", () => {
    expect(metricsOver(ok(fold), hook(cost))).toEqual(
      ok({
        ...fold,
        responseTime: 5,
        sessionDuration: 120,
        linesAdded: 25,
        linesRemoved: 10,
      }),
    );
  });

  it("is absent when the hook has no cost block, whatever the fold says", () => {
    expect(metricsOver(ok(fold), hook())).toBe(ABSENT);
    expect(metricsOver(failed("unreadable", "read"), hook())).toBe(ABSENT);
  });

  it("carries a fold not answered or failed as it stands", () => {
    expect(metricsOver(pendingOf("unread"), hook(cost))).toEqual(
      pendingOf("unread"),
    );
    const failure = failed("unreadable", "read");
    expect(metricsOver(failure, hook(cost))).toBe(failure);
  });
});
