// [LAW:one-source-of-truth] Which directory a path's git checkout is rooted
// at: the nearest ancestor, the path itself included, holding a `.git` (a
// directory in a main checkout, a file in a linked worktree — so a worktree
// is its own root). One spelling, read by the git segment's repo root
// (`GitService.findGitRoot`) and by a plugin's `data: { checkout }` path.
//
// [LAW:effects-at-boundaries] Pure fs, no `git` spawn: see `findGitRoot` in
// src/segments/git.ts for where this differs from `git rev-parse`.

import fs from "node:fs";
import path from "node:path";

export function holdsGit(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

// Undefined when no ancestor holds one: the path is in no checkout.
export function gitRootOf(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (holdsGit(dir)) return dir;
    const parent = path.dirname(dir);
    // `path.dirname` is its own fixed point at the filesystem root, which is
    // the ascent's termination and the only one it needs.
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// The checkout a working directory is in: its git root, or — a directory in
// no checkout — the directory itself, with which of the two it was kept, so a
// load can say why a data path landed where it did.
export interface Checkout {
  readonly root: string;
  readonly git: boolean;
}

export function checkoutOf(cwd: string): Checkout {
  const root = gitRootOf(cwd);
  return root === undefined
    ? { root: path.resolve(cwd), git: false }
    : { root, git: true };
}
