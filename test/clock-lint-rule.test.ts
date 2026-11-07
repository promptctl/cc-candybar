// [LAW:single-enforcer] The real clock, the timer globals and the loop's turn
// are src/time.ts's alone. eslint.config.mjs builds each rule as a function of
// the file because a later block replaces a rule rather than adding to it, so
// the cases run the repo's own config over source text placed at a path in each
// block, and every banned form must fail in every one.

import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

// ESM config, so ESLint runs in a node of its own, once for all cases.
const SCRIPT = `
import { ESLint } from "eslint";
const [root, casesJson] = process.argv.slice(1);
const eslint = new ESLint({ cwd: root });
const out = {};
for (const [name, c] of Object.entries(JSON.parse(casesJson))) {
  const [result] = await eslint.lintText(c.code, { filePath: root + "/" + c.file });
  out[name] = result.messages
    .filter((m) => m.message.includes("src/time.ts"))
    .map((m) => m.ruleId);
}
console.log(JSON.stringify(out));
`;

// A path in each block of the config that sets one of the clock's rules.
const PATHS = {
  plain: "src/utils/probe.ts",
  daemon: "src/daemon/probe.ts",
  createDaemon: "src/daemon/daemon.ts",
  daemonServer: "src/daemon/server.ts",
  segments: "src/segments/probe.ts",
  variables: "src/var-system/probe.ts",
  proc: "src/proc/probe.ts",
  host: "src/host.ts",
} as const;

// Each banned form, and the rule that carries it.
const FORMS = {
  "Date.now": {
    code: "export const x = Date.now();\n",
    rule: "no-restricted-properties",
  },
  "performance.now": {
    code: "export const x = performance.now();\n",
    rule: "no-restricted-properties",
  },
  "process.hrtime.bigint": {
    code: "export const x = process.hrtime.bigint();\n",
    rule: "no-restricted-properties",
  },
  "process.uptime": {
    code: "export const x = process.uptime();\n",
    rule: "no-restricted-properties",
  },
  "os.uptime": {
    code: 'import os from "node:os";\nexport const x = os.uptime();\n',
    rule: "no-restricted-properties",
  },
  "AbortSignal.timeout": {
    code: "export const x = AbortSignal.timeout(1);\n",
    rule: "no-restricted-properties",
  },
  "new Date()": {
    code: "export const x = new Date();\n",
    rule: "no-restricted-syntax",
  },
  "new Date(undefined)": {
    code: "export const x = new Date(undefined);\n",
    rule: "no-restricted-syntax",
  },
  "Date()": {
    code: "export const x = Date();\n",
    rule: "no-restricted-syntax",
  },
  setTimeout: {
    code: "export const x = setTimeout(() => 1, 1);\n",
    rule: "no-restricted-globals",
  },
  clearInterval: {
    code: "export const x = () => clearInterval(undefined);\n",
    rule: "no-restricted-globals",
  },
  setImmediate: {
    code: "export const x = setImmediate(() => 1);\n",
    rule: "no-restricted-globals",
  },
  "node:timers": {
    code: 'import { setImmediate } from "node:timers";\nexport { setImmediate };\n',
    rule: "no-restricted-imports",
  },
  "node:perf_hooks": {
    code: 'import { performance } from "node:perf_hooks";\nexport { performance };\n',
    rule: "no-restricted-imports",
  },
  "timers/promises": {
    code: 'import { setTimeout } from "timers/promises";\nexport { setTimeout };\n',
    rule: "no-restricted-imports",
  },
} as const;

const CASES: Record<string, { file: string; code: string }> = {};
for (const [place, file] of Object.entries(PATHS)) {
  for (const [form, { code }] of Object.entries(FORMS)) {
    CASES[`${place} / ${form}`] = { file, code };
  }
}
// What it forbids everywhere else, the clock's own file does.
for (const [form, { code }] of Object.entries(FORMS)) {
  CASES[`the clock / ${form}`] = { file: "src/time.ts", code };
}
// A date given an argument is a value, not a reading.
CASES["plain / new Date(ms)"] = {
  file: PATHS.plain,
  code: "export const x = new Date(0);\n",
};

describe("the clock rules", () => {
  let found: Record<string, string[]>;

  beforeAll(() => {
    found = JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", SCRIPT, ROOT, JSON.stringify(CASES)],
        { cwd: ROOT, encoding: "utf8" },
      ),
    );
  }, 120_000);

  test.each(
    Object.entries(PATHS).flatMap(([place]) =>
      Object.entries(FORMS).map(([form, { rule }]) => [place, form, rule]),
    ),
  )("%s: %s fails lint", (place, form, rule) => {
    expect(found[`${place} / ${form}`]).toEqual([rule]);
  });

  test.each(Object.keys(FORMS))("the clock's own file may use %s", (form) => {
    expect(found[`the clock / ${form}`]).toEqual([]);
  });

  test("a date built from a value passes", () => {
    expect(found["plain / new Date(ms)"]).toEqual([]);
  });
});
