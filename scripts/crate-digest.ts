// Prints the crateDigest of a Rust crate directory: the stamp `just
// install-rust` bakes into the native client (CC_CANDYBAR_RUST_SOURCE), so the
// doctor can tell the binary from the crate source it was built from.
//
// [LAW:one-source-of-truth] Imports the one digest function the doctor
// recomputes the stamp with (src/source-digest.ts), run by tsx like every
// other TS script here, so no second implementation exists to drift.
import { crateDigest } from "../src/source-digest";

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  process.stderr.write("usage: crate-digest.ts <crate dir>\n");
  process.exit(2);
}
process.stdout.write(`${crateDigest(dir)}\n`);
