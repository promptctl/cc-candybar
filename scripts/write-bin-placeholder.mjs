#!/usr/bin/env node
// Writes the bin/cc-candybar placeholder shell stub. Invoked by `prepack`
// so the published npm tarball has *something* at the bin entry; the
// user's postinstall.mjs then overwrites it with the matching native
// binary from the platform package. On unsupported platforms or failed
// postinstalls, the user runs this stub and gets a loud error.
//
// Locally, bin/cc-candybar is gitignored — devs run `just install-rust` to
// stage the real native binary there. This script is publish-time only.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BIN_PATH = join(ROOT, "bin", "cc-candybar");

// Never clobber an existing bin/cc-candybar. In a source checkout the dev's
// real native binary lives here (placed by `just install-rust`) and must
// survive a local `pnpm prepack`. In CI/publish the path is absent — it is
// gitignored, so a fresh checkout never has it and nothing stages the root
// bin before prepack — so the placeholder IS still written and the published
// tarball gets its stub. [LAW:no-silent-failure] guarding on
// rust-client/Cargo.toml (as postinstall.mjs does) would be wrong here: CI
// checks out full source too, so that guard would skip during release and
// ship a main package whose `bin` target is missing.
if (existsSync(BIN_PATH)) {
  console.log(`write-bin-placeholder: ${BIN_PATH} already present, leaving it untouched.`);
  process.exit(0);
}

const SCRIPT = `#!/bin/sh
echo "cc-candybar: native binary not installed." >&2
echo "Postinstall did not stage a platform binary. Reinstall on darwin-arm64," >&2
echo "darwin-x64, linux-x64, or linux-arm64; or open an issue at" >&2
echo "https://github.com/promptctl/cc-candybar/issues." >&2
exit 1
`;

mkdirSync(dirname(BIN_PATH), { recursive: true });
writeFileSync(BIN_PATH, SCRIPT);
chmodSync(BIN_PATH, 0o755);
console.log(`wrote placeholder to ${BIN_PATH}`);
