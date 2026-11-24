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

// The inverse of `shellWord` for a command's first word: what a command this
// quoter wrote starts with, back as the word it quoted. null for any other
// quoting (double quotes, backslashes, expansions), whose word only a shell
// can name.
const FIRST_WORD = /^(?:'((?:[^']|'\\'')*)'|(\S+))(?:\s|$)/;
export function firstShellWord(command: string): string | null {
  const m = FIRST_WORD.exec(command.trimStart());
  const [, quoted, bare] = m ?? [];
  if (quoted !== undefined) return quoted.replaceAll(`'\\''`, "'");
  return bare !== undefined && SHELL_SAFE.test(bare) ? bare : null;
}
