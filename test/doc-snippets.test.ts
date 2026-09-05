// [LAW:one-source-of-truth] The docs teach by example: the interaction
// authoring reference (docs/interaction-authoring.md) shows an AGENT author
// canonical configs that must load and mistakes paired with the loader's ACTUAL
// error text; the README shows a human the merge model with one config. Every
// such snippet rots silently if untested — a drifted example teaches the next
// reader a stale spelling (the README's example once used a deleted `layout:`
// sugar for a release cycle, brandon-docs-3vl), and a drifted error quote
// teaches it to expect text the loader no longer prints. This suite extracts
// every annotated snippet from every listed doc and drives it through
// checkConfig — the same entry function `cc-candybar check` runs — so the docs,
// the CLI, and the daemon cannot disagree about what loads or what an error says.
//
// [LAW:one-type-per-behavior] One snippet contract, N docs: a doc is a row in
// DOCS carrying only what differs — its path and the floor each snippet family
// must clear, which guards the extractor against a format drift that matches
// nothing and lets the suite pass vacuously.
//
// Snippet contract (stated in each doc's header comment):
//   ```json5 check:pass  — a complete config; must be clean (exit 0, no warnings)
//   ```json5 check:fail  — a complete config; must be fatal (exit 1), and the
//                          IMMEDIATELY FOLLOWING fenced block, tagged `error`,
//                          must quote a substring of the actual fatal message.
// Every ```json5 block must carry one of the two annotations — an unannotated
// config snippet is an untested claim, which this suite rejects.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, checkPlan } from "../src/check";

const ROOT = path.join(__dirname, "..");

interface Doc {
  readonly path: string;
  readonly minPass: number;
  readonly minFail: number;
}

const DOCS: readonly Doc[] = [
  { path: "docs/interaction-authoring.md", minPass: 4, minFail: 10 },
  { path: "README.md", minPass: 1, minFail: 0 },
];

interface Fence {
  readonly doc: string;
  readonly info: string;
  readonly body: string;
  readonly line: number;
}

// One pass over a doc: every fenced block, in document order, with its info
// string and 1-based opening line (for failure messages that point at the doc).
function extractFences(doc: string): Fence[] {
  const lines = fs.readFileSync(path.join(ROOT, doc), "utf8").split("\n");
  const fences: Fence[] = [];
  let open: { info: string; line: number; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      if (open === null) {
        open = { info: line.slice(3).trim(), line: i + 1, body: [] };
      } else {
        fences.push({
          doc,
          info: open.info,
          body: open.body.join("\n"),
          line: open.line,
        });
        open = null;
      }
      continue;
    }
    if (open !== null) open.body.push(line);
  }
  // An unclosed fence means the doc itself is malformed — surface it rather
  // than silently dropping the tail.
  expect(open).toBeNull();
  return fences;
}

const fencesByDoc = new Map(DOCS.map((d) => [d.path, extractFences(d.path)]));
const fences = [...fencesByDoc.values()].flat();

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-doc-snippets-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// checkConfig's collision scan reads the cwd/XDG candidate paths; pin XDG so a
// developer's real ~/.config/cc-candybar can never leak a warning into a
// pass-snippet assertion.
const SAVED_XDG = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "cc-doc-xdg-empty");
});
afterAll(() => {
  if (SAVED_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = SAVED_XDG;
});

function checkSnippet(f: Fence): ReturnType<typeof checkConfig> {
  const p = path.join(dir, `${path.basename(f.doc)}-L${f.line}.json5`);
  fs.writeFileSync(p, f.body);
  return checkConfig(p, dir);
}

const isPass = (f: Fence): boolean => f.info === "json5 check:pass";
const isFail = (f: Fence): boolean => f.info === "json5 check:fail";

const passSnippets = fences.filter(isPass);
// A fail snippet's quoted error is the fence that follows it IN ITS OWN DOC —
// pair within each doc, so a doc's last fence can never borrow the next doc's
// first as its quote.
const failSnippets = [...fencesByDoc.values()].flatMap((docFences) =>
  docFences
    .map((f, i) => ({ f, next: docFences[i + 1] }))
    .filter(({ f }) => isFail(f)),
);

describe("doc snippet contract", () => {
  // Guard the extractor: a format drift that matches nothing must fail loudly,
  // not let the whole suite pass vacuously.
  test.each(DOCS)("$path contains the expected snippet families", (doc) => {
    const own = fencesByDoc.get(doc.path)!;
    expect(own.filter(isPass).length).toBeGreaterThanOrEqual(doc.minPass);
    expect(own.filter(isFail).length).toBeGreaterThanOrEqual(doc.minFail);
  });

  test("every json5 fence is annotated check:pass or check:fail", () => {
    const unannotated = fences.filter(
      (f) =>
        f.info.startsWith("json5") &&
        f.info !== "json5 check:pass" &&
        f.info !== "json5 check:fail",
    );
    expect(
      unannotated.map((f) => `${f.doc} line ${f.line}: \`\`\`${f.info}`),
    ).toEqual([]);
  });

  test.each(passSnippets.map((f) => [f.doc, f.line, f] as const))(
    "pass snippet at %s line %d is clean under check (exit 0, no warnings)",
    (_doc, _line, f) => {
      const outcome = checkSnippet(f);
      if (outcome.kind !== "clean") {
        throw new Error(
          `${f.doc} line ${f.line}: expected clean, got ${outcome.kind}: ${
            "message" in outcome ? outcome.message : ""
          }`,
        );
      }
      expect(checkPlan(outcome).code).toBe(0);
      expect(outcome.warnings).toEqual([]);
      expect(outcome.rendered.length).toBeGreaterThan(0);
    },
  );

  test.each(
    failSnippets.map(({ f, next }) => [f.doc, f.line, f, next] as const),
  )(
    "fail snippet at %s line %d is fatal and prints its quoted error",
    (_doc, _line, f, next) => {
      // The block immediately after a check:fail snippet is its quoted error —
      // the doc's contract, enforced here so a snippet can never drift away
      // from its quote.
      if (next === undefined || next.info !== "error") {
        throw new Error(
          `${f.doc} line ${f.line}: a check:fail snippet must be immediately followed by an \`\`\`error block quoting the real message`,
        );
      }
      const quoted = next.body.trim();
      expect(quoted.length).toBeGreaterThan(0);
      const outcome = checkSnippet(f);
      if (outcome.kind !== "fatal") {
        throw new Error(
          `${f.doc} line ${f.line}: expected fatal, got ${outcome.kind}`,
        );
      }
      const plan = checkPlan(outcome);
      expect(plan.code).toBe(1);
      // [LAW:one-source-of-truth] The doc's stated contract is "a substring of
      // check's actual stderr" — assert against exactly that surface (the full
      // fatal stderr checkPlan emits, which carries the message), so the doc's
      // sentence and this assertion are one contract, not a stricter shadow.
      if (!plan.stderr.includes(quoted)) {
        throw new Error(
          `${f.doc} line ${next.line}: quoted error text does not match check's actual stderr.\n` +
            `quoted:\n${quoted}\n\nactual stderr:\n${plan.stderr}`,
        );
      }
    },
  );
});
