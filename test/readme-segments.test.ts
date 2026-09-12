// [LAW:one-source-of-truth] `DEFAULT_DSL_CONFIG.segments` is the bundled
// standard library; the README's "## Segments" section is a MAP of it, and a map
// nothing re-derives will drift. brandon-docs-umn is what that drift looked
// like: the table documented an `env` segment that was never a segment at all
// (`env` is a variable SOURCE KIND), still offered `directory` a `full`/`fish`/
// `basename` style enum deleted with PR #143, credited `sessionId` with a
// cmd-click-to-copy its template does not carry, and omitted eleven segments
// added after it was written — every one of them believed for months, because
// no check existed to disagree.
//
// [LAW:behavior-not-structure] The contract here is REFERENTIAL HONESTY: every
// name the README borrows from this codebase still exists in it. How the
// document says it — which columns the table has, what order the rows are in,
// that the settings-drawer controls sit in a second table under their own prose
// — is the document's own business, so the parse reads only each table body
// row's FIRST cell and the assertion is set equality. Reformat freely; rename a
// segment without saying so and this fails.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { isReservedName } from "../src/config/loader/reserved-namespace";

const ROOT = path.join(__dirname, "..");
const README = "README.md";

function readme(): string {
  return fs.readFileSync(path.join(ROOT, README), "utf8");
}

// [LAW:parse-dont-validate] A markdown line is one of exactly three things to a
// table reader, and saying which is this function's whole job. Downstream folds
// over the union and can no longer ask "is this a table row?" — the question is
// answered in the type it receives.
type TableLine =
  | { readonly kind: "delimiter" }
  | { readonly kind: "cells"; readonly cells: readonly string[] }
  | { readonly kind: "other" };

// A delimiter cell is dashes with optional alignment colons — `---`, `:---:`.
const DELIMITER_CELL = /^:?-{3,}:?$/;

function classify(line: string): TableLine {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return { kind: "other" };
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.every((cell) => DELIMITER_CELL.test(cell))
    ? { kind: "delimiter" }
    : { kind: "cells", cells };
}

// The lines of one `## ` section, heading excluded, ending at the next `## `.
//
// [LAW:no-silent-failure] A renamed or deleted heading is a real failure with a
// real cause, so it throws here naming what it looked for. Left to fall through
// as an empty section it would surface below as "23 names missing", which sends
// the next reader hunting for 23 deletions that never happened.
function sectionLines(heading: string): string[] {
  const lines = readme().split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`${README} has no "${heading}" heading`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

// Every table BODY row's first cell, in document order, backticks stripped.
//
// A markdown table is header, delimiter, body — so "this row is in a body" is
// exactly "a delimiter has been seen since the last non-table line". That is one
// boolean folded over the section, which is why a second table (the controls)
// needs no special handling: its own delimiter re-arms the fold, and the blank
// line before it disarms the first. [LAW:dataflow-not-control-flow]
function documentedSegmentNames(): string[] {
  const names: string[] = [];
  let inBody = false;
  for (const line of sectionLines("## Segments")) {
    const row = classify(line);
    switch (row.kind) {
      case "delimiter":
        inBody = true;
        break;
      case "cells":
        names.push(...(inBody ? [row.cells[0]!.replace(/`/g, "")] : []));
        break;
      case "other":
        inBody = false;
        break;
    }
  }
  return names;
}

describe("README describes the code it ships with", () => {
  // The documented surface is every bundled segment a user may REFERENCE, which
  // is every name outside the reserved namespaces: `DEFAULT_DSL_CONFIG` is the
  // authored literal run through the loader's synthesis pass, so its segments
  // also carry what the sugar wrote (`groups.settings`, the settings drawer's
  // own toggle). [LAW:one-source-of-truth] That line is drawn by the loader's own
  // `isReservedName` — the predicate whose comment states membership proves
  // "synthesized, not declared" — and never by a prefix re-spelled here or an
  // exclusion list maintained by hand, either of which would be a second answer
  // to a question the loader already answers.
  //
  // Compared as sorted ARRAYS, not sets: a name documented in two rows is its
  // own drift (two descriptions of one segment, free to disagree), and array
  // equality catches it for free where set equality would pass it.
  test("the segments section documents exactly the bundled segment names", () => {
    const documented = documentedSegmentNames().sort();
    const authorable = Object.keys(DEFAULT_DSL_CONFIG.segments)
      .filter((name) => !isReservedName(name))
      .sort();
    expect(documented).toEqual(authorable);
  });

  // Only `src/` and `rust-client/` — both always present in a checkout. `dist/`
  // and `bin/cc-candybar-native` are build outputs the README also names, and a
  // check that failed on a fresh clone would be deleted rather than fixed.
  test("every source path the README cites exists", () => {
    const cited = [...readme().matchAll(/`((?:src|rust-client)\/[\w./-]*)`/g)].map(
      (match) => match[1]!,
    );
    // [LAW:no-silent-failure] A prose rewrite that stops backticking paths would
    // otherwise make this pass by matching nothing at all.
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((cit) => !fs.existsSync(path.join(ROOT, cit)))).toEqual([]);
  });
});
