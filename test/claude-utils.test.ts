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

// brandon-effects-2gka.2rm: what a "user" entry is, from the marks Claude Code
// writes. Every row is a shape seen in real transcripts, 2.1.0–2.1.289.
describe("userEntryOf", () => {
  const user = (content: unknown, fields: Record<string, unknown> = {}) => ({
    type: "user",
    ...fields,
    message: { role: "user", content },
  });
  const text = (t: string) => [{ type: "text", text: t }];
  test.each<[string, Record<string, unknown>, UserEntry | undefined]>([
    ["a typed prompt", user("go", { origin: { kind: "human" }, promptSource: "typed" }), "prompt"],
    ["a prompt from an older Claude Code, which writes no origin", user("go"), "prompt"],
    ["an SDK caller's prompt, which carries no origin", user("go", { promptSource: "sdk" }), "prompt"],
    ["a user line known only by its role", { message: { role: "user", content: "go" } }, "prompt"],
    [
      "a skill command, which leads with <command-message>",
      user("<command-message>lit:next</command-message>\n<command-name>/lit:next</command-name>", { origin: { kind: "human" } }),
      "prompt",
    ],
    [
      "a task notification",
      user("<task-notification>…", { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system" }),
      "turn",
    ],
    [
      "a nudge to continue (isMeta, auto-continuation)",
      user(text("Please continue"), { isMeta: true, origin: { kind: "auto-continuation" } }),
      "turn",
    ],
    ["an interrupt marker", user(text("[Request interrupted by user]"), { interruptedMessageId: "m" }), "interrupt"],
    ["an interrupt marker with no interruptedMessageId", user(text("[Request interrupted by user for tool use]")), "interrupt"],
    ["a tool result", user([{ type: "tool_result", tool_use_id: "a" }]), "tool-result"],
    ["a skill's expanded body (isMeta)", user(text("Base directory for this skill: …"), { isMeta: true, sourceToolUseID: "a" }), "claude-code"],
    ["a command caveat (isMeta)", user("<local-command-caveat>Caveat…</local-command-caveat>", { isMeta: true }), "claude-code"],
    [
      "a compaction summary",
      user("This session is being continued…", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      "claude-code",
    ],
    [
      "a built-in command, which leads with <command-name>",
      user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
      "claude-code",
    ],
    ["a built-in command's output", user("<local-command-stdout>Set model to Opus</local-command-stdout>"), "claude-code"],
    ["a built-in command's error", user("<local-command-stderr>no</local-command-stderr>"), "claude-code"],
    ["a ! shell command", user("<bash-input>ls</bash-input>"), "claude-code"],
    ["a ! shell command's output", user("<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>"), "claude-code"],
    ["an assistant entry", { type: "assistant", message: { role: "assistant", content: text("hi") } }, undefined],
  ])("%s", (_, parsed, expected) => {
    expect(userEntryOf(parsed)).toBe(expected);
  });
});
