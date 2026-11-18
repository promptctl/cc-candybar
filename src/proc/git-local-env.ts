import type { AsyncLaunchOpts, Launcher, LaunchResult } from "./launcher";

// The overlay that unsets each variable `git rev-parse --local-env-vars`
// names: those that locate a repository (`GIT_DIR`, `GIT_WORK_TREE`, the
// object and config lookups) over the working directory.
export const localEnvUnset = (stdout: string): Record<string, null> =>
  Object.fromEntries(
    stdout
      .split("\n")
      .filter((name) => name !== "")
      .map((name) => [name, null]),
  );

// A launch for a directory's repository.
export type RepoLaunch = (opts: AsyncLaunchOpts) => Promise<LaunchResult>;

// [LAW:single-enforcer] The one way a git or forge read is launched for a
// directory: with none of git's repository variables, since the env it
// inherits is whichever shell started this process, never the session's.
// [LAW:one-source-of-truth] git names them, asked once for the asker's life;
// concurrent first launches share the ask. [LAW:no-silent-failure] An ask
// that fails is the launch's result, a git launch that failed, so the read
// fails naming why instead of reading another repository. It is not kept:
// the next launch asks again.
export function repoLaunch(launcher: Pick<Launcher, "launch">): RepoLaunch {
  let asked: Promise<LaunchResult> | null = null;
  return async (opts) => {
    const ask = (asked ??= launcher.launch({
      bin: "git",
      args: ["rev-parse", "--local-env-vars"],
      timeoutMs: 2000,
      category: "git",
    }));
    const answer = await ask;
    if (!answer.ok) {
      if (asked === ask) asked = null;
      return answer;
    }
    return launcher.launch({
      ...opts,
      envOverlay: { ...localEnvUnset(answer.stdout), ...opts.envOverlay },
    });
  };
}
