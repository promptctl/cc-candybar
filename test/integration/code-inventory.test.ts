// [LAW:verifiable-goals] Ask Git about real staged deletions, ignored files
// and untracked names. Then ask the repository lint entry about a new root.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "../../scripts/lib/repo.cjs";

test("inventory checks the working tree and normal lint names an unowned source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candy-inventory-"));
  const write = (name: string, contents = "", mode = 0o644) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode });
  };
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write("gone.ts");
    execFileSync("git", ["add", "gone.ts"], { cwd: root });
    fs.unlinkSync(path.join(root, "gone.ts"));
    write(".gitignore", "ignored/\n");
    write("ignored/not-owned.ts");
    write("src/.hidden/thing [1].cts");
    write("src/renderer.ts");
    write("src/renderer/main.cjs");
    write("resources/bar-window/bridge.d.ts");
    write("scripts/bar-web/server.ts");
    write("scripts/bar-web/transport.js");
    write("bin/cc-candybar", "#!/usr/bin/env node\n", 0o755);
    write("vendor/cc-extra/independent.mjs");
    write("docs/design/probes/independent.mts");
    write("jest.unit.config.js");
    write("unrelated-shell", "#!/bin/sh\n", 0o755);
    write("env-shell", "#!/usr/bin/env bash\nprintf shell", 0o755);
    expect(
      execFileSync(path.join(root, "env-shell"), { encoding: "utf8" }),
    ).toBe("shell");

    const inventory = pathToFileURL(
      path.join(REPO, "scripts/lib/code-inventory.ts"),
    ).href;
    const tsx = require.resolve("tsx");
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          tsx,
          "--input-type=module",
          "-e",
          `import {inventory} from ${JSON.stringify(inventory)}; console.log(JSON.stringify(inventory(process.cwd())));`,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(result).toEqual(
      expect.arrayContaining([
        {
          path: "src/.hidden/thing [1].cts",
          row: "src/",
          zone: "rest",
          environment: "node",
        },
        {
          path: "src/renderer.ts",
          row: "src/",
          zone: "rest",
          environment: "node",
        },
        {
          path: "src/renderer/main.cjs",
          row: "src/renderer/",
          zone: "renderer",
          environment: "node",
        },
        {
          path: "resources/bar-window/bridge.d.ts",
          row: "resources/bar-window/",
          zone: "tools",
          environment: "browser",
        },
        {
          path: "scripts/bar-web/server.ts",
          row: "scripts/bar-web/",
          zone: "tools",
          environment: "node",
        },
        {
          path: "scripts/bar-web/transport.js",
          row: "scripts/bar-web/",
          zone: "tools",
          environment: "browser",
        },
      ]),
    );
    expect(result).toHaveLength(6);

    write("new code/feature.ts");
    write("jest.unit.config.mjs");
    write("vendor/cc-extra-next/program.js");
    write("new-code/entry", "#!/usr/bin/env -S node --no-warnings\n", 0o755);
    write(
      "new-code/env-entry",
      "#!/usr/bin/env -S NODE_ENV=test node\n",
      0o755,
    );
    fs.symlinkSync("env-entry", path.join(root, "new-code/link-entry"));
    write(
      "new-code/delegated",
      "#!/usr/bin/env -S -u NODE_OPTIONS node\nprocess.stdout.write('node');\n",
      0o755,
    );
    expect(
      execFileSync(path.join(root, "new-code/delegated"), { encoding: "utf8" }),
    ).toBe("node");
    // Typecheck resolves the checkout from its own repo.cjs. Both normal
    // commands therefore run from this fixture's copies of their entry points.
    for (const file of [
      "package.json",
      "scripts/lint-code.ts",
      "scripts/typecheck-code.ts",
      "scripts/import-zones.mjs",
      "scripts/lib/repo.cjs",
      "scripts/lib/code-inventory.ts",
      "scripts/lib/filewide-disable.ts",
      "scripts/lib/type-coverage.ts",
    ])
      write(file, fs.readFileSync(path.join(REPO, file), "utf8"));
    fs.symlinkSync(
      path.join(REPO, "node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    for (const command of ["lint-code.ts", "typecheck-code.ts"]) {
      const lint = spawnSync(
        process.execPath,
        ["--import", tsx, path.join(root, "scripts", command)],
        { cwd: root, encoding: "utf8" },
      );
      expect(lint.error).toBeUndefined();
      expect(lint.status).toBe(1);
      for (const name of [
        "scripts/import-zones.mjs",
        "new code/feature.ts",
        "new-code/entry",
        "new-code/env-entry",
        "new-code/link-entry",
        "new-code/delegated",
        "jest.unit.config.mjs",
        "vendor/cc-extra-next/program.js",
      ])
        expect(lint.stderr).toContain(name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normal lint requires a named exemption for a source with all its code disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candy-lint-directive-"));
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const check = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(REPO, "scripts/lint-code.ts"),
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  };
  try {
    for (const file of [
      "package.json",
      "eslint.config.mjs",
      "eslint.tools.config.mjs",
      "eslint.tests.config.mjs",
      "scripts/import-zones.mjs",
      "tsconfig.json",
      "tsconfig.browser.json",
      "test/tsconfig.json",
    ])
      write(file, fs.readFileSync(path.join(REPO, file), "utf8"));
    fs.symlinkSync(
      path.join(REPO, "node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    write(".gitignore", "node_modules\n");
    execFileSync("git", ["init", "-q"], { cwd: root });

    write(
      "resources/bar-window/page.js",
      'export const text = "/* eslint-disable */";\n',
    );
    write(
      "test/fixture.cjs",
      "/* eslint-disable no-undef */\nwindow.check();\n",
    );
    write(
      "scripts/line.mjs",
      "// eslint-disable-next-line no-undef\nexpect(1);\n",
    );
    write(
      "scripts/scoped.mjs",
      "/* eslint-disable */\nexpect(1);\n/* eslint-enable */\nexport const checked = 1;\n",
    );
    expect(check()).toEqual({
      status: 0,
      output: expect.not.stringContaining("File-wide eslint-disable"),
    });

    write(
      "scripts/whole.mjs",
      "/* eslint-disable -- review fixture */\nimport 'jest-mock';\n/* eslint-enable */\n",
    );
    write("test/unused.cjs", "/* eslint-disable */\nmodule.exports = {};\n");
    write(
      "scripts/effective.mjs",
      "/* eslint-disable , */\n/* eslint-enable no-console */\nimport 'jest-mock';\n",
    );
    const refused = check();
    expect(refused.status).toBe(1);
    for (const file of [
      "scripts/whole.mjs",
      "test/unused.cjs",
      "scripts/effective.mjs",
    ])
      expect(refused.output).toContain(`${file}:1: File-wide eslint-disable`);
    expect(refused.output).toContain("scripts/import-zones.mjs");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
