#!/usr/bin/env tsx
// [LAW:single-enforcer] The committed schema must equal what the loader emits.

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
