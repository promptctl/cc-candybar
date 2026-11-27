// [LAW:verifiable-goals] Drive the normal entry on a tiny Git checkout. The
// production inventory and parsed tsconfigs must select these fresh files.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REPO } from "../../scripts/lib/repo.cjs";

test("normal typecheck judges JavaScript in each environment, strict TS and declarations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typecheck-command-"));
  const copy = (file: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(dir, file));
  };
  const write = (file: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  };
  const check = (command = "typecheck") => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", `scripts/${command}-code.ts`],
      { cwd: dir, encoding: "utf8", timeout: 45_000 },
    );
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    return result.stderr;
  };
  try {
    for (const file of [
      "package.json",
      "tsconfig.json",
      "test/tsconfig.json",
      "tsconfig.browser.json",
      "scripts/typecheck-code.ts",
      "scripts/lint-code.ts",
      "scripts/import-zones.mjs",
      "scripts/lib/code-inventory.ts",
      "scripts/lib/type-coverage.ts",
      "scripts/lib/repo.cjs",
    ])
      copy(file);
    fs.symlinkSync(
      path.join(REPO, "node_modules"),
      path.join(dir, "node_modules"),
      "dir",
    );
    execFileSync("git", ["init", "--quiet", dir]);
    const wrong = '/** @type {number} */\nconst value = "wrong";\n';
    write(
      "scripts/owned.mjs",
      wrong + "process.pid; document.body; expect(1);",
    );
    write(
      "resources/bar-window/owned.js",
      wrong + "document.body; process.pid; expect(1);",
    );
    write(
      "test/fixture-environment.ts",
      "export {}; declare global { function releaseTestFixture(cleanup: () => Promise<void>): void; }",
    );
    write(
      "test/owned.cjs",
      wrong +
        "expect(1); process.pid; releaseTestFixture(async () => {}); document.body;",
    );
    write("src/owned.ts", "export function read(input){return input;}");
    write("src/owned.d.mts", "export type Missing = AbsentOwnedDeclaration;");
    const diagnostics = check().split("\n").filter(Boolean);
    const codes = (file: string) =>
      diagnostics
        .filter((line) => line.startsWith(file + "("))
        .map((line) => line.match(/TS\d+/)?.[0])
        .sort();
    expect(codes("scripts/owned.mjs")).toEqual(
      ["TS2304", "TS2322", "TS2584"].sort(),
    );
    expect(codes("resources/bar-window/owned.js")).toEqual(
      ["TS2304", "TS2322", "TS2591"].sort(),
    );
    expect(codes("test/owned.cjs")).toEqual(["TS2322", "TS2584"].sort());
    expect(codes("src/owned.ts")).toEqual(["TS7006"]);
    expect(codes("src/owned.d.mts")).toEqual(["TS2304"]);
    write(
      "scripts/untyped.mjs",
      "#!/usr/bin/env node\n// @TS-NOCHECK\n" + wrong,
    );
    write(
      "src/untyped.ts",
      "// @ts-check\n// @ts-nocheck\nexport const n: number = 'wrong';",
    );
    write(
      "src/still-checked.ts",
      "// @ts-nocheck\n// @ts-check\nexport const n = 1;",
    );
    write(
      "src/allowed.ts",
      [
        "// This comment mentions @ts-nocheck.",
        "export const text = '// @ts-nocheck';",
        "// @ts-expect-error: exercise a single suppressed line",
        "export const n: number = 'wrong';",
        "// @ts-nocheck",
      ].join("\n"),
    );
    for (const command of ["lint", "typecheck"]) {
      const suppressed = check(command)
        .split("\n")
        .filter((line) => line.includes("disables file-wide type checking"));
      expect(suppressed).toEqual(
        [
          "scripts/untyped.mjs (owned by scripts/)",
          "src/untyped.ts (owned by src/)",
        ].map(
          (path) =>
            path +
            " disables file-wide type checking with @ts-nocheck. Declare any source exemption in scripts/import-zones.mjs.",
        ),
      );
    }
    // TypeScript's glob skips a hidden directory even under a declared root.
    write("scripts/.hidden/entry.ts", "export {};");
    expect(check()).toContain(
      "scripts/.hidden/entry.ts (owned by scripts/) is missing from tsconfig.json",
    );
    fs.rmSync(path.join(dir, "tsconfig.browser.json"));
    expect(check()).toMatch(
      /tsconfig\.browser\.json: Cannot read file [^\n]*tsconfig\.browser\.json/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
