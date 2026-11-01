// A Claude Code transcript, as Claude Code writes it.
//
// [LAW:one-source-of-truth] The load gate and the benchmark both need a
// transcript that the daemon folds as it folds a real one (usage on the
// assistant entry, a tool call and its result, a prompt). One generator, so a
// change to what the fold reads is a change to one fixture, not two that drift.

import path from "node:path";

// One turn as Claude Code writes it: the prompt, the assistant's tool call
// with its usage, and the tool's result.
export function transcriptTurn(
  sessionId: string,
  cwd: string,
  t: number,
  when: Date,
): string {
  const at = when.toISOString();
  const common = {
    sessionId,
    cwd,
    version: "2.1.299",
    gitBranch: "main",
    userType: "external",
  };
  const lines = [
    {
      ...common,
      type: "user",
      uuid: `u-${t}`,
      timestamp: at,
      message: {
        role: "user",
        content: `Step ${t}: run the tests and fix what fails. `.repeat(8),
      },
    },
    {
      ...common,
      type: "assistant",
      uuid: `a-${t}`,
      timestamp: at,
      requestId: `req_${t}`,
      message: {
        model: "claude-opus-5-5",
        id: `msg_${t}`,
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "C".repeat(900) },
          {
            type: "tool_use",
            id: `toolu_${t}`,
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 1200 + t,
          cache_read_input_tokens: 40_000 + 900 * t,
          output_tokens: 300 + t,
          service_tier: "standard",
          cache_creation: {
            ephemeral_1h_input_tokens: 1200 + t,
            ephemeral_5m_input_tokens: 0,
          },
        },
      },
    },
    {
      ...common,
      type: "user",
      uuid: `r-${t}`,
      timestamp: at,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_${t}`,
            content: "ok ".repeat(200),
          },
        ],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l) + "\n").join("");
}

// Where Claude Code keeps a project's transcripts under its config directory:
// one folder per checkout, named by the checkout's path with every character
// outside [A-Za-z0-9] a dash.
export function transcriptPath(
  claudeDir: string,
  checkout: string,
  sessionId: string,
): string {
  return path.join(
    claudeDir,
    "projects",
    checkout.replace(/[^A-Za-z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
}
