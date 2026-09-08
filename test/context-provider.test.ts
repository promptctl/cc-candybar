import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextProvider } from "../src/segments/context";
import type { ClaudeHookData } from "../src/utils/claude";

function baseHook(overrides: Partial<ClaudeHookData> = {}): ClaudeHookData {
  return {
    hook_event_name: "Status",
    session_id: "s",
    transcript_path: "/tmp/none.jsonl",
    cwd: "/tmp",
    model: { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
    ...overrides,
  } as ClaudeHookData;
}

describe("ContextProvider window-size sourcing", () => {
  const provider = new ContextProvider();

  it("uses context_window_size from the hook data (1M model), not a 200k guess", async () => {
    const hook = baseHook({
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        used_percentage: null,
        remaining_percentage: null,
        current_usage: {
          input_tokens: 168_912,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const outcome = await provider.getContextInfo(hook);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.maxTokens).toBe(1_000_000);
    expect(outcome.value.contextLeftPercentage).toBeGreaterThan(80);
  });

  it("uses native used_percentage and remaining_percentage verbatim, not a local buffer calc", async () => {
    const hook = baseHook({
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        used_percentage: 42,
        remaining_percentage: 58,
        current_usage: {
          input_tokens: 100_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const outcome = await provider.getContextInfo(hook);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.percentage).toBe(42);
    expect(outcome.value.contextLeftPercentage).toBe(58);
  });

  it("falls back to a plain token-ratio (no auto-compact buffer) when native percentages are null", async () => {
    const hook = baseHook({
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        used_percentage: null,
        remaining_percentage: null,
        current_usage: {
          input_tokens: 200_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const outcome = await provider.getContextInfo(hook);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.percentage).toBe(20);
    expect(outcome.value.contextLeftPercentage).toBe(80);
  });

  it("falls back to context_window_size even when current_usage is null", async () => {
    // current_usage null ⇒ transcript fallback, which must still source the size from the hook data.
    const dir = mkdtempSync(join(tmpdir(), "cc-ctx-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: "2026-05-31T00:00:00.000Z",
        message: { usage: { input_tokens: 168_912 } },
      }) + "\n",
    );
    const hook = baseHook({
      transcript_path: transcript,
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        used_percentage: null,
        remaining_percentage: null,
        current_usage: null,
      },
    });
    const outcome = await provider.getContextInfo(hook);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.maxTokens).toBe(1_000_000);
    rmSync(dir, { recursive: true, force: true });
  });
});
