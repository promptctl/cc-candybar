// What git names as the variables local to one repository
// (`git rev-parse --local-env-vars`): the ones that locate it (`GIT_DIR`,
// `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`) and the settings that
// hold only inside it (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, the object
// and replace-ref variables). git honours them over its working directory and
// drops them itself when it moves into another repository (a submodule), so a
// process whose children must answer for the directory they run in drops
// them, all of them, from the environment it inherited. The daemon does (its
// environment is whichever shell spawned it, src/host.ts daemonWorld), and so
// does a plugin install's clone (src/plugin-install.ts).

import {
  failureText,
  type LaunchResult,
  type OneShotLauncher,
} from "./proc/launch";
import { isMissingCommand } from "./segments/git";

// [LAW:types-are-the-program] The ask's outcome, with no silent arm: either git
// named the variables, or it could not, and why. A git that is not installed
// names none, which is a success: with no git, no git read runs to be misled.
export type GitEnvAsk =
  | { readonly kind: "asked"; readonly names: readonly string[] }
  | { readonly kind: "failed"; readonly reason: string };

// The ask reads no repository, so a poisoned `GIT_DIR` cannot break it, and it
// answers in milliseconds. Bounded like the git provider's local reads
// (src/segments/git.ts): in the daemon it runs before the lease, where nothing
// else bounds the boot, so a git that hangs (a wrapper on PATH) would otherwise
// hold every respawn.
export const GIT_ENV_ASK_TIMEOUT_MS = 2000;

export function gitEnvAskOf(result: LaunchResult): GitEnvAsk {
  if (result.ok)
    return {
      kind: "asked",
      names: result.stdout.split("\n").filter((name) => name !== ""),
    };
  return isMissingCommand(result)
    ? { kind: "asked", names: [] }
    : { kind: "failed", reason: failureText(result) };
}

// [LAW:one-source-of-truth] The one ask: the tool itself names the variables,
// so the list follows the installed git.
export function askGitEnv(launcher: OneShotLauncher): GitEnvAsk {
  return gitEnvAskOf(
    launcher.launchSync({
      bin: "git",
      args: ["rev-parse", "--local-env-vars"],
      timeoutMs: GIT_ENV_ASK_TIMEOUT_MS,
      category: "git.env",
    }),
  );
}

// What a failed ask means for every bar a daemon draws while it lives.
export const gitEnvFault = (reason: string): string =>
  `git could not say which variables locate a repository (${reason}), so git reads use the environment of the shell that started this daemon, and may show another repository's branch; the daemon asks again when it next starts`;
