// Asking which variables locate a repository: launched once as a daemon
// starts, before its lease, and once per plugin clone. Never on a path the
// daemon serves, since the launch is synchronous.
import type { OneShotLauncher } from "./launch.js";
import { failureText, type LaunchResult } from "./launcher.js";
import { isMissingCommand } from "../segments/git.js";
import type { GitEnvAsk } from "../segments/git-env.js";

// The ask is bounded as the git provider's local reads are: it runs where
// nothing else bounds a process's start.
const ASK_TIMEOUT_MS = 2_000;

// [LAW:single-enforcer] The one reading of a launch of
// `git rev-parse --local-env-vars`, which reads no repository, so a poisoned
// `GIT_DIR` cannot break it.
export function gitEnvAskOf(run: LaunchResult): GitEnvAsk {
  if (run.ok)
    return {
      kind: "asked",
      names: run.stdout.split("\n").filter((name) => name !== ""),
    };
  if (isMissingCommand(run)) return { kind: "asked", names: [] };
  return { kind: "failed", reason: failureText(run) };
}

// [LAW:one-source-of-truth] The one ask, for every process that drops them.
export const askGitEnv = (launcher: OneShotLauncher): GitEnvAsk =>
  gitEnvAskOf(
    launcher.launchSync({
      bin: "git",
      args: ["rev-parse", "--local-env-vars"],
      timeoutMs: ASK_TIMEOUT_MS,
      category: "git.env",
    }),
  );
