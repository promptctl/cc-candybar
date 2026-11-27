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
    const shared = path.join(root, "src/utils");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "calendar.ts"), "export class ZonedCalendar {}");
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
    // These run through the same optimized module and source map as a release.
    // The dependency deliberately exports other code its renderer never imports.
    const nested = path.join(pkg, "nested.js");
    const nestedEntry = 'export { draw as mainRendererOf } from "./nested.js";';
    fs.writeFileSync(nested, [
      "export function debug() { return Date.now(); }",
      "const fromInstant = seconds => new Date(seconds * 1000);",
      "export function draw(at, locale, timeZone) {",
      "  return [fromInstant(at).getUTCFullYear(), new Date(+at).getUTCDate(), new Date(\"2024-11-15T12:00:00Z\").toISOString(), Date.parse(\"2024-11-15\"), crypto.subtle.digest(\"SHA-256\", at), timeZone.getSeconds(), new Intl.Collator(locale).compare(\"A\", \"B\")];",
      "}",
    ].join("\n"));
    expect(build(nestedEntry).status).toBe(0);
    const forbidden = [
      "fromInstant(at).getFullYear()",
      "Date.now", "globalThis.Math['random']()", "new Date()", "Date()", "new Date(2024, 1, 2)",
      "process.env", "crypto.randomUUID()", "new Intl.NumberFormat()",
      'new Intl.DateTimeFormat("en-US", {}).format(at)',
      'new Intl.DateTimeFormat("en-US", {timeZone:"UTC"}).formatToParts()',
      "Date.parse('-000000-01-01')", "Date.parse('2024-02-31')",
      "new Date(at.timestamp).getTime()", "String(new Date(+at))", "`Time ${new Date(+at)}`",
      "(d => d.getFullYear())(new Date(+at))",
      "new Date(+at).getFullYear()", "new Date(at).toString()", "Date.prototype.getHours",
      "new Date(at).toLocaleString('en-US')", "new Date('2024-03-10T01:30:00')",
      "Date.parse('2024-03-10T01:30:00')", "new Date(...at)", "new Intl.Segmenter([])", "new Intl.Segmenter('en')",
      "new Intl.NumberFormat('bn-IN').format(at)",
      "new Intl.DateTimeFormat('en-US', {timeZone:'Africa/Casablanca'}).format(at)",
      "Temporal.Now.instant()", "requestAnimationFrame(at)", "'X'.toLocaleLowerCase()",
      "at.toLocaleUpperCase([])",
    ];
    fs.writeFileSync(nested, [
      "const fromInstant = seconds => new Date(seconds * 1000); export function draw(at) {",
      "  return [",
      ...forbidden.map(source => "    " + source + ","),
      "  ];",
      "}",
    ].join("\n"));
    const refused = build(nestedEntry);
    expect(refused.status).toBe(1);
    for (let index = 0; index < forbidden.length; index++)
      expect(refused.stderr).toContain(`node_modules/sample/nested.js:${index + 3}:`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
