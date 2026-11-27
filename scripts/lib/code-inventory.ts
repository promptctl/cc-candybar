// [LAW:single-enforcer] Git identifies the repository's working sources. The
// ownership table decides who checks each one, including new, unstaged files.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { coverageOf, environmentOf, isCodeFile } from "../import-zones.mjs";

export interface OwnedSource {
  readonly path: string;
  readonly row: string;
  readonly zone: string;
  readonly environment: "node" | "jest" | "browser";
}

function nodeEntry(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    // A kernel shebang must fit in its first block. Read no program body.
    const buffer = Buffer.alloc(512);
    const count = fs.readSync(fd, buffer);
    const firstLine = buffer.toString("utf8", 0, count).split("\n", 1)[0]!;
    return /^#!\s*(?:\S*\/)?(?:node(?:js)?(?:\s|$)|env\s+(?:-S\s+)?(?:\S*\/)?node(?:js)?(?:\s|$))/.test(firstLine);
  } finally {
    fs.closeSync(fd);
  }
}

export function inventory(root: string): readonly OwnedSource[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const owned: OwnedSource[] = [];
  const missing: string[] = [];
  for (const file of new Set(output.split("\0").filter(Boolean))) {
    const absolute = path.join(root, file);
    const entry = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!entry || entry.isDirectory()) continue; // An unstaged deletion or submodule.
    if (!isCodeFile(file)) {
      if (path.extname(file) || !entry.isFile() || !(entry.mode & 0o111) || !nodeEntry(absolute))
        continue;
    }
    const declaration = coverageOf(file);
    if (!declaration) {
      missing.push(file);
    } else if ("zone" in declaration) {
      const { row, zone } = declaration;
      owned.push({ path: file, row, zone, environment: environmentOf(file, zone) });
    }
  }
  if (missing.length) {
    throw new Error(`Missing source ownership in scripts/import-zones.mjs:\n${missing.sort().join("\n")}`);
  }
  return owned;
}
