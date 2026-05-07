#!/usr/bin/env node
// Postinstall: copy the prebuilt native render-path binary from the matching
// platform package into ./bin/cc-candybar. On any failure, write a hard-error
// stub at ./bin/cc-candybar so the user gets a clear message instead of a
// silent slow path.
//
// Distribution model mirrors esbuild/swc/biome: this main package declares
// per-platform packages as `optionalDependencies`; npm/pnpm install only the
// one matching the host's `os` + `cpu`.

import { createRequire } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BIN_DIR = join(ROOT, "bin");
const BIN_PATH = join(BIN_DIR, "cc-candybar");

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@promptctl/cc-candybar-darwin-arm64",
  "darwin-x64": "@promptctl/cc-candybar-darwin-x64",
  "linux-x64": "@promptctl/cc-candybar-linux-x64",
  "linux-arm64": "@promptctl/cc-candybar-linux-arm64",
};

function writeErrorStub(reason) {
  // Tiny shell script — no Node startup, just prints and exits non-zero.
  // Becomes the bin entry until the user reinstalls on a supported platform.
  const script = `#!/bin/sh
echo "cc-candybar: native binary not installed (${reason})." >&2
echo "Reinstall on a supported platform: darwin-arm64, darwin-x64, linux-x64, linux-arm64." >&2
exit 1
`;
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(BIN_PATH, script);
  chmodSync(BIN_PATH, 0o755);
}

function main() {
  // Source-repo guard: if we're installing inside the cc-candybar repo
  // itself (npm install on a checkout), don't touch bin/cc-candybar. Devs
  // stage the native binary there with `just install-rust`; we don't want
  // postinstall clobbering it. bin/cc-candybar is gitignored in source.
  if (existsSync(join(ROOT, "rust-client", "Cargo.toml"))) {
    return;
  }

  const key = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGES[key];

  if (!pkgName) {
    writeErrorStub(`unsupported platform ${key}`);
    process.exit(0); // do not fail the install — let the stub explain at runtime
  }

  let binSource;
  try {
    binSource = require.resolve(`${pkgName}/bin/cc-candybar`);
  } catch (err) {
    writeErrorStub(
      `optional dependency ${pkgName} not found (${err.code ?? err.message})`,
    );
    process.exit(0);
  }

  if (!existsSync(binSource)) {
    writeErrorStub(`binary missing in ${pkgName}`);
    process.exit(0);
  }

  try {
    mkdirSync(BIN_DIR, { recursive: true });
    copyFileSync(binSource, BIN_PATH);
    chmodSync(BIN_PATH, 0o755);
  } catch (err) {
    writeErrorStub(`copy failed: ${err.message}`);
    process.exit(0);
  }
}

main();
