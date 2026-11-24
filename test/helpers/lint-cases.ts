// [LAW:one-source-of-truth] Source text linted as files of the repo by the
// repo's own ESLint, for the tests of the rules it configures. Its configs are
// ESM, so ESLint runs in a node of its own, once per call.

import { execFileSync } from "node:child_process";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..");

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
  { cwd = ROOT, root = ROOT }: { cwd?: string; root?: string } = {},
): Record<K, Message[]> {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        SCRIPT,
        root,
        JSON.stringify({ cwd, ...options }),
        JSON.stringify(cases),
      ],
      { cwd, encoding: "utf8" },
    ),
  );
}
