// [LAW:one-source-of-truth] A path written in prose is a second map of the
// tree, and nothing redraws it when the tree changes: a consolidation that moves
// or removes a file leaves every sentence naming it standing with full
// confidence. This is the check that disagrees.
//
// [LAW:behavior-not-structure] The contract is referential honesty: every
// repository path the living documents cite exists. How a document says it
// (backticks, a link, a bare word) is the document's business, so the extractor
// reads paths wherever they sit (test/helpers/doc-paths.ts). The documents are
// found in the tree, not listed: a new memory file or design doc is covered the
// day it is written. The inventory under docs/design/inventory is a survey of
// what the code reaches, kept by hand, and is not covered.

import fs from "node:fs";
import path from "node:path";

import {
  ROOT,
  citedPaths,
  exists,
  ignoredByGit,
  repositoryDirectories,
} from "../helpers/doc-paths";

const INVENTORY = "docs/design/inventory";

function markdownUnder(directory: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        return relative === INVENTORY ? [] : markdownUnder(relative);
      }
      return entry.name.endsWith(".md") ? [relative] : [];
    })
    .sort();
}

const LIVING_DOCS = [
  "CLAUDE.md",
  "README.md",
  ...markdownUnder(".claude/memory"),
  ...markdownUnder("docs/design"),
];

const DIRECTORIES = ["src", "test", "docs"];

describe("citedPaths", () => {
  test("finds backticked and bare paths without their sentence punctuation", () => {
    expect(
      citedPaths(
        "See `src/a/b.ts`, and src/c.ts. Also (test/d/e.test.ts).",
        "docs",
        DIRECTORIES,
      ),
    ).toEqual(["src/a/b.ts", "src/c.ts", "test/d/e.test.ts"]);
  });

  test("a directory and a glob are cited as written", () => {
    expect(
      citedPaths("`test/x/` and `src/y/*.ts`", "docs", DIRECTORIES),
    ).toEqual(["test/x/", "src/y/*.ts"]);
  });

  test("a path inside a longer name or path is not a citation", () => {
    expect(
      citedPaths(
        "design-docs/X.md, ../../src/q.ts, ~/code/src/z.ts",
        "docs",
        DIRECTORIES,
      ),
    ).toEqual([]);
  });

  test("a relative link resolves against its document's directory", () => {
    expect(
      citedPaths(
        "[a](../../src/x.ts#L3) [b](sibling.md) [c](https://example.com/src/x) [d](#top)",
        "docs/design/areas",
        DIRECTORIES,
      ),
    ).toEqual(["docs/src/x.ts", "docs/design/areas/sibling.md"]);
  });

  test("a link that leaves the repository cites no path", () => {
    expect(
      citedPaths("[a](../../../../elsewhere.md)", "docs/design", DIRECTORIES),
    ).toEqual([]);
  });

  test("the top-level directories are the root's own, minus the ignored", () => {
    const directories = repositoryDirectories();
    expect(directories).toEqual(
      expect.arrayContaining(["src", "test", "docs", ".claude", "design-docs"]),
    );
    expect(directories).not.toContain(".git");
    expect(directories).not.toContain("node_modules");
  });

  test("a path under .claude/ and design-docs/ is a citation", () => {
    expect(
      citedPaths("`.claude/memory/x.md` and design-docs/Y.md", "docs", [
        ".claude",
        "design-docs",
      ]),
    ).toEqual([".claude/memory/x.md", "design-docs/Y.md"]);
  });
});

describe("exists", () => {
  test("a file and a directory that are on disk exist", () => {
    expect(exists(ROOT, "src/index.ts")).toBe(true);
    expect(exists(ROOT, "src/daemon/")).toBe(true);
  });

  test("a path that is not on disk does not exist", () => {
    expect(exists(ROOT, "src/no-such-module.ts")).toBe(false);
    expect(exists(ROOT, "src/no-such-directory/inner.ts")).toBe(false);
  });

  test("a glob that matches a file exists", () => {
    expect(exists(ROOT, "src/*.ts")).toBe(true);
    expect(exists(ROOT, "src/**/*.ts")).toBe(true);
  });

  test("a glob that matches nothing does not exist, though its directory does", () => {
    expect(exists(ROOT, "src/*.nomatch")).toBe(false);
    expect(exists(ROOT, "src/no-such-directory/*.ts")).toBe(false);
  });

  test("a path .gitignore names is a build product and is taken as existing", () => {
    expect(exists(ROOT, "dist/index.mjs")).toBe(true);
    expect(exists(ROOT, "site/dist")).toBe(true);
  });
});

describe("ignoredByGit", () => {
  const gitignore = "# comment\ndist/\n/bin/native\n!keep\n*.log\n";

  test("an unanchored pattern names a segment at any depth", () => {
    expect(ignoredByGit(gitignore, "site/dist")).toBe(true);
    expect(ignoredByGit(gitignore, "a/b/out.log")).toBe(true);
  });

  test("a pattern with a slash is anchored at the root", () => {
    expect(ignoredByGit(gitignore, "bin/native")).toBe(true);
    expect(ignoredByGit(gitignore, "other/bin/native")).toBe(false);
  });

  test("a path no pattern names is not ignored", () => {
    expect(ignoredByGit(gitignore, "src/index.ts")).toBe(false);
    expect(ignoredByGit(gitignore, "keep")).toBe(false);
  });
});

describe("the living documents", () => {
  test("the set is found from the tree", () => {
    expect(LIVING_DOCS).toEqual(
      expect.arrayContaining([
        "CLAUDE.md",
        "README.md",
        ".claude/memory/architecture.md",
        "docs/design/host-and-renderer.md",
        "docs/design/areas/clicks.md",
      ]),
    );
    expect(LIVING_DOCS.some((doc) => doc.startsWith(INVENTORY))).toBe(false);
  });

  test.each(LIVING_DOCS)("%s cites only paths that exist", (doc) => {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    const missing = [
      ...new Set(
        citedPaths(text, path.posix.dirname(doc), repositoryDirectories()),
      ),
    ]
      .filter((cited) => !exists(ROOT, cited))
      .map((cited) => `${doc} cites ${cited}, which does not exist`);
    expect(missing).toEqual([]);
  });
});
