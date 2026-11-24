import os from "node:os";

// The environment an isolated daemon runs in and its sessions report their
// PATH from: one known to hold where programs live, the home, and the
// temporary directory the caller writes under.
export type ShellEnvironment = NodeJS.ProcessEnv & {
  readonly PATH: string;
  readonly HOME: string;
  readonly TMPDIR: string;
};

// [LAW:parse-dont-validate] What a hand-run tool takes from the developer's
// shell: those three and nothing else, so a variable the developer exported (a
// memory limit, a tmux pane, a socket) cannot make an isolated daemon behave as
// theirs does. A variable the shell lacks stops the run, naming it.
export function shellEnvironment(env: NodeJS.ProcessEnv): ShellEnvironment {
  return { PATH: required(env, "PATH"), HOME: required(env, "HOME"), TMPDIR: os.tmpdir() };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`the shell has no ${name}, which the daemon and its sessions need`);
  return value;
}
