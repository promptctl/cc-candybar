#!/usr/bin/env node
// Copy cc-extra's attach launcher into vendor/cc-extra, verbatim, from a
// cc-extra checkout: `node scripts/vendor-cc-extra.mjs <cc-extra checkout>`.
//
// Lane B (🧪 statusline) restarts a session's Claude Code under this launcher
// (src/daemon/lane-setup.ts), so it ships inside cc-candybar: the build copies
// vendor/cc-extra to dist/cc-extra, and an install stages it beside the
// bundle. No install depends on a cc-extra checkout.
//
// [LAW:one-source-of-truth] cc-extra is where the launcher is written; this
// copy is derived from it, never edited here. A change lands in cc-extra and
// is brought over by running this script again, which records the commit it
// copied from in vendor/cc-extra/PROVENANCE.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The launcher and everything it loads: bun-attach.js's require graph, and
// statusline-push.js, which attach-registrar.js reads as source to install in
// the attached process.
export const VENDORED = [
  "attach-registrar.js",
  "boot-channel.js",
  "bun-attach.js",
  "bun-graph.js",
  "inspector-session.js",
  "launch.js",
  "seam-plan.js",
  "seams.js",
  "statusline-push.js",
  "ws-unix.js",
];

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEST = path.join(ROOT, "vendor", "cc-extra");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.argv[2];
  if (source === undefined) {
    process.stderr.write("usage: node scripts/vendor-cc-extra.mjs <cc-extra checkout>\n");
    process.exit(2);
  }
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["-C", source, "status", "--porcelain", "--", "src"], {
    encoding: "utf8",
  });
  if (dirty !== "") {
    process.stderr.write(`vendor-cc-extra: ${source}/src has uncommitted changes — commit them first, so PROVENANCE names what was copied\n`);
    process.exit(1);
  }
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DEST, "src"), { recursive: true });
  for (const file of VENDORED) {
    fs.copyFileSync(path.join(source, "src", file), path.join(DEST, "src", file));
  }
  // cc-extra is CommonJS, and this package is ESM: the nearest package.json
  // decides how node reads these files, in the checkout and under dist/cc-extra.
  fs.writeFileSync(
    path.join(DEST, "package.json"),
    `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(DEST, "PROVENANCE"),
    `cc-extra ${commit}\nCopied by scripts/vendor-cc-extra.mjs; do not edit these files here.\n`,
  );
  process.stdout.write(`vendored ${VENDORED.length} files from cc-extra ${commit}\n`);
}
