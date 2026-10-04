import { resumeCommand } from "../src/claude-resume";

const at = (project_dir: string, added_dirs: string[] = []) => ({
  project_dir,
  added_dirs,
});

describe("resumeCommand", () => {
  test("cds to the launch directory and resumes the session", () => {
    expect(resumeCommand(at("/Users/a/code/x"), "0b1c-2d", undefined)).toBe(
      "cd /Users/a/code/x && claude --resume 0b1c-2d",
    );
  });

  test("carries the session's configuration directory", () => {
    expect(resumeCommand(at("/p"), "s", "/Users/a/.claude.zai")).toBe(
      "cd /p && CLAUDE_CONFIG_DIR=/Users/a/.claude.zai claude --resume s",
    );
  });

  test("passes each added directory again", () => {
    expect(resumeCommand(at("/p", ["/lib", "/my docs"]), "s", undefined)).toBe(
      "cd /p && claude --resume s --add-dir /lib --add-dir '/my docs'",
    );
  });

  test("single-quotes a word the shell would split or expand", () => {
    expect(resumeCommand(at("/tmp/it's a dir"), "s", "/c $HOME")).toBe(
      `cd '/tmp/it'\\''s a dir' && CLAUDE_CONFIG_DIR='/c $HOME' claude --resume s`,
    );
  });

  test("quotes a leading = that zsh would expand", () => {
    expect(resumeCommand(at("=p"), "s", undefined)).toBe(
      "cd '=p' && claude --resume s",
    );
  });
});
