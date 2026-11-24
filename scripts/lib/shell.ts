import os from "node:os";

// What a hand-run tool takes from the developer's shell for the daemon it
// starts and the sessions it reports: where programs live, the home, and the
// temporary directory the tool itself writes under. Nothing else of the shell
// reaches them, so a variable the developer exported (a memory limit, a tmux
// pane, a socket) cannot make an isolated daemon behave as theirs does.
export interface ShellEnvironment {
  readonly PATH: string;
  readonly HOME: string;
  readonly TMPDIR: string;
}

// [LAW:parse-dont-validate] The one place a tool's root reads its shell: a
// variable the daemon needs and the shell lacks stops the run, naming it.
export function shellEnvironment(env: NodeJS.ProcessEnv): ShellEnvironment {
  return { PATH: required(env, "PATH"), HOME: required(env, "HOME"), TMPDIR: os.tmpdir() };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`the shell has no ${name}, which the daemon and its sessions need`);
  return value;
}
