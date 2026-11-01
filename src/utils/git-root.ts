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
import { ABSENT, failed, ok, type Outcome } from "./outcome";

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

// [LAW:types-are-the-program] A read outside the directory being asked about:
// ENOENT is `absent`, anything else `failed` with the error, never a throw.
function probe<T>(read: () => T): Outcome<T> {
  try {
    return ok(read());
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? ABSENT
      : failed((e as Error).message);
  }
}

const realDir = (p: string): Outcome<string> =>
  probe(() => fs.realpathSync.native(p));

// [LAW:no-silent-failure] Why a probe of `what` gave no value: the error a
// failed read carries (it names its path), or that nothing is there.
const why = (
  what: string,
  o: Exclude<Outcome<unknown>, { kind: "ok" }>,
): string => (o.kind === "absent" ? `${what} is not there` : o.reason);

// [LAW:one-source-of-truth] The git directory a checkout root's `.git` file
// names (`gitdir: <path>`, relative to the root): a linked worktree's
// metadata dir, a submodule's, or a `--separate-git-dir` checkout's.
export function gitDirNamed(root: string): Outcome<string> {
  const text = probe(() => fs.readFileSync(path.join(root, ".git"), "utf-8"));
  if (text.kind !== "ok") return text;
  const named = text.value.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  return named === undefined
    ? failed(`${path.join(root, ".git")} names no gitdir`)
    : ok(path.resolve(root, named));
}

// [LAW:one-source-of-truth] The common git directory a linked worktree's git
// dir shares with its repository, from its `commondir` file (a path relative
// to the git dir). `absent` is a git dir that is its own common dir.
export function commonDirOf(gitDir: string): Outcome<string> {
  const text = probe(() =>
    fs.readFileSync(path.join(gitDir, "commondir"), "utf-8"),
  );
  if (text.kind !== "ok") return text;
  const common = text.value.trim();
  return common === ""
    ? failed(`${path.join(gitDir, "commondir")} is empty`)
    : ok(path.resolve(gitDir, common));
}

// Whether a directory sits in a linked worktree, and if so its counterpart in
// the repository's main worktree, spelled as `git worktree list` spells the
// main worktree: the common dir with a trailing `.git` stripped (a bare
// repository's common dir is its own spelling).
export type WorktreeLink =
  | { readonly kind: "linked"; readonly main: string }
  | { readonly kind: "unlinked" }
  | { readonly kind: "unproven"; readonly reason: string };

const UNLINKED: WorktreeLink = { kind: "unlinked" };
const unproven = (reason: string): WorktreeLink => ({
  kind: "unproven",
  reason,
});

// [LAW:parse-dont-validate] A directory's `.git` file is the directory's own
// claim, and a directory nobody vouched for can write any claim. So the link
// is proven from the repository's side, which the directory cannot write: the
// named git dir is registered in `<common>/worktrees/`, and git's back-pointer
// there (`gitdir`) names this root's own `.git` — not a symlink to another
// checkout's. `dir` is a present directory's real path (`realpathSync.native`,
// the on-disk case git's back-pointer may not share). Total: every read
// outside `dir` is a probe, so a moved or pruned worktree is `unproven`.
export function worktreeLink(dir: string): WorktreeLink {
  const root = gitRootOf(dir);
  if (root === undefined) return UNLINKED;
  const dotGit = path.join(root, ".git");
  // A `.git` that is, or links to, a git directory claims no worktree: a
  // main checkout, or one whose `.git` a tool keeps elsewhere (Android's
  // `repo`). Only a regular file claims one, so a symlink to another
  // checkout's `.git` file borrows nothing.
  const followed = probe(() => fs.statSync(dotGit));
  if (followed.kind === "ok" && followed.value.isDirectory()) return UNLINKED;
  const entry = probe(() => fs.lstatSync(dotGit));
  if (entry.kind !== "ok") return unproven(why(dotGit, entry));
  if (!entry.value.isFile()) return unproven(`${dotGit} is not a file`);
  const named = gitDirNamed(root);
  if (named.kind !== "ok") return unproven(why(dotGit, named));
  const gitDir = realDir(named.value);
  if (gitDir.kind !== "ok") return unproven(why(named.value, gitDir));
  const common = commonDirOf(gitDir.value);
  // A git dir with no `commondir` is its own repository's: a submodule or a
  // `--separate-git-dir` checkout, which no linked worktree's answer reaches.
  if (common.kind === "absent") return UNLINKED;
  if (common.kind === "failed") return unproven(common.reason);
  const realCommon = realDir(common.value);
  if (realCommon.kind !== "ok") return unproven(why(common.value, realCommon));
  if (path.dirname(gitDir.value) !== path.join(realCommon.value, "worktrees")) {
    return unproven(`${gitDir.value} is not a worktree of ${realCommon.value}`);
  }
  const backFile = path.join(gitDir.value, "gitdir");
  const back = probe(() => fs.readFileSync(backFile, "utf-8"));
  if (back.kind !== "ok") return unproven(why(backFile, back));
  const pointer = path.resolve(gitDir.value, back.value.trim());
  const pointerDir = realDir(path.dirname(pointer));
  if (
    path.basename(pointer) !== ".git" ||
    pointerDir.kind !== "ok" ||
    pointerDir.value !== root
  ) {
    return unproven(
      `${gitDir.value} is the worktree at ${pointer}, not ${root}`,
    );
  }
  const main =
    path.basename(realCommon.value) === ".git"
      ? path.dirname(realCommon.value)
      : realCommon.value;
  return { kind: "linked", main: path.join(main, path.relative(root, dir)) };
}

// Where a directory sits in its repository, for display. `main` is the main
// checkout's root ("" in no repository), `worktree` the linked worktree's name
// ("" otherwise), `subpath` the directory below the checkout root ("/src", or
// ""). [LAW:no-silent-failure] exception: an unproven link reads as a checkout
// of its own, since its root is real and the git cell reports the broken repo.
export interface CheckoutLocation {
  readonly main: string;
  readonly worktree: string;
  readonly subpath: string;
  readonly noRepo: boolean;
}

export function checkoutLocation(dir: string): CheckoutLocation {
  const real = realDir(dir);
  const at = real.kind === "ok" ? real.value : path.resolve(dir);
  const root = gitRootOf(at);
  if (root === undefined)
    return { main: "", worktree: "", subpath: "", noRepo: true };
  const sub = path.relative(root, at);
  const subpath = sub === "" ? "" : `/${sub.split(path.sep).join("/")}`;
  const link = worktreeLink(at);
  return link.kind === "linked"
    ? {
        main: path.resolve(link.main, path.relative(at, root)),
        worktree: path.basename(root),
        subpath,
        noRepo: false,
      }
    : { main: root, worktree: "", subpath, noRepo: false };
}
