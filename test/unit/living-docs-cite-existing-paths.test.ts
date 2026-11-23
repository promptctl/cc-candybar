// [LAW:one-source-of-truth] A path written in prose is a second map of the
// tree, and nothing redraws it when the tree changes: a consolidation that moves
// or removes a file leaves every sentence naming it standing with full
// confidence. This is the check that disagrees.
//
// [LAW:behavior-not-structure] The contract is referential honesty: every
// repository path a covered document cites is in the checkout, by git's answer
// (test/helpers/checkout.ts), the same on a clean tree and a built one. How a
// document says it (backticks, a link, a bare word) is the document's business,
// so the extractor reads paths wherever they sit (test/helpers/doc-paths.ts).
//
// The covered documents are found in the tree, not listed: CLAUDE.md, README.md,
// every file under .claude/memory, and every file under docs/design except the
// inventory, a survey of what the code reaches kept by hand. The other
// documents (the authoring and test guides under docs/, and design-docs/) are
// not covered.

import fs from "node:fs";
import path from "node:path";

import {
  INVENTORY,
  ROOT,
  checkoutOf,
  citationAnswer,
  citedPaths,
  existsIn,
  livingDocuments,
} from "../helpers/doc-paths";

const DOCUMENTS = livingDocuments(ROOT);
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

  test("a path under .claude/ and design-docs/ is a citation", () => {
    expect(
      citedPaths("`.claude/memory/x.md` and design-docs/Y.md", "docs", [
        ".claude",
        "design-docs",
      ]),
    ).toEqual([".claude/memory/x.md", "design-docs/Y.md"]);
  });

  test("a top-level file is a citation as a bare name, and no part of a longer one", () => {
    expect(
      citedPaths(
        "`tsconfig.json`, CLAUDE.md. And areas/CLAUDE.md, my-tsconfig.json, tsconfig.json.bak.",
        "docs",
        DIRECTORIES,
        ["tsconfig.json", "CLAUDE.md"],
      ),
    ).toEqual(["tsconfig.json", "CLAUDE.md"]);
  });
});

describe("existsIn", () => {
  const checkout = checkoutOf(
    ["src/index.ts", "src/daemon/a.ts", "bin/cc-candybar", "tsconfig.json"],
    [
      "bin/cc-candybar-native",
      "src/render/dist/gone.ts",
      "dist/index.mjs",
      "site/dist",
    ],
  );

  test("a file and a directory the checkout holds exist", () => {
    expect(existsIn(checkout, "src/index.ts")).toBe(true);
    expect(existsIn(checkout, "src/daemon/")).toBe(true);
    expect(existsIn(checkout, "tsconfig.json")).toBe(true);
  });

  test("a path the checkout does not hold does not exist", () => {
    expect(existsIn(checkout, "src/no-such-module.ts")).toBe(false);
    expect(existsIn(checkout, "src/no-such-directory/inner.ts")).toBe(false);
    expect(existsIn(checkout, "package.json")).toBe(false);
  });

  test("a glob that matches a file exists", () => {
    expect(existsIn(checkout, "src/*.ts")).toBe(true);
    expect(existsIn(checkout, "src/**/*.ts")).toBe(true);
  });

  test("a glob that matches nothing does not exist, though its directory does", () => {
    expect(existsIn(checkout, "src/*.nomatch")).toBe(false);
    expect(existsIn(checkout, "src/no-such-directory/*.ts")).toBe(false);
  });

  test("a build product git ignores exists when it lands in a directory the checkout holds", () => {
    expect(existsIn(checkout, "bin/cc-candybar-native")).toBe(true);
  });

  test("an ignored name under a directory nothing holds is no build product", () => {
    expect(existsIn(checkout, "src/render/dist/gone.ts")).toBe(false);
    expect(existsIn(checkout, "dist/index.mjs")).toBe(false);
    expect(existsIn(checkout, "site/dist")).toBe(false);
  });
});

describe("the living documents", () => {
  const answer = citationAnswer();

  test("the set is found from the tree", () => {
    expect(DOCUMENTS).toEqual(
      expect.arrayContaining([
        "CLAUDE.md",
        "README.md",
        ".claude/memory/architecture.md",
        "docs/design/host-and-renderer.md",
        "docs/design/areas/clicks.md",
      ]),
    );
    expect(DOCUMENTS.some((doc) => doc.startsWith(INVENTORY))).toBe(false);
  });

  test("a citation starts at the checkout's own directories and files", () => {
    expect(answer.directories).toEqual(
      expect.arrayContaining(["src", "test", "docs", ".claude", "design-docs"]),
    );
    expect(answer.rootFiles).toEqual(
      expect.arrayContaining(["package.json", "tsconfig.json", "CLAUDE.md"]),
    );
    expect(answer.directories).not.toContain(".git");
  });

  test.each(DOCUMENTS)("%s cites only paths that exist", (doc) => {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    const missing = [
      ...new Set(
        citedPaths(
          text,
          path.posix.dirname(doc),
          answer.directories,
          answer.rootFiles,
        ),
      ),
    ]
      .filter((cited) => {
        const held = answer.exists[cited];
        if (held === undefined) {
          throw new Error(
            `${doc} cites ${cited}, which the global setup was never asked about: its answer and this test read the documents differently`,
          );
        }
        return !held;
      })
      .map((cited) => `${doc} cites ${cited}, which does not exist`);
    expect(missing).toEqual([]);
  });
});
