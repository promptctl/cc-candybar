#!/usr/bin/env node
// Invoked from semantic-release's `prepareCmd` with the next version as argv[2], before the main publish.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
];

function fail(msg) {
  console.error(`release.mjs: ${msg}`);
  process.exit(1);
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail(`bad version: "${version}" (expected semver from semantic-release)`);
}

console.log(`release.mjs: preparing per-platform packages for version ${version}`);

for (const p of PLATFORMS) {
  const binPath = resolve(ROOT, "npm", `cc-candybar-${p}`, "bin", "cc-candybar");
  if (!existsSync(binPath)) {
    fail(`missing binary at ${binPath} — CI must place it before release`);
  }
}

for (const p of PLATFORMS) {
  const pkgPath = resolve(ROOT, "npm", `cc-candybar-${p}`, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  set ${pkg.name}@${version}`);
}

// Platform packages publish first so the main package's optionalDependencies
// resolve; skip ones already at this version so a rerun doesn't abort on 403.
import { execSync } from "node:child_process";
for (const p of PLATFORMS) {
  const pkgName = `@promptctl/cc-candybar-${p}`;
  let alreadyPublished = false;
  try {
    const result = execSync(`npm view ${pkgName}@${version} version 2>/dev/null`, { encoding: "utf8" }).trim();
    alreadyPublished = result === version;
  } catch { /* not published yet */ }
  if (alreadyPublished) {
    console.log(`  skipping ${pkgName}@${version} (already published)`);
    continue;
  }
  const dir = resolve(ROOT, "npm", `cc-candybar-${p}`);
  console.log(`  publishing ${dir}`);
  execFileSync("npm", ["publish", "--access", "public"], {
    cwd: dir,
    stdio: "inherit",
  });
}

// The `version` field itself is bumped by @semantic-release/npm right after this.
const rootPkgPath = resolve(ROOT, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
rootPkg.optionalDependencies = rootPkg.optionalDependencies ?? {};
for (const p of PLATFORMS) {
  rootPkg.optionalDependencies[`@promptctl/cc-candybar-${p}`] = version;
}
writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
console.log(`release.mjs: optionalDependencies pinned to ${version}`);

// [LAW:one-source-of-truth] Re-sync the lockfile here, at the single site that
// mutates the specifiers, or CI's --frozen-lockfile fails on the next branch cut.
// [LAW:no-silent-failure] A regen resolves only the subset the registry has
// propagated, silently dropping the rest (they are optional) — so retry, never ship partial.
function lockfileSpecifier(platform) {
  const lock = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
  const m = lock.match(
    new RegExp(`'@promptctl/cc-candybar-${platform}':\\s*\\n\\s*specifier: (\\S+)`),
  );
  return m?.[1];
}
const REGEN_MAX_ATTEMPTS = 12;
const REGEN_WAIT_S = 15;
let synced = false;
for (let attempt = 1; attempt <= REGEN_MAX_ATTEMPTS; attempt++) {
  console.log(`release.mjs: re-syncing pnpm-lock.yaml to ${version} (attempt ${attempt}/${REGEN_MAX_ATTEMPTS})`);
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const missing = PLATFORMS.filter((p) => lockfileSpecifier(p) !== version);
  if (missing.length === 0) {
    synced = true;
    break;
  }
  console.log(
    `release.mjs: lockfile still missing [${missing.join(", ")}] at ${version} ` +
      `(registry propagation lag); waiting ${REGEN_WAIT_S}s`,
  );
  execSync(`sleep ${REGEN_WAIT_S}`);
}
if (!synced) {
  fail(`pnpm-lock.yaml missing platform optionalDependencies at ${version} after ${REGEN_MAX_ATTEMPTS} attempts`);
}
console.log(`release.mjs: pnpm-lock.yaml re-synced to ${version} with all ${PLATFORMS.length} platforms`);
