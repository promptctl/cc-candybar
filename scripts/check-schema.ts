#!/usr/bin/env tsx
// [LAW:single-enforcer] Guard: the committed schema artifact must equal what the
// config loader schemas currently emit. Regenerates in-memory and byte-diffs
// against the checked-in file. Wired into `prepublishOnly` so a forgotten
// `gen:schema` (after a grammar change) fails the publish, not an editor
// downstream serving a stale contract. Mirrors `check:protocol`. The fix is
// always `pnpm gen:schema`, never editing the JSON by hand [LAW:one-source-of-truth].

import { readFileSync } from "node:fs";
import { serializeConfigSchema } from "../src/config/loader/emit-schema.js";
import { SCHEMA_OUT } from "./gen-schema.js";

const expected = serializeConfigSchema();

let actual: string;
try {
  actual = readFileSync(SCHEMA_OUT, "utf8");
} catch {
  console.error(
    `check-schema: ${SCHEMA_OUT} is missing. Run \`pnpm gen:schema\`.`,
  );
  process.exit(1);
}

if (actual !== expected) {
  console.error(
    `check-schema: ${SCHEMA_OUT} is stale (does not match the loader schemas).`,
  );
  console.error("Run `pnpm gen:schema` and commit the result.");
  process.exit(1);
}

console.log("check-schema: committed schema matches the loader schemas.");
