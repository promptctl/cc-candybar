import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  findAgentTranscripts,
  userEntryOf,
  longLineLog,
  type UserEntry,
} from "../src/utils/claude";
import { FOLD_WINDOW_BYTES } from "../src/utils/transcript-fs";

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

  // The listing, which these cases expect to succeed.
  async function listed(sessionId: string, dir: string) {
    const found = await findAgentTranscripts(sessionId, dir);
    if (found.kind !== "ok") throw new Error(`listing failed: ${found.reason}`);
    return found.value;
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

    const { paths: result } = await listed(sessionId, tempDir);

    expect(result).toHaveLength(1);
    expect(result[0]!.replace(/\\/g, "/")).toBe(agentFile.replace(/\\/g, "/"));
  });

  it("returns [] when session has no subagents directory", async () => {
    const sessionId = "abc123";
    mkdirSync(join(tempDir, sessionId)); // session dir exists, but no subagents/ inside

    const { paths: result } = await listed(sessionId, tempDir);

    expect(result).toEqual([]);
  });

  it("returns [] when session directory does not exist at all", async () => {
    const { paths: result } = await listed("no-such-session", tempDir);

    expect(result).toEqual([]);
  });

  it("returns multiple files when session has multiple agent transcripts", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    writeAgentFile(subagentsDir, "agent-aaa.jsonl", sessionId);
    writeAgentFile(subagentsDir, "agent-bbb.jsonl", sessionId);

    const { paths: result } = await listed(sessionId, tempDir);

    expect(result).toHaveLength(2);
  });

  it("skips files whose first-line sessionId does not match (defensive guard)", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    writeAgentFile(subagentsDir, "agent-x1y2z3.jsonl", "other-session");

    const { paths: result } = await listed(sessionId, tempDir);

    expect(result).toEqual([]);
  });

  it("skips non-agent- files and non-.jsonl files in the subagents dir", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    writeAgentFile(subagentsDir, "agent-valid.jsonl", sessionId);
    writeFileSync(join(subagentsDir, "agent-ignored.txt"), JSON.stringify({ sessionId }) + "\n");
    writeFileSync(join(subagentsDir, "other.jsonl"), JSON.stringify({ sessionId }) + "\n");

    const { paths: result } = await listed(sessionId, tempDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("agent-valid.jsonl");
  });

  // brandon-unfiled-3248.bfnj: the first line is read through the windowed
  // reader, which reads a line longer than the window whole and says so.
  it("reads a first line longer than the fold window whole, and reports the long line", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    const pad = "x".repeat(Math.floor(FOLD_WINDOW_BYTES * 2.5));
    const agentFile = join(subagentsDir, "agent-long.jsonl");
    writeFileSync(agentFile, JSON.stringify({ sessionId, pad }) + "\n");

    const { paths, longLines } = await listed(sessionId, tempDir);

    expect(paths).toEqual([agentFile]);
    const bytes = Buffer.byteLength(JSON.stringify({ sessionId, pad }) + "\n");
    expect(longLines).toEqual([{ path: agentFile, offset: 0, bytes }]);
    expect(longLineLog(longLines)).toEqual([
      `transcript long line path=${JSON.stringify(agentFile)} offset=0 bytes=${bytes}`,
    ]);
  });

  it("a sidechain whose first line cannot say whose it is is left out, and says why", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    const blank = join(subagentsDir, "agent-blank.jsonl");
    writeFileSync(blank, "\n" + JSON.stringify({ sessionId }) + "\n");
    const nameless = join(subagentsDir, "agent-nameless.jsonl");
    writeFileSync(nameless, JSON.stringify({ type: "summary" }) + "\n");
    const array = join(subagentsDir, "agent-array.jsonl");
    writeFileSync(array, "[]\n");
    const broken = join(subagentsDir, "agent-broken.jsonl");
    writeFileSync(broken, '{"sessionId":\n');
    // No whole line yet: read again by the next fold, and no loss.
    writeFileSync(join(subagentsDir, "agent-writing.jsonl"), '{"sessionId":"abc');

    const { paths, unowned } = await listed(sessionId, tempDir);

    expect(paths).toEqual([]);
    const reasons = Object.fromEntries(
      unowned.map((loss) => [loss.path, loss.kind === "unowned-sidechain" && loss.reason]),
    );
    expect(reasons).toEqual({
      [blank]: "is blank",
      [nameless]: "names no session",
      [array]: "is not a JSON object",
      [broken]: expect.stringMatching(/^is not JSON \(.+\)$/),
    });
  });

  it("a sidechains directory that cannot be listed fails the listing, never no sidechains", async () => {
    const sessionId = "abc123";
    mkdirSync(join(tempDir, sessionId));
    writeFileSync(join(tempDir, sessionId, "subagents"), "");

    const found = await findAgentTranscripts(sessionId, tempDir);

    expect(found).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/ENOTDIR/),
      failedAt: "read",
    });
  });

  it("a new sidechain whose first line cannot be read fails the listing", async () => {
    const sessionId = "abc123";
    const subagentsDir = makeSubagentsDir(sessionId);
    mkdirSync(join(subagentsDir, "agent-dir.jsonl"));

    const found = await findAgentTranscripts(sessionId, tempDir);

    expect(found).toEqual({
      kind: "failed",
      reason: expect.stringMatching(/not a regular file/),
      failedAt: "read",
    });
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
