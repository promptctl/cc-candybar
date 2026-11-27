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
  const check = () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/typecheck-code.ts"],
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
    write("test/owned.cjs", wrong + "expect(1); process.pid; document.body;");
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
