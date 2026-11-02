import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Repo } from "./workflow-daemons";

// The edge of the workflow checks: the repository and its workflows read from
// disk, handed to the pure core in workflow-daemons.ts. [LAW:effects-at-boundaries]

export const ROOT = resolve(__dirname, "../..");

// An import specifier can name a directory, which the resolver tries as a candidate.
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

export function repoOnDisk(): Repo {
  return {
    scripts: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts,
    read: (path) => (isFile(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : undefined),
  };
}

export function workflowsOnDisk(): { name: string; text: string }[] {
  const dir = join(ROOT, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}
