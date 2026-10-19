#!/usr/bin/env node
// Prints the sourceDigest of a directory: the stamp `just install-rust` bakes
// into the native client (CC_CANDYBAR_RUST_SOURCE), so the doctor can tell
// the binary from the rust-client/src it was built from.
//
// [LAW:one-source-of-truth] Imports the one digest function the bundle's own
// stamp and the update notice use (src/source-digest.ts), run by Node's type
// stripping, so no second implementation exists to drift.
import { sourceDigest } from "../src/source-digest.ts";

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  process.stderr.write("usage: source-digest.mjs <dir>\n");
  process.exit(2);
}
process.stdout.write(`${sourceDigest(dir)}\n`);
