// The Status hook payload, shared by the tests that drive a bar and the
// benchmark. [LAW:one-source-of-truth] One fixture for what a tick carries, so
// a field the bar starts to read is added once.

import type { ClaudeHookData } from "../../src/utils/claude.js";

export const BAR_SESSION_ID = "bar0a1b2-c3d4-4e5f-8a7b-8c9d0e1f2a3b";

// The Status hook Claude Code sends, with every field the bundled bar reads
// set, so each of its segments draws: context, cost, both rate-limit windows.
export function hookData(cwd: string, transcriptPath: string): ClaudeHookData {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    hook_event_name: "Status",
    session_id: BAR_SESSION_ID,
    transcript_path: transcriptPath,
    cwd,
    version: "2.1.0",
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
    cost: {
      total_cost_usd: 0.39,
      total_duration_ms: 930_000,
      total_api_duration_ms: 410_000,
      total_lines_added: 512,
      total_lines_removed: 88,
    },
    context_window: {
      total_input_tokens: 48_000,
      total_output_tokens: 487,
      context_window_size: 200_000,
      used_percentage: 24,
      remaining_percentage: 76,
      current_usage: {
        input_tokens: 2_000,
        output_tokens: 487,
        cache_creation_input_tokens: 6_000,
        cache_read_input_tokens: 40_000,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 63, resets_at: nowSec + 2 * 3600 },
      seven_day: { used_percentage: 21, resets_at: nowSec + 5 * 86400 },
    },
  };
}
