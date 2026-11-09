#!/usr/bin/env node
// Publishes a release to npm. release.yml's publish job runs it for a pushed
// `v*` tag, with the tag as argv[2].
//
// The tag is the release: semantic-release commits the version and pushes the
// tag, and nothing reaches npm until that push is accepted. So every manifest
// written here lives in the CI checkout only and is never committed.
//
// Rerunning this script for a tag whose packages are already published is SAFE
// and is the recovery for a partial failure: each publish skips a version the
// registry already serves.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { awaitRegistryVisibility, registryState } from "./npm-registry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const platformPackage = (p) => `@promptctl/cc-candybar-${p}`;
const platformDir = (p) => resolve(ROOT, "npm", `cc-candybar-${p}`);

function fail(msg) {
  console.error(`publish.mjs: ${msg}`);
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// [LAW:one-source-of-truth] The version is the one semantic-release committed in
// the tagged package.json; the tag must name it, or this is not that release.
const rootPkgPath = resolve(ROOT, "package.json");
const rootPkg = readJson(rootPkgPath);
const version = rootPkg.version;
const tag = process.argv[2];
if (tag !== `v${version}`) fail(`tag ${tag} does not name package.json's version ${version}`);

// [LAW:no-silent-failure] A registry we could not ASK is not a registry that
// says no: on `unchecked` we publish and let `npm publish` arbitrate, because
// npm is the single enforcer of "this version already exists" and refuses a
// duplicate loudly.
function publish(name, dir) {
  const state = registryState(name, version);
  if (state.kind === "serves") {
    console.log(`  skipping ${name}@${version} (already published)`);
    return;
  }
  if (state.kind === "unchecked") {
    console.log(`  could not ask the registry about ${name}@${version} (${state.reason}); publishing and letting npm arbitrate`);
  }
  console.log(`  publishing ${name}@${version}`);
  execFileSync("npm", ["publish", "--access", "public"], { cwd: dir, stdio: "inherit" });
}

// 1. The platform packages, each around the binary CI staged into it.
for (const p of PLATFORMS) {
  const binPath = resolve(platformDir(p), "bin", "cc-candybar");
  if (!existsSync(binPath)) fail(`missing binary at ${binPath} — CI must stage it before publishing`);
}
for (const p of PLATFORMS) {
  const pkgPath = resolve(platformDir(p), "package.json");
  writeJson(pkgPath, { ...readJson(pkgPath), version });
  publish(platformPackage(p), platformDir(p));
}

// 2. The main package names the platform packages as optional dependencies, so
// it is published only once the registry serves all four: published sooner, an
// install in the gap silently falls back to the node shim.
const visibility = awaitRegistryVisibility(PLATFORMS.map(platformPackage), version, {
  budgetMs: 10 * 60 * 1000,
  pollMs: 10 * 1000,
  log: (m) => console.log(`publish.mjs: ${m}`),
});
if (visibility.kind === "timedOut") {
  fail(
    `the registry did not serve ${visibility.pending.length} platform package(s) at ${version} within 10 minutes: ` +
      visibility.pending.map(({ name, state }) => `${name} (${state.kind}: ${state.reason})`).join(", ") +
      `. Rerunning the publish job is safe: it skips versions the registry already serves.`,
  );
}
writeJson(rootPkgPath, {
  ...rootPkg,
  optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [platformPackage(p), version])),
});
publish(rootPkg.name, ROOT);
