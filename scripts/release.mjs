#!/usr/bin/env node
// Per-platform package publish + main-package optionalDependencies rewrite.
//
// Invoked from semantic-release's `prepareCmd` (see .releaserc.json) with
// the next release version as argv[2]. Runs AFTER version analysis and
// BEFORE `@semantic-release/npm` publishes the main package, so changes
// here are picked up by the main publish.
//
// Preconditions:
//   - npm/<platform>/bin/cc-candybar exists for every platform (CI
//     downloads matrix-build artifacts before invoking semantic-release).
//   - NODE_AUTH_TOKEN / NPM_TOKEN env var is set so `npm publish` can auth.
//
// Steps:
//   1. Verify all four platform binaries are in place.
//   2. Update each npm/<platform>/package.json with the release version.
//   3. `npm publish` each platform package (--access public).
//   4. Rewrite root package.json's optionalDependencies to the release
//      version. semantic-release/npm publishes the main package next, with
//      the rewritten manifest.

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

// 1. Verify every platform binary exists.
for (const p of PLATFORMS) {
  const binPath = resolve(ROOT, "npm", `cc-candybar-${p}`, "bin", "cc-candybar");
  if (!existsSync(binPath)) {
    fail(`missing binary at ${binPath} — CI must place it before release`);
  }
}

// 2. Bump each platform package version.
for (const p of PLATFORMS) {
  const pkgPath = resolve(ROOT, "npm", `cc-candybar-${p}`, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  set ${pkg.name}@${version}`);
}

// 3. Publish platform packages first so the main package's optionalDependencies
// resolve when users install it. Skip packages already at this version so
// reruns after a partial failure don't abort on 403.
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

// 4. Rewrite root package.json optionalDependencies to the new version. The
// version field itself is bumped by @semantic-release/npm right after this.
const rootPkgPath = resolve(ROOT, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
rootPkg.optionalDependencies = rootPkg.optionalDependencies ?? {};
for (const p of PLATFORMS) {
  rootPkg.optionalDependencies[`@promptctl/cc-candybar-${p}`] = version;
}
writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
console.log(`release.mjs: optionalDependencies pinned to ${version}`);

// 5. Regenerate pnpm-lock.yaml to match the optionalDependencies just written.
// [LAW:one-source-of-truth] The lockfile mirrors package.json's dependency
// specifiers; rewriting optionalDependencies (step 4) without re-syncing the
// lockfile leaves them disagreeing, and @semantic-release/git commits the
// manifest back to main. CI's first step is `pnpm install --frozen-lockfile`,
// which then fails ERR_PNPM_OUTDATED_LOCKFILE on every branch cut after the
// release — the drift recurs one version higher each release. Re-sync here, at
// the single site that mutates the specifiers, and commit the lockfile via
// .releaserc's git `assets`. The platform packages were published in step 3,
// so resolving them at version ${version} succeeds. --ignore-scripts: this is a
// metadata-only lockfile refresh; postinstall must not run.
console.log(`release.mjs: re-syncing pnpm-lock.yaml to ${version}`);
execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
  cwd: ROOT,
  stdio: "inherit",
});
