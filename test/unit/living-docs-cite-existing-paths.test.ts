// [LAW:one-source-of-truth] A path written in prose is a second map of the
// tree, and nothing redraws it when the tree changes: a consolidation that moves
// or removes a file leaves every sentence naming it standing with full
// confidence. This is the check that disagrees.
//
// [LAW:behavior-not-structure] The contract is referential honesty: every
// repository path the living documents cite exists. How a document says it
// (backticks, a link, a bare word) is the document's business, so the extractor
// reads paths wherever they sit. The inventory under docs/design/inventory is a
// dated snapshot and is not covered.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

const LIVING_DOCS = [
  "CLAUDE.md",
  "docs/design/host-and-renderer.md",
  "docs/design/README.md",
  ...fs
    .readdirSync(path.join(ROOT, ".claude/memory"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `.claude/memory/${name}`),
];

const TOP_LEVEL = ["src", "test", "docs", "scripts", "rust-client"];

// A path starts at a top-level directory that is no part of a longer word or
// path (`design-docs/`, `../src/`), and runs over path characters. Sentence
// punctuation that ends it, and a `:line` suffix, are no part of the path.
const CITATION = new RegExp(
  `(?<![\\w./-])(?:${TOP_LEVEL.join("|")})/[\\w.*/-]*[\\w*/]`,
  "g",
);

export function citedPaths(text: string): string[] {
  return [...text.matchAll(CITATION)].map((m) => m[0]);
}

// A glob names a directory's members, so it exists when its directory does.
function exists(cited: string): boolean {
  const star = cited.indexOf("*");
  const literal = star === -1 ? cited : cited.slice(0, star);
  const target = star === -1 ? literal : path.dirname(`${literal}x`);
  return fs.existsSync(path.join(ROOT, target));
}

describe("citedPaths", () => {
  test("finds backticked and bare paths without their sentence punctuation", () => {
    expect(
      citedPaths("See `src/a/b.ts`, and src/c.ts. Also (test/d/e.test.ts)."),
    ).toEqual(["src/a/b.ts", "src/c.ts", "test/d/e.test.ts"]);
  });

  test("a directory and a glob are cited as written", () => {
    expect(citedPaths("`test/x/` and `src/y/*.ts`")).toEqual([
      "test/x/",
      "src/y/*.ts",
    ]);
  });

  test("a path inside a longer name or path is not a citation", () => {
    expect(
      citedPaths("design-docs/X.md, ../../src/q.ts, ~/code/src/z.ts"),
    ).toEqual([]);
  });
});

describe("the living documents", () => {
  test.each(LIVING_DOCS)("%s cites only paths that exist", (doc) => {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    const missing = [...new Set(citedPaths(text))]
      .filter((cited) => !exists(cited))
      .map((cited) => `${doc} cites ${cited}, which does not exist`);
    expect(missing).toEqual([]);
  });
});
