import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  findAgentTranscripts,
  userEntryOf,
  type UserEntry,
} from "../src/utils/claude";

describe("findAgentTranscripts", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "powerline-agent-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeSubagentsDir(sessionId: string): string {
    const subagentsDir = join(tempDir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    return subagentsDir;
  }

  function writeAgentFile(subagentsDir: string, name: string, sessionId: string): string {
    const filePath = join(subagentsDir, name);
    writeFileSync(filePath, JSON.stringify({ sessionId }) + "\n");
    return filePath;
  }

  it("finds agent transcripts in <session-uuid>/subagents/", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    const agentFile = writeAgentFile(subagentsDir, "agent-a1b2c3.jsonl", sessionId);

    const result = await findAgentTranscripts(sessionId, tempDir);

    expect(result).toHaveLength(1);
    expect(result[0]!.replace(/\\/g, "/")).toBe(agentFile.replace(/\\/g, "/"));
  });

  it("returns [] when session has no subagents directory", async () => {
    const sessionId = "abc123";
    mkdirSync(join(tempDir, sessionId)); // session dir exists, but no subagents/ inside

    const result = await findAgentTranscripts(sessionId, tempDir);

    expect(result).toEqual([]);
  });

  it("returns [] when session directory does not exist at all", async () => {
    const result = await findAgentTranscripts("no-such-session", tempDir);

    expect(result).toEqual([]);
  });

  it("returns multiple files when session has multiple agent transcripts", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    writeAgentFile(subagentsDir, "agent-aaa.jsonl", sessionId);
    writeAgentFile(subagentsDir, "agent-bbb.jsonl", sessionId);

    const result = await findAgentTranscripts(sessionId, tempDir);

    expect(result).toHaveLength(2);
  });

  it("skips files whose first-line sessionId does not match (defensive guard)", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    writeAgentFile(subagentsDir, "agent-x1y2z3.jsonl", "other-session");

    const result = await findAgentTranscripts(sessionId, tempDir);

    expect(result).toEqual([]);
  });

  it("skips non-agent- files and non-.jsonl files in the subagents dir", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    writeAgentFile(subagentsDir, "agent-valid.jsonl", sessionId);
    writeFileSync(join(subagentsDir, "agent-ignored.txt"), JSON.stringify({ sessionId }) + "\n");
    writeFileSync(join(subagentsDir, "other.jsonl"), JSON.stringify({ sessionId }) + "\n");

    const result = await findAgentTranscripts(sessionId, tempDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("agent-valid.jsonl");
  });
});

// brandon-effects-2gka.2rm: who wrote a "user" entry, from the marks Claude Code
// writes. Every row is a shape seen in real 2.1.280–2.1.289 transcripts.
describe("userEntryOf", () => {
  const text = (t: string) => ({
    role: "user",
    content: [{ type: "text", text: t }],
  });
  test.each<[string, Record<string, unknown>, UserEntry | undefined]>([
    [
      "a typed prompt",
      {
        type: "user",
        origin: { kind: "human" },
        promptSource: "typed",
        message: { role: "user", content: "go" },
      },
      "prompt",
    ],
    [
      "a slash command (no origin)",
      {
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/next</command-name>",
        },
      },
      "prompt",
    ],
    [
      "a user line known only by its role",
      { message: { role: "user", content: "go" } },
      "prompt",
    ],
    [
      "a tool result",
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "a" }],
        },
      },
      "tool-result",
    ],
    [
      "a skill's expanded body (isMeta)",
      {
        type: "user",
        isMeta: true,
        sourceToolUseID: "a",
        message: text("Base directory for this skill: …"),
      },
      "claude-code",
    ],
    [
      "a nudge to continue (isMeta, auto-continuation)",
      {
        type: "user",
        isMeta: true,
        origin: { kind: "auto-continuation" },
        message: text("Please continue"),
      },
      "claude-code",
    ],
    [
      "a compaction summary",
      {
        type: "user",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "This session is being continued…" },
      },
      "claude-code",
    ],
    [
      "a task notification",
      {
        type: "user",
        origin: { kind: "task-notification", producer: "session-task" },
        promptSource: "system",
        message: { role: "user", content: "<task-notification>…" },
      },
      "claude-code",
    ],
    [
      "a local command's output (marked only by its tag)",
      { type: "user", message: { role: "user", content: "<local-command-stdout>Set model to Opus</local-command-stdout>" } },
      "claude-code",
    ],
    [
      "an interrupt marker",
      { type: "user", interruptedMessageId: "m", message: text("[Request interrupted by user]") },
      "claude-code",
    ],
    [
      "an interrupt marker with no interruptedMessageId",
      { type: "user", message: text("[Request interrupted by user for tool use]") },
      "claude-code",
    ],
    [
      "an assistant entry",
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
      undefined,
    ],
  ])("%s", (_, parsed, expected) => {
    expect(userEntryOf(parsed)).toBe(expected);
  });
});
