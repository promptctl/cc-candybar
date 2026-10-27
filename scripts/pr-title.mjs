#!/usr/bin/env node
// Guard: a PR's title is the subject its squash lands under on main, and
// semantic-release reads that subject to decide whether the merge publishes.
// A title commit-analyzer cannot read releases nothing and fails nothing, so
// this check refuses it before the merge instead.
//
// [LAW:one-source-of-truth] Every answer comes from commit-analyzer itself,
// run with the release config's own entry: no parser and no type list here.
// Two questions:
//   release    — what the title earns, under the real config.
//   deliberate — the same, plus a rule for each type the preset hides from
//                the changelog (docs, chore, test, ...): the types the project
//                chose not to release. A title that earns nothing here either
//                is prose, or a type no rule reads (`update:`, `feature:`).
// The merge body is not judged: it varies by merger and can only raise the
// release (a BREAKING CHANGE note), never cancel what the title earns.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeCommits } from "@semantic-release/commit-analyzer";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANALYZER = "@semantic-release/commit-analyzer";

const releaseConfig = JSON.parse(readFileSync(resolve(ROOT, ".releaserc.json"), "utf8"));
const entry = releaseConfig.plugins.find((p) => Array.isArray(p) && p[0] === ANALYZER);
if (!entry) throw new Error(`pr-title: .releaserc.json configures no ${ANALYZER} entry with options`);
const config = entry[1];

// [LAW:one-source-of-truth] The preset module is the one commit-analyzer parses
// with: named and resolved the way it names and resolves it, from its own install.
const fromAnalyzer = createRequire(fileURLToPath(import.meta.resolve(ANALYZER)));
const presetPath = fromAnalyzer.resolve(`conventional-changelog-${config.preset.toLowerCase()}`);
const preset = await import(pathToFileURL(presetPath).href);
const presetTypes = config.presetConfig?.types ?? preset.DEFAULT_COMMIT_TYPES;
if (!presetTypes) {
  throw new Error(`pr-title: preset "${config.preset}" exports no DEFAULT_COMMIT_TYPES and the config sets no presetConfig.types`);
}
const deliberateConfig = {
  ...config,
  releaseRules: [
    ...(config.releaseRules ?? []),
    ...presetTypes.filter((t) => t.hidden).map((t) => ({ type: t.type, release: "patch" })),
  ],
};

const ask = (pluginConfig, title) =>
  analyzeCommits(pluginConfig, {
    commits: [{ message: title, hash: "pr-title" }],
    logger: { log() {} },
    cwd: ROOT,
  });

async function judge(title) {
  const release = await ask(config, title);
  if (release) return { ok: true, release };
  return { ok: (await ask(deliberateConfig, title)) !== null, release: null };
}

const title = process.env.PR_TITLE ?? "";
const verdict = await judge(title);

if (verdict.release) {
  console.log(`pr-title: ok release=${verdict.release}`);
} else if (verdict.ok) {
  console.log(`pr-title: ok release=none (a type the config does not release)`);
} else {
  // The types offered are the ones this same check passes, never the preset's
  // whole list: `feature` and `revert` are in it and release nothing.
  const passing = [];
  for (const { type } of presetTypes) if ((await judge(`${type}: x`)).ok) passing.push(type);
  console.error(
    `pr-title: REFUSED ${JSON.stringify(title)}: commit-analyzer finds no release and no known type in it. ` +
      `A title is <type>(<scope>)?!?: <subject>, types: ${passing.join(", ")}`,
  );
  process.exit(1);
}
