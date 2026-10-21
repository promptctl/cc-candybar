import { shellWord } from "./shell-word.js";

// A shell line that starts Claude Code: the directory it starts in (none: the
// shell's own), the variables set for it alone, the program — `claude`, or a
// path — and its arguments.
export interface ClaudeCommand {
  readonly dir: string | undefined;
  readonly env: ReadonlyArray<readonly [name: string, value: string]>;
  readonly program: string;
  readonly args: readonly string[];
}

// [LAW:one-source-of-truth] The one spelling of a line that starts Claude
// Code — the resume command the bar copies, the line `--help` prints for lane
// B, and the line lane B's restart types (src/daemon/lane-setup.ts):
// `cd <dir> && NAME=value … <program> <args>`. Each variable is set on the
// command, never exported, so the shell keeps none of them for the next line.
export function claudeCommandLine(command: ClaudeCommand): string {
  const cd =
    command.dir === undefined ? "" : `cd ${shellWord(command.dir)} && `;
  const env = command.env
    .map(([name, value]) => `${name}=${shellWord(value)} `)
    .join("");
  return `${cd}${env}${[command.program, ...command.args].map(shellWord).join(" ")}`;
}
