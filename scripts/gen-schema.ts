#!/usr/bin/env tsx
// [LAW:one-source-of-truth] Derived from the loader schemas by `pnpm gen:schema`.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeConfigSchema } from "../src/config/loader/emit-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_OUT = resolve(
  __dirname,
  "..",
  "schema",
  "cc-candybar.schema.json",
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SCHEMA_OUT, serializeConfigSchema());
  console.log(`gen-schema: wrote ${SCHEMA_OUT}`);
}
