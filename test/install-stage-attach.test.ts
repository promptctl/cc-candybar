// brandon-menus-sjhy.amf — lane B restarts Claude Code under the attach
// launcher beside the bundle (src/attach-launcher.ts), so an install stages
// it with the bundle: the daemon an install starts runs the staged bundle.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStageRuntime } from "../src/install/index";
import { attachLauncherOf, attachPreloadOf, ATTACH_DIR } from "../src/attach-launcher";

describe("staging the runtime", () => {
  // Every stage names its own directory: the default is the user's real
  // stable path, which a test's env cannot move (os.homedir() reads the
  // process's HOME).
  let home: string;
  let stage: string;
  let write: typeof process.stdout.write;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "stage-attach-"));
    stage = path.join(home, "staged");
    write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = write;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // A package as it lays on disk: the bundle, the launcher and its preload
  // beside it, the node shim.
  const pkg = (launcher: string | null, preload: string | null = "// preload\n"): string => {
    const root = path.join(home, "pkg");
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "index.mjs"), "// bundle\n");
    fs.writeFileSync(path.join(root, "bin", "cc-candybar"), "#!/bin/sh\n");
    if (launcher !== null) {
      const bundle = path.join(root, "dist", "index.mjs");
      fs.mkdirSync(path.dirname(attachLauncherOf(bundle)), { recursive: true });
      fs.writeFileSync(attachLauncherOf(bundle), launcher);
    }
    if (preload !== null) {
      fs.writeFileSync(attachPreloadOf(path.join(root, "dist", "index.mjs")), preload);
    }
    return path.join(root, "dist", "index.mjs");
  };

  test("the launcher is staged beside the staged bundle, and a stale one is replaced whole", () => {
    const staged = runStageRuntime(pkg("// launcher v1\n"), stage);
    const stale = path.join(path.dirname(staged.distPath), ATTACH_DIR, "src", "gone.js");
    fs.writeFileSync(stale, "// from an older release\n");
    fs.writeFileSync(attachLauncherOf(path.join(home, "pkg", "dist", "index.mjs")), "// launcher v2\n");
    runStageRuntime(path.join(home, "pkg", "dist", "index.mjs"), stage);
    expect(staged.distPath.startsWith(stage)).toBe(true);
    expect(fs.readFileSync(attachLauncherOf(staged.distPath), "utf8")).toBe("// launcher v2\n");
    expect(fs.existsSync(stale)).toBe(false);
  });

  test("a package with no launcher is refused, naming where it looked", () => {
    expect(() => runStageRuntime(pkg(null), stage)).toThrow(
      /attach launcher was not found at .*dist\/cc-extra/,
    );
  });

  test("staging from the staged runtime itself leaves the launcher in place", () => {
    const staged = runStageRuntime(pkg("// launcher\n"), stage);
    runStageRuntime(staged.distPath, stage);
    expect(fs.readFileSync(attachLauncherOf(staged.distPath), "utf8")).toBe("// launcher\n");
  });

  test("the preload that starts Claude Code under the launcher is staged beside the staged bundle", () => {
    const staged = runStageRuntime(pkg("// launcher\n", "// preload v1\n"), stage);
    fs.writeFileSync(attachPreloadOf(path.join(home, "pkg", "dist", "index.mjs")), "// preload v2\n");
    runStageRuntime(path.join(home, "pkg", "dist", "index.mjs"), stage);
    expect(fs.readFileSync(attachPreloadOf(staged.distPath), "utf8")).toBe("// preload v2\n");
  });

  test("a package with no preload is refused, naming where it looked", () => {
    expect(() => runStageRuntime(pkg("// launcher\n", null), stage)).toThrow(
      /attach preload was not found at .*dist\/attach-preload\.cjs/,
    );
  });
});
