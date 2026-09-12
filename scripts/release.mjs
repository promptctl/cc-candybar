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
//   5. Wait for the registry to serve those four versions, then re-sync
//      pnpm-lock.yaml to the rewritten specifiers — .releaserc commits both
//      files, and CI's `pnpm install --frozen-lockfile` fails on every later
//      branch if they disagree.
//
// Rerunning this script for a version whose platform packages are already
// published is SAFE and is the documented recovery for a release that failed
// after step 3: step 3 skips what the registry already serves, and every later
// step is a rewrite of the same two files to the same values.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { awaitRegistryVisibility, registryState } from "./npm-registry.mjs";

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
//
// [LAW:no-silent-failure] A registry we could not ASK is not a registry that
// says no: on `unchecked` we publish and let `npm publish` arbitrate, because
// npm is the single enforcer of "this version already exists" and refuses a
// duplicate loudly. What must never happen is treating an outage as "absent"
// silently and reporting a release that published nothing.
const platformPackages = PLATFORMS.map((p) => `@promptctl/cc-candybar-${p}`);
for (const p of PLATFORMS) {
  const pkgName = `@promptctl/cc-candybar-${p}`;
  const state = registryState(pkgName, version);
  if (state.kind === "serves") {
    console.log(`  skipping ${pkgName}@${version} (already published)`);
    continue;
  }
  if (state.kind === "unchecked") {
    console.log(
      `  could not ask the registry about ${pkgName}@${version} (${state.reason}); publishing and letting npm arbitrate`,
    );
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
// release. Re-sync here, at the single site that mutates the specifiers, and
// commit the lockfile via .releaserc's git `assets`. package.json's
// pnpm.supportedArchitectures makes the regen lock all four os/cpu variants
// regardless of this runner's platform. --ignore-scripts: metadata-only
// refresh; postinstall must not run.
//
// [LAW:no-silent-failure] The four platform packages were published in step 3,
// but npm registry propagation is NOT instant. A regen run immediately resolves
// only the subset already live and SILENTLY DROPS the rest (they are optional),
// shipping a lockfile missing architectures — which is exactly the recurring
// breakage. So the regen is verified against the lockfile and the release FAILS
// (never shipping a partial lockfile) if an architecture is missing.
//
// The waiting happens BEFORE that, against the registry itself
// (brandon-release-j08): a regen loop cannot afford patience, because every unit
// of it costs a full resolve, and a 3-minute ceiling built that way aborted two
// consecutive releases after their platform packages were already public. The
// fact the regen needs — "the registry serves all four" — is four cheap reads,
// so it is waited for directly and generously, and only then is the lockfile
// resolved. The small retry that remains covers pnpm's own metadata cache, which
// is a different clock from npm's and the only one a regen can observe.
function lockfileSpecifier(platform) {
  const lock = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
  const m = lock.match(
    new RegExp(`'@promptctl/cc-candybar-${platform}':\\s*\\n\\s*specifier: (\\S+)`),
  );
  return m?.[1];
}
const VISIBILITY_BUDGET_MS = 10 * 60 * 1000;
const VISIBILITY_POLL_MS = 10 * 1000;
const visibility = awaitRegistryVisibility(platformPackages, version, {
  budgetMs: VISIBILITY_BUDGET_MS,
  pollMs: VISIBILITY_POLL_MS,
  log: (m) => console.log(`release.mjs: ${m}`),
});
if (visibility.kind === "timedOut") {
  fail(
    `the registry did not serve ${visibility.pending.length} platform package(s) at ${version} ` +
      `within ${VISIBILITY_BUDGET_MS / 60000} minutes: ` +
      visibility.pending
        .map(({ name, state }) => `${name} (${state.kind}: ${state.reason})`)
        .join(", ") +
      `. They were published in step 3, so this is propagation lag or an npm ` +
      `outage — never a missing publish. Rerunning this job is safe: step 3 ` +
      `skips versions the registry already serves.`,
  );
}
console.log(`release.mjs: the registry serves all ${PLATFORMS.length} platform packages at ${version}`);

const REGEN_MAX_ATTEMPTS = 4;
const REGEN_WAIT_S = 20;
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
  fail(
    `pnpm-lock.yaml still missing platform optionalDependencies at ${version} after ` +
      `${REGEN_MAX_ATTEMPTS} regen attempts, THOUGH the registry serves all ${PLATFORMS.length} ` +
      `— so this is pnpm's cached metadata, not npm propagation`,
  );
}
console.log(`release.mjs: pnpm-lock.yaml re-synced to ${version} with all ${PLATFORMS.length} platforms`);
