#!/usr/bin/env node
// Guard: PROTOCOL_VERSION must agree between the TS daemon and the Rust
// client. The wire format is one source of truth (src/daemon/protocol.ts);
// the Rust binary embeds the version as a literal const because mirroring
// is cheaper than codegen for a single integer. This script asserts they
// haven't drifted. Wired into `prepublishOnly` so a forgotten bump fails
// the publish, not production.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const TS_PATH = resolve(ROOT, "src/daemon/protocol.ts");
const RS_PATH = resolve(ROOT, "rust-client/src/main.rs");

const TS_RE = /export\s+const\s+PROTOCOL_VERSION\s*=\s*(\d+)\s*;/;
const RS_RE = /const\s+PROTOCOL_VERSION\s*:\s*u32\s*=\s*(\d+)\s*;/;

function extract(path, regex, label) {
  const text = readFileSync(path, "utf8");
  const match = text.match(regex);
  if (!match) {
    console.error(`check-protocol: cannot find PROTOCOL_VERSION in ${label} (${path})`);
    process.exit(1);
  }
  return Number(match[1]);
}

const ts = extract(TS_PATH, TS_RE, "TS");
const rs = extract(RS_PATH, RS_RE, "Rust");

if (ts !== rs) {
  console.error(
    `check-protocol: PROTOCOL_VERSION mismatch — TS=${ts} (${TS_PATH}) vs Rust=${rs} (${RS_PATH}).`,
  );
  console.error("Update both in lockstep when changing the wire format.");
  process.exit(1);
}

console.log(`check-protocol: PROTOCOL_VERSION=${ts} (TS and Rust agree).`);
