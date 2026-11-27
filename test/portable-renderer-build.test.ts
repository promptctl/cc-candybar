import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("the portable build rejects static and computed dependencies inside a package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-imports-"));
  try {
    const src = path.join(root, "src/renderer");
    const pkg = path.join(root, "node_modules/sample");
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(src, "main.ts"), 'export { mainRendererOf } from "sample";');
    fs.writeFileSync(path.join(pkg, "package.json"), '{"type":"module","main":"index.js"}');
    const builder = pathToFileURL(path.resolve("scripts/lib/portable-renderer.ts")).href;
    const build = (body: string) => {
      fs.writeFileSync(path.join(pkg, "index.js"), body);
      return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        `import { bundleRenderer } from ${JSON.stringify(builder)}; await bundleRenderer(process.argv[1]);`, root],
        { encoding: "utf8" });
    };
    expect(build("export const mainRendererOf = () => 1;").status).toBe(0);
    const entry = path.join(src, "main.ts");
    const pkgExport = fs.readFileSync(entry, "utf8");
    fs.writeFileSync(entry, 'import type { Stats } from "node:fs";\n' + pkgExport);
    expect(build("export const mainRendererOf = () => 1;").status).toBe(0);
    fs.writeFileSync(entry, 'import { readFileSync } from "node:fs";\n' + pkgExport);
    expect(build("export const mainRendererOf = () => 1;").stderr).toContain("Portable renderer imports node:fs");
    fs.writeFileSync(entry, pkgExport);
    for (const [body, reason] of [
      ['import "node:fs"; export const mainRendererOf = () => 1;', "Portable renderer imports node:fs"],
      ['export const mainRendererOf = () => import("fs/promises");', "Portable renderer imports fs/promises"],
      ["export const mainRendererOf = name => import(name);", "unsupported-dynamic-import"],
    ]) {
      const result = build(body!);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(reason);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
