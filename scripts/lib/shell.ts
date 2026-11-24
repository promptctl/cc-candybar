// [LAW:parse-dont-validate] What a hand-run tool takes from the developer's
// shell: where programs live, the home, and the temporary directory when the
// shell names one, and nothing else, so a variable the developer exported (a
// memory limit, a tmux pane, a socket) cannot make an isolated daemon behave as
// theirs does. A shell that names no temporary directory leaves the daemon the
// platform's, as it leaves every program it starts.
export type ShellEnvironment = {
  readonly PATH: string;
  readonly HOME: string;
  readonly TMPDIR?: string;
};

// The shell `env` is, or the run stops naming what it lacks.
export function shellEnvironment(env: NodeJS.ProcessEnv): ShellEnvironment {
  const { TMPDIR } = env;
  return {
    PATH: required(env, "PATH"),
    HOME: required(env, "HOME"),
    ...(TMPDIR === undefined ? {} : { TMPDIR }),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`the shell has no ${name}, which the daemon and its sessions need`);
  return value;
}
