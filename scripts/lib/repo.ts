import fs from "node:fs";
import path from "node:path";

// The package root, which pnpm runs every tool in and Jest runs the suite in.
// Read from the working directory because no module location works in both:
// Jest compiles scripts to CommonJS, where `import.meta` does not exist, and
// tsx runs them as ESM, where `__dirname` does not.
export const REPO = process.cwd();
// [LAW:no-silent-failure] Run elsewhere, every path below the root points at
// nothing, and the first thing to say so would be an unrelated ENOENT.
if (!fs.existsSync(path.join(REPO, "rust-client", "Cargo.toml"))) {
  throw new Error(`${REPO} is not the cc-candybar package root: run the tool through pnpm from there`);
}
