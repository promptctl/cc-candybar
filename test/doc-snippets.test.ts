// [LAW:one-source-of-truth] The docs teach by example: the interaction
// authoring reference (docs/interaction-authoring.md) shows an AGENT author
// canonical configs that must load and mistakes paired with the loader's ACTUAL
// error text; the segment authoring reference (docs/segment-authoring.md)
// does the same for a data-backed segment — a peer script, a shell source,
// dotted reads, a ramp; the README shows a human the merge model with one
// config. Every such snippet rots silently if untested — a drifted example
// teaches the next reader a stale spelling (the README's example once used a
// deleted `layout:` sugar for a release cycle, brandon-docs-3vl), and a
// drifted error quote teaches it to expect text the loader no longer prints.
// This suite extracts every annotated snippet from every listed doc and
// drives it through checkConfig — the same entry function `cc-candybar check`
// runs — so the docs, the CLI, and the daemon cannot disagree about what loads
// or what an error says.
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
//   ```sh stub:<name>    — an executable the doc's `shell` snippets may run:
//                          its body is written verbatim as `<name>` onto a PATH
//                          prefix before any snippet runs, so a `shell` source
//                          in a doc depends on the doc, never on the CI box's
//                          tools (brandon-custom-segments-g5z.3).
// Every ```json5 block must carry one of the two annotations — an unannotated
// config snippet is an untested claim, which this suite rejects.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, checkPlan } from "../src/check";

const ROOT = path.join(__dirname, "..");

// [LAW:parse-dont-validate] A fence's info string is parsed ONCE, here, into
// the family it belongs to; every test below switches on `kind`, never on the
// raw string. `other` is every fence the contract does not govern (a bare
// ``` block, a ```ts example) — a real member, so the parse is total.
type Snippet =
  | { readonly kind: "pass" }
  | { readonly kind: "fail" }
  | { readonly kind: "error" }
  | { readonly kind: "stub"; readonly name: string }
  | { readonly kind: "other" };

// A stub's name is a bare executable name: what `command: "budget-status"`
// spells, and nothing a shell would interpret.
const STUB_INFO = /^sh stub:([a-z][a-z0-9-]*)$/;

function parseInfo(info: string): Snippet {
  if (info === "json5 check:pass") return { kind: "pass" };
  if (info === "json5 check:fail") return { kind: "fail" };
  if (info === "error") return { kind: "error" };
  const stub = STUB_INFO.exec(info);
  if (stub !== null) return { kind: "stub", name: stub[1]! };
  return { kind: "other" };
}

// The floors a doc's families must clear. Zero is a real floor (the README
// has no fail snippets and no stubs), not an absence.
type Family = Exclude<Snippet["kind"], "error" | "other">;
const FAMILIES = ["pass", "fail", "stub"] as const satisfies readonly Family[];

interface Doc {
  readonly path: string;
  readonly floors: Readonly<Record<Family, number>>;
}

const DOCS: readonly Doc[] = [
  {
    path: "docs/interaction-authoring.md",
    floors: { pass: 4, fail: 10, stub: 0 },
  },
  {
    path: "docs/segment-authoring.md",
    floors: { pass: 6, fail: 8, stub: 1 },
  },
  { path: "README.md", floors: { pass: 1, fail: 0, stub: 0 } },
];

interface Fence {
  readonly doc: string;
  readonly info: string;
  readonly snippet: Snippet;
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
          snippet: parseInfo(open.info),
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

// [LAW:one-source-of-truth] One bin directory serves every doc, so a stub
// name is one executable: two docs (or one doc twice) spelling the same name
// with different bodies would leave whichever was written last on PATH, and
// a snippet reading the other's shape would fail pointing at the wrong doc.
// [LAW:no-silent-failure] A duplicate throws at module load, before any
// stub is written.
const stubs = new Map<string, Fence>();
for (const f of fences) {
  if (f.snippet.kind !== "stub") continue;
  const prior = stubs.get(f.snippet.name);
  if (prior !== undefined) {
    throw new Error(
      `stub "${f.snippet.name}" is declared twice: ${prior.doc} line ${prior.line} and ${f.doc} line ${f.line}`,
    );
  }
  stubs.set(f.snippet.name, f);
}

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

// [LAW:effects-at-boundaries] The stubs reach a `shell` source through the
// one seam it already has: the reader spawns `/bin/sh -c <command>` with the
// process environment (src/proc/launch.ts inherits it when no env is given),
// so a PATH prefix set here is the whole mechanism — no test-only hook in the
// source pipeline.
const SAVED_PATH = process.env.PATH;
beforeAll(() => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const [name, f] of stubs) {
    fs.writeFileSync(path.join(bin, name), f.body, { mode: 0o755 });
  }
  process.env.PATH = `${bin}${path.delimiter}${SAVED_PATH ?? ""}`;
});
afterAll(() => {
  if (SAVED_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = SAVED_PATH;
});

function checkSnippet(f: Fence): ReturnType<typeof checkConfig> {
  const p = path.join(dir, `${path.basename(f.doc)}-L${f.line}.json5`);
  fs.writeFileSync(p, f.body);
  return checkConfig(p, dir);
}

const ofKind =
  (kind: Snippet["kind"]) =>
  (f: Fence): boolean =>
    f.snippet.kind === kind;

const passSnippets = fences.filter(ofKind("pass"));
// A fail snippet's quoted error is the fence that follows it IN ITS OWN DOC —
// pair within each doc, so a doc's last fence can never borrow the next doc's
// first as its quote.
const failSnippets = [...fencesByDoc.values()].flatMap((docFences) =>
  docFences
    .map((f, i) => ({ f, next: docFences[i + 1] }))
    .filter(({ f }) => f.snippet.kind === "fail"),
);

describe("doc snippet contract", () => {
  // Guard the extractor: a format drift that matches nothing must fail loudly,
  // not let the whole suite pass vacuously.
  test.each(DOCS)("$path contains the expected snippet families", (doc) => {
    const own = fencesByDoc.get(doc.path)!;
    const short = FAMILIES.map((family) => ({
      family,
      count: own.filter(ofKind(family)).length,
      floor: doc.floors[family],
    })).filter(({ count, floor }) => count < floor);
    expect(short).toEqual([]);
  });

  test("every json5 fence is annotated check:pass or check:fail, every sh stub: fence names its executable", () => {
    const unannotated = fences.filter(
      (f) =>
        (f.info.startsWith("json5") || f.info.startsWith("sh stub")) &&
        f.snippet.kind === "other",
    );
    expect(
      unannotated.map((f) => `${f.doc} line ${f.line}: \`\`\`${f.info}`),
    ).toEqual([]);
  });

  test.each(passSnippets.map((f) => [f.doc, f.line, f] as const))(
    "pass snippet at %s line %d is clean under check (exit 0, no warnings)",
    async (_doc, _line, f) => {
      const outcome = await checkSnippet(f);
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
    async (_doc, _line, f, next) => {
      // The block immediately after a check:fail snippet is its quoted error —
      // the doc's contract, enforced here so a snippet can never drift away
      // from its quote.
      if (next === undefined || next.snippet.kind !== "error") {
        throw new Error(
          `${f.doc} line ${f.line}: a check:fail snippet must be immediately followed by an \`\`\`error block quoting the real message`,
        );
      }
      const quoted = next.body.trim();
      expect(quoted.length).toBeGreaterThan(0);
      const outcome = await checkSnippet(f);
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
