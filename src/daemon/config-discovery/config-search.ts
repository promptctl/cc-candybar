// [LAW:effects-at-boundaries] The config search: which of the chain's places
// hold a file on disk, whose repository each is, and what its answers let
// load. It is the host's, beside the discovery it feeds, because it stats and
// resolves real paths; the places it searches are pure path math, shared, so
// the renderer reads the same chain without opening a file.

import fs from "node:fs";
import path from "node:path";
import { presence, type Unchecked } from "../../utils/presence.js";
import { listFolders, REPO_PLUGIN_DIR } from "./plugin-folders.js";
import { worktreeLink } from "../../utils/git-root.js";
import type { RepoQuestion } from "../../config/config-snapshot.js";
import {
  gateRepos,
  repoQuestion,
  type RepoAnswers,
  type RepoDir,
  type RepoProject,
} from "../../config/loader/repo-gate.js";
import type { LayerRole } from "../../config/layer-role.js";
import {
  configCandidates,
  dslConfigCandidatePaths,
  userHome,
  type ConfigLayer,
  type ConfigQuery,
  type ConfigResolution,
  type Locations,
} from "../../config/loader/chain-places.js";

/**
 * The search, over the locations of `dslConfigCandidatePaths`:
 *   1. `configFile` — the session's explicit path (`--config` > `configEnv`
 *      hint, absolute, from its render origin); the sole candidate when
 *      present
 *   2. `<projectDir>/.cc-candybar.local.json5`, then `.json`
 *   3. `<projectDir>/.cc-candybar.json5`, then `.json`
 *   4. `$XDG_CONFIG_HOME/cc-candybar/config.json5`, then `.json`
 *      (defaulting to `~/.config/cc-candybar/`)
 * Each LOCATION contributes its first existing file (`.json5` wins a tie;
 * the sibling is the collision notice), and the chain is those files in
 * reverse — the user's at the bottom, the local file on top. The local file
 * loads under its project's approval, since it is in the same directory and
 * a clone can commit a file by that name.
 *
 * [LAW:dataflow-not-control-flow] The locations array is data; the search is
 * one fold over `presence`. Adding a layer is a new array entry, not a new
 * branch.
 *
 * [LAW:single-enforcer] Built on top of `dslConfigCandidatePaths` — the
 * precedence list lives in one place. And the one place a repository's
 * answer decides whether its files load (`gateRepos`, whose `approved` the
 * layers are filtered by): the render, `check` and the durable writer all
 * resolve here.
 *
 * It answers the one repository question its directories ask, too.
 * [LAW:one-source-of-truth] The question is ruled from the same directories
 * and answers the gate is, in the same pass, so the two cannot disagree.
 */
export function searchConfig(
  locs: Locations,
  answers: RepoAnswers,
  query: ConfigQuery,
): {
  readonly resolution: ConfigResolution;
  readonly question: RepoQuestion | null;
} {
  const { projectDir, configFile } = query;
  const unchecked: Unchecked[] = [];
  // Each location's file, its role, and the repository directory that
  // supplies it — null for the user's own file or the explicit one.
  const atLocation = new Map<
    string,
    {
      readonly file: string;
      readonly role: LayerRole;
      readonly repo: RepoDir | null;
    }
  >();
  for (const { file: candidate, role } of configCandidates(locs, query)) {
    const p = presence(candidate);
    if (p === "absent") continue;
    if (p !== "present") {
      unchecked.push(p);
      continue;
    }
    // A location is a directory AND a base name: `.cc-candybar` and the XDG
    // `config` may share a directory and are two layers; `.json5`/`.json`
    // at one location are one, the first enumerated winning.
    // [LAW:one-source-of-truth] The on-disk spelling: on a case-insensitive
    // volume one directory reached as `Code` and `code` is one answer's key.
    const dir = realDirOf(path.dirname(candidate));
    if (typeof dir !== "string") {
      unchecked.push({ path: candidate, error: dir.error });
      continue;
    }
    const location = path.join(
      dir,
      path.basename(candidate).replace(/\.(json5|json)$/, ""),
    );
    if (!atLocation.has(location)) {
      atLocation.set(location, {
        file: candidate,
        role,
        repo: role === "user" ? null : { dir, link: worktreeLink(dir) },
      });
    }
  }
  const found = [...atLocation.values()];
  // The project's file and its local one share a directory, and so an answer.
  const repoDirs = new Map(
    found.flatMap((f) => (f.repo === null ? [] : [[f.repo.dir, f.repo]])),
  );
  const unseen: Unchecked[] = [];
  const project = repoProject(projectDir, unseen);
  const dirs = [...repoDirs.values()];
  const repos = gateRepos(answers, dirs, project);
  const question = repoQuestion(answers, dirs, project);
  const kept = found
    .filter((f) => f.repo === null || repos.approved.includes(f.repo.dir))
    .reverse();
  const layers = kept.map((f): ConfigLayer => ({ path: f.file, role: f.role }));
  const resolved = (resolution: ConfigResolution) => ({ resolution, question });
  if (configFile === undefined) {
    return resolved({
      kind: "chain",
      layers,
      home: userHome(locs, layers),
      unchecked: [...unchecked, ...unseen],
      repos,
    });
  }
  // An explicit path is the sole candidate: its one probe is the verdict.
  const [own] = unchecked;
  const home = configFile;
  if (layers.length > 0) {
    return resolved({
      kind: "chain",
      layers,
      home,
      unchecked: [...unchecked, ...unseen],
      repos,
    });
  }
  return resolved(
    own === undefined
      ? { kind: "missing", path: configFile, home, repos }
      : { kind: "unreadable", ...own, home, repos },
  );
}

// [LAW:no-silent-failure] A directory's real path, or why it could not be
// had: a directory removed between its stat and this call is a location the
// search could not check, never a throw out of discovery.
function realDirOf(dir: string): string | Unchecked {
  try {
    return fs.realpathSync.native(dir);
  } catch (e) {
    return { path: dir, error: (e as Error).message };
  }
}

// The session's project, or null for none, or one that is not there. One
// whose real path could not be had is none, and goes to `unseen`, so the
// search's notice names it.
export function repoProject(
  projectDir: string | undefined,
  unseen: Unchecked[] = [],
): RepoProject | null {
  if (projectDir === undefined || presence(projectDir) !== "present") {
    return null;
  }
  const listed = listFolders(path.join(projectDir, REPO_PLUGIN_DIR));
  const dir = realDirOf(projectDir);
  if (typeof dir !== "string") {
    unseen.push(dir);
    return null;
  }
  return {
    dir,
    link: worktreeLink(dir),
    path: projectDir,
    ships: !("error" in listed) && listed.folders.length > 0,
  };
}

/**
 * Detect same-location extension collisions: any location where BOTH
 * `<base>.json5` and `<base>.json` exist simultaneously. The resolver picks
 * .json5 (documented format wins), but the user almost certainly didn't
 * intend to keep two; the duplicate is dead weight that will drift.
 *
 * Returns a human-readable warning naming the conflicting files, or null if
 * no collisions exist. The render path surfaces this through the daemon's
 * diagnostics channel so the user sees it on every render until they remove
 * the duplicate.
 *
 * [LAW:single-enforcer] Consumes `dslConfigCandidatePaths` — same enumerator
 * as the resolver and watcher; collision detection cannot disagree with
 * resolution about which files are candidates.
 *
 * [LAW:dataflow-not-control-flow] Walk candidates, group by parent directory
 * + base name (without extension), find groups with size > 1 whose members
 * all exist. No special-case branches per extension.
 */
export function detectConfigCollisions(
  locs: Locations,
  projectDir?: string,
): string | null {
  const existing = dslConfigCandidatePaths(locs, { projectDir }).filter(
    (candidate) => presence(candidate) === "present",
  );
  // Group by (dir + base-without-extension). A group with > 1 existing
  // member is a collision at that logical location.
  const groups = new Map<string, string[]>();
  for (const candidate of existing) {
    const dir = path.dirname(candidate);
    const base = path.basename(candidate).replace(/\.(json5|json)$/, "");
    const key = path.join(dir, base);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(candidate);
  }
  const collisions = [...groups.values()].filter((g) => g.length > 1);
  if (collisions.length === 0) return null;
  // Stable, parseable message. The first file in each group is the .json5
  // (the one that wins); the rest are the shadowed siblings.
  const lines = collisions.map((g) => {
    const [winner, ...shadowed] = g;
    return `${winner} shadows ${shadowed.join(", ")}`;
  });
  return `config-extension collision: ${lines.join("; ")} — remove the duplicate`;
}
