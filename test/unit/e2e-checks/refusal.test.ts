import { refusalOf } from "../../e2e-checks/refusal.cjs";

const ROOT = "/repo";
const held = new Set([
  ".claude/e2e-signoff.json",
  ".claude/hooks/e2e-signoff.mjs",
  "test/e2e-checks/cap-reporter.cjs",
  "test/e2e/one.test.ts",
  "src/index.ts",
]);
const mainHolds = (rel: string) => held.has(rel);
const call = (tool: string, input: Record<string, string>) => refusalOf({ tool, input, root: ROOT, mainHolds });

describe("a file tool", () => {
  test.each([
    ["the sign-off file", "/repo/.claude/e2e-signoff.json"],
    ["the hook", "/repo/.claude/hooks/e2e-signoff.mjs"],
    ["a check", "/repo/test/e2e-checks/cap-reporter.cjs"],
    ["an end-to-end test main holds", "/repo/test/e2e/one.test.ts"],
    ["a held path given relative", "test/e2e/one.test.ts"],
    ["a held path spelled with ..", "/repo/test/unit/../e2e/one.test.ts"],
  ])("refuses an edit to %s", (_name, file) => {
    expect(call("Edit", { file_path: file })).toContain("is held by origin/main and guarded");
  });

  test.each(["Write", "MultiEdit"])("refuses %s the same way", (tool) => {
    expect(call(tool, { file_path: "/repo/.claude/e2e-signoff.json" })).not.toBeNull();
  });

  test("refuses a notebook edit by notebook_path", () => {
    expect(call("NotebookEdit", { notebook_path: "/repo/test/e2e/one.test.ts" })).not.toBeNull();
  });

  test.each([
    ["a new end-to-end test main lacks", "/repo/test/e2e/two.test.ts"],
    ["a new check main lacks", "/repo/test/e2e-checks/new-check.cjs"],
    ["a source file, held or not", "/repo/src/index.ts"],
    ["a path outside the project", "/elsewhere/test/e2e/one.test.ts"],
    ["a sibling directory that shares a prefix", "/repo/test/e2e-other/one.test.ts"],
  ])("admits an edit to %s", (_name, file) => {
    expect(call("Edit", { file_path: file })).toBeNull();
  });

  test("admits a read", () => {
    expect(call("Read", { file_path: "/repo/.claude/e2e-signoff.json" })).toBeNull();
  });
});

describe("Bash", () => {
  test.each([
    "sed -i '' s/5/9/ .claude/e2e-signoff.json",
    "echo x > test/e2e/one.test.ts",
    "rm test/e2e-checks/cap-reporter.cjs",
    "pnpm test && rm test/e2e-checks/cap-reporter.cjs",
    "cat test/e2e/one.test.ts > test/e2e/one.test.ts",
  ])("refuses a write: %s", (command) => {
    expect(call("Bash", { command })).toContain("is held by origin/main and guarded");
  });

  test.each([
    "cat .claude/e2e-signoff.json",
    "grep -rn cap test/e2e-checks",
    "git diff test/e2e/one.test.ts",
    "pnpm test:e2e",
    "pnpm -s test:e2e test/e2e/one.test.ts",
    "node node_modules/jest/bin/jest.js test/e2e-checks/",
    "git add test/e2e/two.test.ts",
    "rm test/e2e/two.test.ts",
    "pnpm lint",
  ])("admits: %s", (command) => {
    expect(call("Bash", { command })).toBeNull();
  });
});

test("an error from the probe is not swallowed", () => {
  const cannotTell = () => {
    throw new Error("no origin/main");
  };
  expect(() =>
    refusalOf({ tool: "Edit", input: { file_path: "/repo/test/e2e/one.test.ts" }, root: ROOT, mainHolds: cannotTell }),
  ).toThrow("no origin/main");
});

test("an unguarded edit does not consult the probe", () => {
  const neverAsked = () => {
    throw new Error("probed");
  };
  expect(refusalOf({ tool: "Edit", input: { file_path: "/repo/src/index.ts" }, root: ROOT, mainHolds: neverAsked })).toBeNull();
});
