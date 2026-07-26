// [LAW:one-source-of-truth] The interaction authoring reference
// (docs/interaction-authoring.md) teaches an AGENT author by example: canonical
// configs that must load, and mistakes paired with the loader's ACTUAL error
// text. Both halves rot silently if untested — a drifted example teaches the
// next agent a stale spelling, and a drifted error quote teaches it to expect
// text the loader no longer prints. This suite extracts every annotated snippet
// from the doc and drives it through checkConfig — the same entry function
// `cc-candybar check` runs — so the doc, the CLI, and the daemon cannot
// disagree about what loads or what an error says.
//
// Snippet contract (stated in the doc's header comment):
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

const DOC = path.join(__dirname, "..", "docs", "interaction-authoring.md");

interface Fence {
  readonly info: string;
  readonly body: string;
  readonly line: number;
}

// One pass over the doc: every fenced block, in document order, with its info
// string and 1-based opening line (for failure messages that point at the doc).
function extractFences(source: string): Fence[] {
  const lines = source.split("\n");
  const fences: Fence[] = [];
  let open: { info: string; line: number; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      if (open === null) {
        open = { info: line.slice(3).trim(), line: i + 1, body: [] };
      } else {
        fences.push({
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

const fences = extractFences(fs.readFileSync(DOC, "utf8"));

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
  const p = path.join(dir, `snippet-L${f.line}.json5`);
  fs.writeFileSync(p, f.body);
  return checkConfig(p, dir);
}

const passSnippets = fences.filter((f) => f.info === "json5 check:pass");
const failSnippets = fences
  .map((f, i) => ({ f, next: fences[i + 1] }))
  .filter(({ f }) => f.info === "json5 check:fail");

describe("docs/interaction-authoring.md snippet contract", () => {
  // Guard the extractor: a format drift that matches nothing must fail loudly,
  // not let the whole suite pass vacuously.
  test("the doc contains the expected snippet families", () => {
    expect(passSnippets.length).toBeGreaterThanOrEqual(4);
    expect(failSnippets.length).toBeGreaterThanOrEqual(10);
  });

  test("every json5 fence is annotated check:pass or check:fail", () => {
    const unannotated = fences.filter(
      (f) =>
        f.info.startsWith("json5") &&
        f.info !== "json5 check:pass" &&
        f.info !== "json5 check:fail",
    );
    expect(
      unannotated.map((f) => `line ${f.line}: \`\`\`${f.info}`),
    ).toEqual([]);
  });

  test.each(passSnippets.map((f) => [f.line, f] as const))(
    "pass snippet at doc line %d is clean under check (exit 0, no warnings)",
    (_line, f) => {
      const outcome = checkSnippet(f);
      if (outcome.kind !== "clean") {
        throw new Error(
          `doc line ${f.line}: expected clean, got ${outcome.kind}: ${
            "message" in outcome ? outcome.message : ""
          }`,
        );
      }
      expect(checkPlan(outcome).code).toBe(0);
      expect(outcome.warnings).toEqual([]);
      expect(outcome.rendered.length).toBeGreaterThan(0);
    },
  );

  test.each(failSnippets.map(({ f, next }) => [f.line, f, next] as const))(
    "fail snippet at doc line %d is fatal and prints its quoted error",
    (_line, f, next) => {
      // The block immediately after a check:fail snippet is its quoted error —
      // the doc's contract, enforced here so a snippet can never drift away
      // from its quote.
      if (next === undefined || next.info !== "error") {
        throw new Error(
          `doc line ${f.line}: a check:fail snippet must be immediately followed by an \`\`\`error block quoting the real message`,
        );
      }
      const quoted = next.body.trim();
      expect(quoted.length).toBeGreaterThan(0);
      const outcome = checkSnippet(f);
      if (outcome.kind !== "fatal") {
        throw new Error(
          `doc line ${f.line}: expected fatal, got ${outcome.kind}`,
        );
      }
      expect(checkPlan(outcome).code).toBe(1);
      // The doc quotes a substring of the actual message (the stable text
      // after the [line • path] prefix) — asserted verbatim, not transcribed.
      if (!outcome.message.includes(quoted)) {
        throw new Error(
          `doc line ${next.line}: quoted error text does not match the loader's actual message.\n` +
            `quoted:\n${quoted}\n\nactual:\n${outcome.message}`,
        );
      }
    },
  );
});
