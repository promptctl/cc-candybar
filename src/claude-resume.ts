import { CLAUDE_CONFIG_DIR_ENV } from "./claude-settings.js";
import { claudeCommandLine } from "./claude-command-line.js";

// [LAW:one-source-of-truth] The shell command that resumes a session, built
// from the facts Claude Code's `--resume` depends on: it looks the session up
// among the transcripts of the directory it was launched in (the hook's
// project_dir) under the configuration directory it runs with — so a session
// started under CLAUDE_CONFIG_DIR is found only under the same one — and it
// does not restore the session's `--add-dir` directories, so each one the
// hook reports in added_dirs is passed again. `configDir` is the client's
// `claudeConfigDir` hint: absent means the default directory, and the
// command sets nothing.
export function resumeCommand(
  workspace: {
    readonly project_dir: string;
    readonly added_dirs: readonly string[];
  },
  sessionId: string,
  configDir: string | undefined,
): string {
  return claudeCommandLine({
    dir: workspace.project_dir,
    env: configDir === undefined ? [] : [[CLAUDE_CONFIG_DIR_ENV, configDir]],
    program: "claude",
    args: [
      "--resume",
      sessionId,
      ...workspace.added_dirs.flatMap((dir) => ["--add-dir", dir]),
    ],
  });
}
