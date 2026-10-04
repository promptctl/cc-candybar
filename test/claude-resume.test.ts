import { resumeCommand } from "../src/claude-resume";

describe("resumeCommand", () => {
  test("cds to the launch directory and resumes the session", () => {
    expect(resumeCommand("/Users/a/code/x", "0b1c-2d", undefined)).toBe(
      "cd /Users/a/code/x && claude --resume 0b1c-2d",
    );
  });

  test("carries the session's configuration directory", () => {
    expect(resumeCommand("/p", "s", "/Users/a/.claude.zai")).toBe(
      "cd /p && CLAUDE_CONFIG_DIR=/Users/a/.claude.zai claude --resume s",
    );
  });

  test("single-quotes a word the shell would split or expand", () => {
    expect(resumeCommand("/tmp/it's a dir", "s", "/c $HOME")).toBe(
      `cd '/tmp/it'\\''s a dir' && CLAUDE_CONFIG_DIR='/c $HOME' claude --resume s`,
    );
  });
});
