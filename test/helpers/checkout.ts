// [LAW:single-enforcer] The one place the document check asks git what the
// checkout holds, so the unit tests that use the answer touch no repository
// path to decide. Only the unit global setup runs it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  checkoutOf,
  citedPaths,
  existsIn,
  livingDocuments,
  type CitationAnswer,
} from "./doc-paths";

function git(root: string, args: readonly string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

const entries = (listing: string): string[] =>
  listing.split("\0").filter((entry) => entry !== "");

// What the checkout holds now: tracked and untracked-not-ignored files, less
// those deleted from the tree. A file you just made and have not committed is
// there; one you deleted and have not committed is not.
function present(root: string): string[] {
  const listed = entries(
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  );
  const deleted = new Set(entries(git(root, ["ls-files", "-z", "--deleted"])));
  return [...new Set(listed)].filter((file) => !deleted.has(file));
}

// What a citation can start at: the top-level names of anything the commit, the
// index or the tree holds, so a file deleted or renamed but not yet committed
// is still named, and its citation is still checked.
function startsOf(root: string, files: readonly string[]): string[] {
  const committed = entries(
    git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]),
  );
  return [...new Set([...committed, ...files])];
}

// The paths git ignores, from those asked about. `--no-index` asks of the name
// alone, tracked or not. A directory pattern (`dist/`) names only a path with a
// slash after it, so each path is asked in both forms. Exit 1 is git's "none".
function ignoredAmong(root: string, paths: readonly string[]): string[] {
  const asked = paths.flatMap((p) => [p, `${p}/`]);
  if (asked.length === 0) return [];
  let out: string;
  try {
    out = git(
      root,
      ["check-ignore", "--no-index", "-z", "--stdin"],
      asked.join("\0") + "\0",
    );
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
  const hit = new Set(entries(out));
  return paths.filter((p) => hit.has(p) || hit.has(`${p}/`));
}

// [LAW:no-silent-failure] A failing git throws: an empty answer would read as
// "the checkout holds nothing" and fail every document, or as "nothing is
// ignored" and hide a build product.
export function readCitationAnswer(root: string): CitationAnswer {
  const files = present(root);
  const starts = startsOf(root, files);
  const directories = [
    ...new Set(starts.filter((p) => p.includes("/")).map((p) => p.split("/")[0]!)),
  ].sort();
  const rootFiles = starts.filter((p) => !p.includes("/")).sort();

  const cited = [
    ...new Set(
      livingDocuments(root).flatMap((doc) =>
        citedPaths(
          fs.readFileSync(path.join(root, doc), "utf8"),
          path.posix.dirname(doc),
          directories,
          rootFiles,
        ),
      ),
    ),
  ];
  const checkout = checkoutOf(
    files,
    ignoredAmong(
      root,
      cited.filter((p) => !p.includes("*")),
    ),
  );
  return {
    directories,
    rootFiles,
    exists: Object.fromEntries(cited.map((p) => [p, existsIn(checkout, p)])),
  };
}
