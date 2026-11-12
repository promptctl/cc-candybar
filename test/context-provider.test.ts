// Contract tests for the session's context: the window size is authoritatively
// Claude Code's `context_window.context_window_size` — never guessed from the
// model name — and the transcript's fold is only the fallback the renderer
// lays the hook over (`contextOver`). These lock that in, including the
// 1M-context variants where a hardcoded 200k would report wildly wrong "left"
// percentages.

import { sessionIdOf } from "../src/daemon/session-id";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextProvider, contextOver } from "../src/segments/context";
import { failed, ok, pendingOf } from "../src/utils/outcome";
import type { ClaudeHookData } from "../src/utils/claude";
import { systemTimekeeper } from "../src/time";

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

describe("the context window's sourcing", () => {

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
    const outcome = contextOver(pendingOf("unread"), hook);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // 168,912 of a 1M window is ~17% used → ~83% left. A 200k limit would have
    // reported 0% left (the bug).
    expect(outcome.value.maxTokens).toBe(1_000_000);
    expect(outcome.value.contextLeftPercentage).toBeGreaterThan(80);
  });

  it("uses native used_percentage and remaining_percentage verbatim, not a local buffer calc", async () => {
    const hook = baseHook({
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        // Deliberately NOT 100 - used: proves we pass Claude's numbers through
        // rather than deriving "left" from a (size - 33k) computation, which
        // would yield a different value.
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
    const outcome = contextOver(pendingOf("unread"), hook);
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
    const outcome = contextOver(pendingOf("unread"), hook);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // 200k / 1M = 20% used → 80% left, with NO 33k buffer skew.
    expect(outcome.value.percentage).toBe(20);
    expect(outcome.value.contextLeftPercentage).toBe(80);
  });

  it("falls back to context_window_size even when current_usage is null", () => {
    // current_usage null ⇒ no native answer ⇒ the transcript's tokens, whose
    // window size must still come from the hook data, not the floor.
    const hook = baseHook({
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        used_percentage: null,
        remaining_percentage: null,
        current_usage: null,
      },
    });
    const outcome = contextOver(ok(168_912), hook);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value.maxTokens).toBe(1_000_000);
  });

  it("answers the native window whatever the transcript's fold says", () => {
    const hook = baseHook({
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1_000_000,
        used_percentage: 10,
        remaining_percentage: 90,
        current_usage: {
          input_tokens: 100_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const native = contextOver(ok(5), hook);
    expect(contextOver(pendingOf("unread"), hook)).toEqual(native);
    expect(contextOver(failed("unreadable", "read"), hook)).toEqual(native);
  });

  it("is the fold's own answer while it has no tokens and the hook no window", () => {
    expect(contextOver(pendingOf("unread"), baseHook())).toEqual(
      pendingOf("unread"),
    );
  });
});

// The transcript fallback is a fold (brandon-unfiled-3248.bfnj): the newest
// main-chain usage entry, kept per session and extended by what is appended.
describe("ContextProvider transcript fallback", () => {
  const entry = (tokens: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      timestamp: "2026-05-31T00:00:00.000Z",
      message: {
        usage: {
          input_tokens: tokens,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
      ...extra,
    }) + "\n";
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-ctx-fb-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the newest main-chain usage entry, skipping sidechains", async () => {
    const t = join(dir, "t.jsonl");
    writeFileSync(t, entry(1000) + entry(2000) + entry(9999, { isSidechain: true }));
    const tokens = await new ContextProvider({ clock: systemTimekeeper }).refresh(sessionIdOf("fb"), t);
    expect(tokens).toEqual(ok(2015));
    // With no window from the hook, the ratio is against the 200k floor.
    expect(contextOver(tokens, baseHook())).toEqual({
      kind: "ok",
      value: {
        totalTokens: 2015,
        maxTokens: 200_000,
        percentage: 1,
        contextLeftPercentage: 99,
      },
    });
  });

  it("is absent for a transcript with no usage-bearing entry", async () => {
    const t = join(dir, "t.jsonl");
    writeFileSync(t, JSON.stringify({ timestamp: "2026-05-31T00:00:00.000Z", type: "user" }) + "\n");
    const outcome = await new ContextProvider({ clock: systemTimekeeper }).refresh(sessionIdOf("fb"), t);
    expect(outcome.kind).toBe("absent");
  });

  it("follows an append through the incremental fold", async () => {
    const t = join(dir, "t.jsonl");
    writeFileSync(t, entry(1000));
    const provider = new ContextProvider({ clock: systemTimekeeper });
    expect(await provider.refresh(sessionIdOf("fb"), t)).toEqual(ok(1015));

    appendFileSync(t, entry(50_000));
    utimesSync(t, Date.now() / 1000 + 5, Date.now() / 1000 + 5);
    expect(await provider.refresh(sessionIdOf("fb"), t)).toEqual(ok(50_015));
    // A draw reads what the last refresh left.
    expect(provider.tokensOf(sessionIdOf("fb"))).toEqual(ok(50_015));
  });

  it("is failed when the transcript cannot be read", async () => {
    const outcome = await new ContextProvider({ clock: systemTimekeeper }).refresh(sessionIdOf("fb"), dir);
    expect(outcome.kind).toBe("failed");
  });
});
