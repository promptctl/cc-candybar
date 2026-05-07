#!/usr/bin/env node
// Writes the bin/cc-candybar placeholder shell stub. Invoked by `prepack`
// so the published npm tarball has *something* at the bin entry; the
// user's postinstall.mjs then overwrites it with the matching native
// binary from the platform package. On unsupported platforms or failed
// postinstalls, the user runs this stub and gets a loud error.
//
// Locally, bin/cc-candybar is gitignored — devs run `just install-rust` to
// stage the real native binary there. This script is publish-time only.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BIN_PATH = join(ROOT, "bin", "cc-candybar");

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
