// [LAW:one-source-of-truth] Which repository paths a document cites, and
// whether each is on disk. The documents that must stay true to the tree
// (test/unit/living-docs-cite-existing-paths.test.ts) read through this, so
// what counts as a citation is decided in one place.

import fs from "node:fs";
import path from "node:path";

import { IGNORED_ENV } from "./package-files";

export const ROOT = path.join(__dirname, "..", "..");

// [LAW:one-source-of-truth] The top-level directories a citation can start at
// are the root's own, apart from `.git`, `node_modules` and what .gitignore names (builds, logs,
// other worktrees): a path into those would not be the repository's.
export function topLevelDirectories(
  root: string,
  ignored: readonly string[],
): string[] {
  const named = new Set(ignored.map((entry) => entry.replace(/\/$/, "")));
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== ".git" &&
        entry.name !== "node_modules" &&
        !named.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

export function repositoryDirectories(): string[] {
  const answer = process.env[IGNORED_ENV];
  if (answer === undefined) {
    throw new Error(
      `${IGNORED_ENV} is unset: the unit project runs through jest.unit.config.js, whose global setup sets it`,
    );
  }
  return topLevelDirectories(ROOT, JSON.parse(answer) as string[]);
}

const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A path starts at a top-level directory that is no part of a longer word or
// path (`design-docs/` is no `docs/`, `../src/` is a link's business), and runs
// over path characters. Sentence punctuation that ends it is no part of the path.
function citationPattern(directories: readonly string[]): RegExp {
  const names = directories.map(escaped).join("|");
  return new RegExp(`(?<![\\w./-])(?:${names})/[\\w.*/-]*[\\w*/]`, "g");
}

// A markdown link whose target is a relative path: `[text](../../src/x.ts#L3)`
// or `[text](sibling.md)`.
const LINK_TARGET = /\]\(([^)\s]+)\)/g;

// What a document cites, as repository paths: the paths it spells from the
// root, and each relative link resolved against the document's own directory.
// A link out of the repository, to a URL or to an anchor, cites no path here.
export function citedPaths(
  text: string,
  docDir: string,
  directories: readonly string[],
): string[] {
  const spelled = [...text.matchAll(citationPattern(directories))].map(
    (m) => m[0],
  );
  const linked = [...text.matchAll(LINK_TARGET)].flatMap((m) => {
    const target = m[1]!.split("#")[0]!;
    if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) return [];
    if (target.startsWith("/")) return [];
    const resolved = path.posix.normalize(path.posix.join(docDir, target));
    return resolved.startsWith("..") ? [] : [resolved];
  });
  return [...spelled, ...linked];
}

// A glob's pattern as a regular expression over a path from the root: `*` is
// within one name, `**` crosses directories.
function globPattern(glob: string): RegExp {
  const body = glob
    .split("**")
    .map((part) => part.split("*").map(escaped).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

function filesUnder(root: string, directory: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const relative = path.posix.join(dir, entry.name);
      found.push(relative);
      if (entry.isDirectory() && entry.name !== "node_modules") walk(relative);
    }
  };
  walk(directory);
  return found;
}

// Whether .gitignore names a path: what a build or a run produces, which a
// fresh checkout lacks and a document may still cite. A pattern with no slash
// but a trailing one names a path segment at any depth; a pattern with a slash
// in it is anchored at the root.
export function ignoredByGit(gitignore: string, cited: string): boolean {
  const segments = cited.replace(/\/$/, "").split("/");
  return gitignore.split("\n").some((raw) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) {
      return false;
    }
    const pattern = line.replace(/^\//, "").replace(/\/$/, "");
    const anchored = line.replace(/\/$/, "").includes("/");
    const names = pattern.split("/");
    const starts = anchored
      ? [0]
      : segments.map((_, index) => index);
    return starts.some((start) =>
      names.every((name, offset) => {
        const segment = segments[start + offset];
        return segment !== undefined && globPattern(name).test(segment);
      }),
    );
  });
}

// A cited path exists when it is on disk or .gitignore names it as something
// a build produces. A glob exists when it matches at least one real file or
// directory, so a glob over a directory that holds nothing of that shape is a
// citation of nothing.
export function exists(root: string, cited: string): boolean {
  if (!cited.includes("*")) {
    return (
      fs.existsSync(path.join(root, cited)) ||
      ignoredByGit(
        fs.readFileSync(path.join(root, ".gitignore"), "utf8"),
        cited,
      )
    );
  }
  const literal = cited.slice(0, cited.indexOf("*"));
  const base = literal.slice(0, literal.lastIndexOf("/"));
  if (base === "" || !fs.existsSync(path.join(root, base))) return false;
  const pattern = globPattern(cited);
  return filesUnder(root, base).some((file) => pattern.test(file));
}
