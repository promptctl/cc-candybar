// The variables git honours over its working directory to locate a repository
// (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ...), named by git itself.
// A process that runs git for a directory other than the one its environment
// was made for drops them, or every read answers for that environment's repo.
// The ask itself is src/proc/git-env-ask.ts.

// [LAW:types-are-the-program] What asking git for those names came to. With
// no git installed there is no git read to mislead, so that is an answer with
// no names, not a failure.
export type GitEnvAsk =
  | { readonly kind: "asked"; readonly names: readonly string[] }
  | { readonly kind: "failed"; readonly reason: string };

// An environment without the named variables, and otherwise as given.
export function withoutNames(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string | undefined> {
  const dropped = new Set(names);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !dropped.has(name)),
  );
}

// [LAW:no-silent-failure] What a daemon whose ask failed says on every bar.
export const gitEnvFailedMessage = (reason: string): string =>
  `git could not say which variables locate a repository (${reason}), so git reads use the environment of the shell that started this daemon, and may show another repository's branch; the daemon asks again when it next starts`;
