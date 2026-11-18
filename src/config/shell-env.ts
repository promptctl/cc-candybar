// The variables a `shell` source's command runs in (spec ADR-8,
// docs/design/per-directory-sources.md). The host spawns a run with exactly
// these, read from its session's environment, so the names are the whole of
// what a run's identity says its output depends on.

// [LAW:one-source-of-truth] The base set every shell source runs in, beneath
// the names it declares: what a command needs to find programs, a home, a
// temporary directory and its locale. Chosen so the bundled default and the
// documented examples name nothing more.
export const SHELL_BASE_ENV: readonly string[] = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
];

// [LAW:one-source-of-truth] The one canonical form of a declaration's names:
// the base set and the declared names merged into a sorted set, so naming a
// base variable again, or in another order, is the same declaration.
export function shellEnvOf(declared: readonly string[] = []): string[] {
  return [...new Set([...SHELL_BASE_ENV, ...declared])].sort();
}
