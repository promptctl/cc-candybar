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
import { types } from "node:util";
import { ABSENT, failed, ok, type Outcome } from "./outcome";
import { readRegularTextSync } from "./regular-text.js";

// [LAW:single-enforcer] The ascent carries the finding at the winning
// ancestor. [LAW:no-silent-failure] Only absence lets the walk go farther:
// an unchecked near entry could be a different repository from its parent.
function checkoutAt(
  start: string,
  files: CheckoutFiles,
): Outcome<{ readonly root: string; readonly entry: fs.Stats }> {
  let dir = path.resolve(start);
  for (;;) {
    const found = gitEntryAt(dir, files);
    if (found.kind === "ok") return ok({ root: dir, entry: found.value });
    if (found.kind === "failed") return found;
    const parent = path.dirname(dir);
    // `path.dirname` is its own fixed point at the filesystem root, which is
    // the ascent's termination and the only one it needs.
    if (parent === dir) return ABSENT;
    dir = parent;
  }
}

export function gitEntryAt(
  dir: string,
  files = checkoutFiles,
): Outcome<fs.Stats> {
  return files.stat(path.join(dir, ".git"));
}

export function gitRootOf(
  start: string,
  files = checkoutFiles,
): Outcome<string> {
  const found = checkoutAt(start, files);
  return found.kind === "ok" ? ok(found.value.root) : found;
}

// The checkout a working directory is in: its git root, or — a directory in
// no checkout — the directory itself, with which of the two it was kept, so a
// load can say why a data path landed where it did.
export interface Checkout {
  readonly root: string;
  readonly git: boolean;
}

export type CheckoutRead = Exclude<Outcome<Checkout>, { kind: "absent" }>;

export function checkoutOf(cwd: string, files = checkoutFiles): CheckoutRead {
  const root = gitRootOf(cwd, files);
  switch (root.kind) {
    case "ok":
      return ok({ root: root.value, git: true });
    case "absent":
      return ok({ root: path.resolve(cwd), git: false });
    case "failed":
      return root;
  }
}

// [LAW:types-are-the-program] A read outside the directory being asked about:
// ENOENT is `absent`, anything else `failed` with the error, never a throw.
function probe<T>(file: string, read: () => T | undefined): Outcome<T> {
  try {
    const value = read();
    return value === undefined ? ABSENT : ok(value);
  } catch (error) {
    const native = types.isNativeError(error);
    if (native && "code" in error && error.code === "ENOENT") return ABSENT;
    const detail = native ? error.message : String(error);
    const named = native && "path" in error && error.path === file;
    return failed(named ? detail : `${file}: ${detail}`, "read");
  }
}

// [LAW:effects-at-boundaries] The filesystem facts checkout queries read.
// A host can share these observations between queries without sharing their
// resulting display locations or repository admissions.
export const checkoutFiles = {
  stat: (file: string) =>
    probe(file, () => fs.statSync(file, { throwIfNoEntry: false })),
  lstat: (file: string) => probe(file, () => fs.lstatSync(file)),
  realpath: (file: string) => probe(file, () => fs.realpathSync.native(file)),
  text: (file: string) => probe(file, () => readRegularTextSync(file)),
};

export type CheckoutFiles = typeof checkoutFiles;

// [LAW:one-source-of-truth] The git directory a checkout root's `.git` file
// names (`gitdir: <path>`, relative to the root): a linked worktree's
// metadata dir, a submodule's, or a `--separate-git-dir` checkout's.
export function gitDirNamed(
  root: string,
  files = checkoutFiles,
): Outcome<string> {
  const text = files.text(path.join(root, ".git"));
  if (text.kind !== "ok") return text;
  const named = text.value.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  return named === undefined
    ? failed(`${path.join(root, ".git")} names no gitdir`, "parse")
    : ok(path.resolve(root, named));
}

// [LAW:one-source-of-truth] The exclude file every worktree of a checkout
// root's repository shares — what `git rev-parse --git-path info/exclude`
// names: the `info/exclude` of the repository's common git directory.
export function sharedExcludeOf(root: string): Outcome<string> {
  const dotGit = path.join(root, ".git");
  const entry = gitEntryAt(root);
  if (entry.kind !== "ok") return entry;
  if (entry.value.isDirectory())
    return ok(path.join(dotGit, "info", "exclude"));
  const gitDir = gitDirNamed(root);
  if (gitDir.kind !== "ok") return gitDir;
  const common = commonDirOf(gitDir.value);
  if (common.kind === "failed") return common;
  const shared = common.kind === "ok" ? common.value : gitDir.value;
  return ok(path.join(shared, "info", "exclude"));
}

// [LAW:one-source-of-truth] The common git directory a linked worktree's git
// dir shares with its repository, from its `commondir` file (a path relative
// to the git dir). `absent` is a git dir that is its own common dir.
export function commonDirOf(
  gitDir: string,
  files = checkoutFiles,
): Outcome<string> {
  const text = files.text(path.join(gitDir, "commondir"));
  if (text.kind !== "ok") return text;
  const common = text.value.trim();
  return common === ""
    ? failed(`${path.join(gitDir, "commondir")} is empty`, "parse")
    : ok(path.resolve(gitDir, common));
}

// Whether a directory sits in a linked worktree, and if so its counterpart in
// the repository's main worktree, spelled as `git worktree list` spells the
// main worktree: the common dir with a trailing `.git` stripped (a bare
// repository's common dir is its own spelling).
export type WorktreeLink =
  | { readonly kind: "linked"; readonly main: string }
  | { readonly kind: "unlinked" }
  | { readonly kind: "unproven"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

const UNLINKED: WorktreeLink = { kind: "unlinked" };
const unproven = (reason: string): WorktreeLink => ({
  kind: "unproven",
  reason,
});
const unreadable = (reason: string): WorktreeLink => ({
  kind: "unreadable",
  reason,
});

// [LAW:types-are-the-program] Missing or malformed proof leaves the claim
// unproven. An OS error leaves the check unfinished and cannot choose a key.
function unverified(
  file: string,
  result: Exclude<Outcome<unknown>, { kind: "ok" }>,
): WorktreeLink {
  if (result.kind === "absent") return unproven(`${file} is not there`);
  return result.failedAt === "parse"
    ? unproven(result.reason)
    : unreadable(result.reason);
}

// [LAW:parse-dont-validate] A directory's `.git` file is the directory's own
// claim, and a directory nobody vouched for can write any claim. So the link
// is proven from the repository's side, which the directory cannot write: the
// named git dir is registered in `<common>/worktrees/`, and git's back-pointer
// there (`gitdir`) names this root's own `.git` — not a symlink to another
// checkout's. `dir` is a present directory's real path (`realpathSync.native`,
// the on-disk case git's back-pointer may not share). Total: every read
// outside `dir` is a probe, so a moved or pruned worktree is `unproven`.
export function worktreeLink(dir: string, files = checkoutFiles): WorktreeLink {
  const found = checkoutAt(dir, files);
  if (found.kind === "absent") return UNLINKED;
  if (found.kind === "failed") return unreadable(found.reason);
  const link = worktreeLinkAt(found.value, files);
  return link.kind === "linked"
    ? {
        kind: "linked",
        main: path.join(link.main, path.relative(found.value.root, dir)),
      }
    : link;
}

function worktreeLinkAt(
  { root, entry }: { readonly root: string; readonly entry: fs.Stats },
  files: CheckoutFiles,
): WorktreeLink {
  const dotGit = path.join(root, ".git");
  // A `.git` that is, or links to, a git directory claims no worktree: a
  // main checkout, or one whose `.git` a tool keeps elsewhere (Android's
  // `repo`). Only a regular file claims one, so a symlink to another
  // checkout's `.git` file borrows nothing.
  if (entry.isDirectory()) return UNLINKED;
  const direct = files.lstat(dotGit);
  if (direct.kind !== "ok") return unverified(dotGit, direct);
  if (!direct.value.isFile()) return unproven(`${dotGit} is not a file`);
  const named = gitDirNamed(root, files);
  if (named.kind !== "ok") return unverified(dotGit, named);
  const gitDir = files.realpath(named.value);
  if (gitDir.kind !== "ok") return unverified(named.value, gitDir);
  const common = commonDirOf(gitDir.value, files);
  // A git dir with no `commondir` is its own repository's: a submodule or a
  // `--separate-git-dir` checkout, which no linked worktree's answer reaches.
  if (common.kind === "absent") return UNLINKED;
  if (common.kind === "failed")
    return unverified(path.join(gitDir.value, "commondir"), common);
  const realCommon = files.realpath(common.value);
  if (realCommon.kind !== "ok") return unverified(common.value, realCommon);
  if (path.dirname(gitDir.value) !== path.join(realCommon.value, "worktrees")) {
    return unproven(`${gitDir.value} is not a worktree of ${realCommon.value}`);
  }
  const backFile = path.join(gitDir.value, "gitdir");
  const back = files.text(backFile);
  if (back.kind !== "ok") return unverified(backFile, back);
  const pointer = path.resolve(gitDir.value, back.value.trim());
  if (path.basename(pointer) !== ".git") {
    return unproven(
      `${gitDir.value} is the worktree at ${pointer}, not ${root}`,
    );
  }
  const parent = path.dirname(pointer);
  const pointerDir = files.realpath(parent);
  if (pointerDir.kind !== "ok") return unverified(parent, pointerDir);
  if (pointerDir.value !== root) {
    return unproven(
      `${gitDir.value} is the worktree at ${pointer}, not ${root}`,
    );
  }
  const main =
    path.basename(realCommon.value) === ".git"
      ? path.dirname(realCommon.value)
      : realCommon.value;
  return { kind: "linked", main };
}

// Where a directory sits in its repository, for display. `main` is the main
// checkout's root ("" in no repository), `worktree` the linked worktree's name
// ("" otherwise), `subpath` the directory below the checkout root ("/src", or
// ""). An unproven link reads as a checkout of its own, since its root is
// real. [LAW:no-silent-failure] An unreadable link does not supply a location.
export interface CheckoutLocation {
  readonly main: string;
  readonly worktree: string;
  readonly subpath: string;
  readonly noRepo: boolean;
}

export function checkoutLocation(
  dir: string,
  files = checkoutFiles,
): Outcome<CheckoutLocation> {
  const real = files.realpath(dir);
  if (real.kind === "failed") return real;
  const at = real.kind === "ok" ? real.value : path.resolve(dir);
  const found = checkoutAt(at, files);
  if (found.kind !== "ok") return found;
  const { root } = found.value;
  const sub = path.relative(root, at);
  const subpath = sub === "" ? "" : `/${sub.split(path.sep).join("/")}`;
  const link = worktreeLinkAt(found.value, files);
  if (link.kind === "unreadable") return failed(link.reason, "read");
  return link.kind === "linked"
    ? ok({
        main: link.main,
        worktree: path.basename(root),
        subpath,
        noRepo: false,
      })
    : ok({ main: root, worktree: "", subpath, noRepo: false });
}
