import { CLAUDE_CONFIG_DIR_ENV } from "./claude-settings.js";
import { shellWord } from "./shell-word.js";
import type { ClaudeHookData } from "./utils/claude.js";

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
  workspace: Pick<ClaudeHookData["workspace"], "project_dir" | "added_dirs">,
  sessionId: string,
  configDir: string | undefined,
): string {
  const env =
    configDir === undefined
      ? ""
      : `${CLAUDE_CONFIG_DIR_ENV}=${shellWord(configDir)} `;
  const addDirs = workspace.added_dirs
    .map((dir) => ` --add-dir ${shellWord(dir)}`)
    .join("");
  return `cd ${shellWord(workspace.project_dir)} && ${env}claude --resume ${shellWord(sessionId)}${addDirs}`;
}
