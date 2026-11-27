import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "../../scripts/lib/repo.cjs";
import { fixtureLauncher } from "../helpers/host";
import { jestTmpDir } from "../helpers/jest-tmp";

test.each(["npm package", "staged support directory"])(
  "the extensionless entry loads the adjacent bundle in a %s",
  (layout) => {
    const root = jestTmpDir("fixtures");
    const install = join(root, "install");
    const entry = join(install, "bin", "cc-candybar");
    try {
      mkdirSync(join(install, "bin"), { recursive: true });
      mkdirSync(join(install, "dist"));
      if (layout === "npm package")
        writeFileSync(join(install, "package.json"), '{"type":"module"}');
      copyFileSync(join(REPO, "bin", "cc-candybar"), entry);
      writeFileSync(join(install, "dist", "index.mjs"), 'console.log("bundle loaded")');
      const result = fixtureLauncher({ inherited: {} }).launchSync({
        bin: process.execPath,
        args: [entry],
        cwd: root,
        environment: {},
        category: "user-shell",
      });
      expect(result).toMatchObject({ ok: true, stdout: "bundle loaded\n" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
