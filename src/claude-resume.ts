import { CLAUDE_CONFIG_DIR_ENV } from "./claude-settings.js";

// A word the shell reads back unchanged needs no quotes; anything else is
// POSIX single-quoted, each embedded `'` closed, escaped and reopened.
const SHELL_SAFE = /^[A-Za-z0-9_./,:@%+=-]+$/;

function shellWord(s: string): string {
  return SHELL_SAFE.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

// [LAW:one-source-of-truth] The shell command that resumes a session, built
// from the three facts Claude Code's `--resume` depends on: it looks the
// session up among the transcripts of the directory it was launched in (the
// hook's project_dir) under the configuration directory it runs with — so a
// session started under CLAUDE_CONFIG_DIR is found only under the same one.
// `configDir` is the client's `claudeConfigDir` hint: absent means the
// default directory, and the command sets nothing.
export function resumeCommand(
  projectDir: string,
  sessionId: string,
  configDir: string | undefined,
): string {
  const env =
    configDir === undefined
      ? ""
      : `${CLAUDE_CONFIG_DIR_ENV}=${shellWord(configDir)} `;
  return `cd ${shellWord(projectDir)} && ${env}claude --resume ${shellWord(sessionId)}`;
}
