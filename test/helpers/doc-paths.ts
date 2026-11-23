// [LAW:one-source-of-truth] Which repository paths a document cites, and
// whether each is there. What is there is git's answer about the checkout, taken
// once for the run by the global setup (test/helpers/checkout.ts), so this
// module reads no repository path to decide: `existsIn` is a lookup over what
// git listed, and the documents it reads are the ones it is asked about.

import fs from "node:fs";
import path from "node:path";

export const ROOT = path.join(__dirname, "..", "..");

// The run's answer, carried from the global setup to the workers.
export const DOC_CITATIONS_ENV = "CC_CANDYBAR_TEST_DOC_CITATIONS";

// What a path can start at, and what git said of every path the documents cite.
export interface CitationAnswer {
  // The checkout's top-level directories and files.
  readonly directories: readonly string[];
  readonly rootFiles: readonly string[];
  // Each cited path as written, whether the checkout has it.
  readonly exists: Readonly<Record<string, boolean>>;
}

export function citationAnswer(): CitationAnswer {
  const raw = process.env[DOC_CITATIONS_ENV];
  if (raw === undefined) {
    throw new Error(
      `${DOC_CITATIONS_ENV} is unset: the unit project runs through jest.unit.config.js, whose global setup sets it`,
    );
  }
  return JSON.parse(raw) as CitationAnswer;
}

// [LAW:one-source-of-truth] The documents that must stay true to the tree are
// found in it: the two root documents, every memory file, and every design
// document except the inventory, a survey of what the code reaches kept by hand.
export const INVENTORY = "docs/design/inventory";

function markdownUnder(root: string, directory: string): string[] {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        return relative === INVENTORY ? [] : markdownUnder(root, relative);
      }
      return entry.name.endsWith(".md") ? [relative] : [];
    })
    .sort();
}

export function livingDocuments(root: string): string[] {
  return [
    "CLAUDE.md",
    "README.md",
    ...markdownUnder(root, ".claude/memory"),
    ...markdownUnder(root, "docs/design"),
  ];
}

const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A path starts at one of the checkout's top-level directories, or is one of
// its top-level files, and is no part of a longer word or path (`design-docs/`
// is no `docs/`, `../src/` is a link's business). It runs over path characters;
// sentence punctuation that ends it is no part of the path.
function citationPattern(
  directories: readonly string[],
  rootFiles: readonly string[],
): RegExp {
  const forms = [
    ...(directories.length === 0
      ? []
      : [`(?:${directories.map(escaped).join("|")})/[\\w.*/-]*[\\w*/]`]),
    ...(rootFiles.length === 0
      ? []
      : [`(?:${rootFiles.map(escaped).join("|")})(?![\\w/-]|\\.\\w)`]),
  ];
  return new RegExp(`(?<![\\w./-])(?:${forms.join("|")})`, "g");
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
  rootFiles: readonly string[] = [],
): string[] {
  const spelled = [
    ...text.matchAll(citationPattern(directories, rootFiles)),
  ].map((m) => m[0]);
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

// What git says the checkout holds: the files tracked or not yet tracked and
// not ignored, and each directory above them; and which of the paths asked
// about git ignores.
export interface Checkout {
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
  readonly ignored: ReadonlySet<string>;
}

export function checkoutOf(
  files: readonly string[],
  ignored: readonly string[],
): Checkout {
  const directories = new Set<string>(["."]);
  for (const file of files) {
    for (
      let dir = path.posix.dirname(file);
      dir !== "." && !directories.has(dir);
      dir = path.posix.dirname(dir)
    ) {
      directories.add(dir);
    }
  }
  return {
    files: new Set(files),
    directories,
    ignored: new Set(ignored),
  };
}

// A cited path is there when the checkout holds it. A glob is there when it
// matches a file or directory the checkout holds. A path git ignores is a build
// product, which a fresh checkout lacks and a document may still name: it counts
// when it would land in a directory the checkout holds, so an ignored name under
// a directory nothing holds (`src/render/dist/gone.ts`) is no build product.
export function existsIn(checkout: Checkout, cited: string): boolean {
  if (cited.includes("*")) {
    const pattern = globPattern(cited);
    return [...checkout.files, ...checkout.directories].some((held) =>
      pattern.test(held),
    );
  }
  const bare = cited.replace(/\/$/, "");
  return (
    checkout.files.has(bare) ||
    checkout.directories.has(bare) ||
    (checkout.ignored.has(cited) &&
      checkout.directories.has(path.posix.dirname(bare)))
  );
}
