// [LAW:one-source-of-truth] Source text linted as files of the repo by the
// repo's own ESLint, for the tests of the rules it configures, and the zone
// table those rules read. Its configs are ESM, so each runs in a node of its
// own, once per call.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "../../scripts/lib/repo.cjs";

// Text, and the repo path it is linted as.
export interface LintCase {
  readonly file: string;
  readonly code: string;
}

export interface Message {
  readonly ruleId: string | null;
  readonly message: string;
}

// Probes at paths the project does not hold, which the typed rules cannot
// read; those rules have their own fixture (promise-lint-rule.test.ts).
export const UNTYPED = {
  overrideConfig: {
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
} as const;

const SCRIPT = `
import { ESLint } from "eslint";
const [root, options, cases] = process.argv.slice(1).map((a, i) => (i === 0 ? a : JSON.parse(a)));
const eslint = new ESLint(options);
const out = {};
for (const [name, c] of Object.entries(cases)) {
  const [result] = await eslint.lintText(c.code, { filePath: root + "/" + c.file });
  out[name] = result.messages.map(({ ruleId, message }) => ({ ruleId, message }));
}
console.log(JSON.stringify(out));
`;

// Each case's messages, from ESLint built with `options` and started in
// `cwd`, with every file placed under `root`: the checkout, or a path that
// reaches it, as an editor opened there lints it.
export function lintCases<K extends string>(
  cases: Readonly<Record<K, LintCase>>,
  options: object,
  { cwd = REPO, root = REPO }: { cwd?: string; root?: string } = {},
): Record<K, Message[]> {
  return nodeJson(
    SCRIPT,
    [root, JSON.stringify({ cwd, ...options }), JSON.stringify(cases)],
    cwd,
  ) as Record<K, Message[]>;
}

// The roots the zone table (scripts/import-zones.mjs) says run outside Jest
// beside the app, so a root added there is a case in the tests that read it.
export function outsideJestRoots(): readonly string[] {
  const url = pathToFileURL(path.join(REPO, "scripts", "import-zones.mjs"));
  const roots = nodeJson(
    `const { OUTSIDE_JEST_ROOTS } = await import(${JSON.stringify(url.href)});
console.log(JSON.stringify(OUTSIDE_JEST_ROOTS ?? null));`,
    [],
    REPO,
  );
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === "string"))
    throw new Error(
      `scripts/import-zones.mjs exports no OUTSIDE_JEST_ROOTS list of paths: ${JSON.stringify(roots)}`,
    );
  return roots;
}

// The JSON a module script prints, run in a node of its own; one that has not
// answered within the time a file's lint takes is a failure, not a hang.
const NODE_WAIT_MS = 60_000;
function nodeJson(script: string, args: readonly string[], cwd: string): unknown {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, ...args],
      { cwd, encoding: "utf8", timeout: NODE_WAIT_MS },
    ),
  );
}
