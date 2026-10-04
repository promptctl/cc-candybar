// [LAW:one-source-of-truth] The one POSIX shell quoter: every command
// cc-candybar writes for a shell to run (the statusline command, the resume
// command) quotes its words here. A word the shell reads back unchanged needs
// no quotes; anything else is single-quoted, each embedded `'` closed,
// escaped and reopened. A leading `=` is quoted because zsh's EQUALS option
// expands `=cmd` to that command's path.
const SHELL_SAFE = /^[A-Za-z0-9_./,:@%+-][A-Za-z0-9_./,:@%+=-]*$/;

export function singleQuoted(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function shellWord(s: string): string {
  return SHELL_SAFE.test(s) ? s : singleQuoted(s);
}
