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
    const lint = spawnSync(
      process.execPath,
      ["--import", tsx, path.join(REPO, "scripts/lint-code.ts")],
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
      "jest.unit.config.mjs",
      "vendor/cc-extra-next/program.js",
    ])
      expect(lint.stderr).toContain(name);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
