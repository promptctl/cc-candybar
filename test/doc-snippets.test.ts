// [LAW:one-source-of-truth] Every annotated snippet runs through checkConfig,
// the entry `cc-candybar check` uses, so a doc and the CLI cannot disagree.
// [LAW:one-type-per-behavior] A doc is a row in DOCS: its path and its floors.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConfig, checkPlan } from "../src/check";

const ROOT = path.join(__dirname, "..");

// [LAW:parse-dont-validate] An info string is parsed ONCE, here; every test
// switches on `kind`. `other` is a real member, so the parse is total.
type Snippet =
  | { readonly kind: "pass" }
  | { readonly kind: "fail" }
  | { readonly kind: "error" }
  | { readonly kind: "stub"; readonly name: string }
  | { readonly kind: "other" };

const STUB_INFO = /^sh stub:([a-z][a-z0-9-]*)$/;

function parseInfo(info: string): Snippet {
  if (info === "json5 check:pass") return { kind: "pass" };
  if (info === "json5 check:fail") return { kind: "fail" };
  if (info === "error") return { kind: "error" };
  const stub = STUB_INFO.exec(info);
  if (stub !== null) return { kind: "stub", name: stub[1]! };
  return { kind: "other" };
}

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
  // An unclosed fence means the doc is malformed; never drop the tail silently.
  expect(open).toBeNull();
  return fences;
}

const fencesByDoc = new Map(DOCS.map((d) => [d.path, extractFences(d.path)]));
const fences = [...fencesByDoc.values()].flat();

// [LAW:one-source-of-truth][LAW:no-silent-failure] One bin directory serves
// every doc, so a duplicate name must throw before any stub is written.
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

// Pin XDG so a developer's real config cannot leak a warning into an assertion.
const SAVED_XDG = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "cc-doc-xdg-empty");
});
afterAll(() => {
  if (SAVED_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = SAVED_XDG;
});

// [LAW:effects-at-boundaries] A PATH prefix is the whole mechanism: the stubs
// reach a `shell` source through the seam it already has, with no test-only hook.
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
// Paired within each doc, so a last fence cannot borrow the next doc's first.
const failSnippets = [...fencesByDoc.values()].flatMap((docFences) =>
  docFences
    .map((f, i) => ({ f, next: docFences[i + 1] }))
    .filter(({ f }) => f.snippet.kind === "fail"),
);

describe("doc snippet contract", () => {
  // Guard the extractor: a drift that matches nothing must not pass vacuously.
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
      // [LAW:one-source-of-truth] Asserted against the surface the doc names.
      if (!plan.stderr.includes(quoted)) {
        throw new Error(
          `${f.doc} line ${next.line}: quoted error text does not match check's actual stderr.\n` +
            `quoted:\n${quoted}\n\nactual stderr:\n${plan.stderr}`,
        );
      }
    },
  );
});
