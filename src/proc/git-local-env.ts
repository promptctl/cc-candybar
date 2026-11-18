import {
  failureText,
  type AsyncLaunchOpts,
  type Launcher,
  type LaunchResult,
} from "./launcher";

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

// What asking git for the names answered: the overlay that unsets them, or
// the result the read stands in for, since the read never starts.
type Asked =
  | { readonly kind: "unset"; readonly overlay: Record<string, null> }
  | { readonly kind: "failed"; readonly result: LaunchResult };

// [LAW:no-silent-failure] An ask that failed is the read's result: the read
// never starts. Every reason stands as it is but an exit, which a read can
// spell as "there is none"; that one is a read that never started
// (`spawn-error`), naming the ask, so no read takes it for an answer.
function askedOf(answer: LaunchResult): Asked {
  if (answer.ok)
    return { kind: "unset", overlay: localEnvUnset(answer.stdout) };
  if (answer.reason !== "non-zero") return { kind: "failed", result: answer };
  return {
    kind: "failed",
    result: {
      ok: false,
      reason: "spawn-error",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      error: `git rev-parse --local-env-vars: ${failureText(answer)}`,
    },
  };
}

// [LAW:single-enforcer] The one way the git service and the doctor's forge
// probe launch a read for a directory: with none of git's repository variables, since the env it
// inherits is whichever shell started this process, never the session's. The
// unset is laid over the caller's overlay, so no call site can put one back.
// [LAW:one-source-of-truth] git names them, asked once for the asker's life,
// in the first read's own directory; concurrent first launches share the ask.
// An ask that fails is not kept: the next launch asks again.
export function repoLaunch(launcher: Pick<Launcher, "launch">): RepoLaunch {
  let asked: Promise<Asked> | null = null;
  return async (opts) => {
    const ask = (asked ??= launcher
      .launch({
        bin: "git",
        args: ["rev-parse", "--local-env-vars"],
        cwd: opts.cwd,
        timeoutMs: 2000,
        category: "git",
      })
      .then(askedOf));
    const answer = await ask;
    if (answer.kind === "failed") {
      if (asked === ask) asked = null;
      return answer.result;
    }
    return launcher.launch({
      ...opts,
      envOverlay: { ...opts.envOverlay, ...answer.overlay },
    });
  };
}
