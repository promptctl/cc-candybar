// [LAW:one-source-of-truth] The renamed built-in segments: old name → current
// name. A user config merges on top of the bundled default, so an old name
// resolves to nothing, wherever it appears: a `root` entry, a `segments` delta,
// a tree-op `anchor`, a `segments.<name>.palette` target. Every one of those
// messages ends with `renamedHint`, so the migration pointer
// [LAW:no-silent-failure] reaches each reference path, not only the first one
// someone thought of. A future rename is one row here.
export const RENAMED_SEGMENTS: Readonly<Record<string, string>> = {
  gitTaculous: "gitaculous",
  // The one-line summary became the collapsed form of `gitaculous`
  // (brandon-git-segment-ixf.tl0).
  git: "gitaculous",
};

export function renamedHint(name: string): string {
  const renamed = RENAMED_SEGMENTS[name];
  return renamed === undefined
    ? ""
    : ` (the built-in segment "${name}" was renamed to "${renamed}" — update this reference)`;
}
