#!/usr/bin/env tsx
// [LAW:single-enforcer] Guard: the committed schema artifact must equal what
// `gen:schema` emits now. Regenerates in-memory and byte-diffs against the
// checked-in file. Run by the required CI Test job and by `prepublishOnly`, so a
// forgotten `gen:schema` (after a grammar change or a change to the bundled
// default's segments) fails the PR, not an editor downstream serving a stale
// contract. Mirrors `check:protocol`. The fix is always `pnpm gen:schema`, never
// editing the JSON by hand [LAW:one-source-of-truth].

import { readFileSync } from "node:fs";
import { bundledConfigSchema, SCHEMA_OUT } from "./gen-schema.js";

// [LAW:no-silent-failure] An unreadable artifact throws its own error (ENOENT,
// EACCES), never one this guard relabels.
if (readFileSync(SCHEMA_OUT, "utf8") !== bundledConfigSchema()) {
  console.error(
    `check-schema: ${SCHEMA_OUT} is stale (it differs from what \`pnpm gen:schema\` emits now).`,
  );
  console.error("Run `pnpm gen:schema` and commit the result.");
  process.exit(1);
}

console.log("check-schema: committed schema matches `pnpm gen:schema` output.");
