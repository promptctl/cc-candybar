// [LAW:effects-at-boundaries] The host observes each location's candidates
// once. Both the writable chain and the diagnostics use that observation.

import path from "node:path";
import type { Unchecked } from "../../utils/presence.js";
import { REPO_PLUGIN_DIR } from "./plugin-folders.js";
import type { RepoQuestion } from "../../config/config-snapshot.js";
import {
  gateRepos,
  repoQuestion,
  type RepoAnswers,
  type RepoDir,
  type RepoProject,
} from "../../config/loader/repo-gate.js";
import {
  configLocations,
  userHome,
  type ConfigCandidate,
  type ConfigLayer,
  type ConfigLocation,
  type ConfigQuery,
  type ConfigResolution,
  type Locations,
} from "../../config/loader/chain-places.js";
import { discoveryFiles, type DiscoveryFiles } from "./discovery-files.js";

type ObservedLocation = ConfigLocation & {
  readonly unchecked: readonly Unchecked[];
} & (
    | { readonly kind: "no-winner" }
    | {
        readonly kind: "found";
        readonly winner: ConfigCandidate;
        readonly shadowed: readonly ConfigCandidate[];
        readonly directory: string;
      }
  );

export function observeConfigLocations(
  locations: readonly ConfigLocation[],
  files: Pick<DiscoveryFiles, "presence" | "realpath">,
): readonly ObservedLocation[] {
  return locations.map((location) => {
    const present: Array<{ candidate: ConfigCandidate; directory: string }> =
      [];
    const unchecked: Unchecked[] = [];
    for (const candidate of location.candidates) {
      const observed = files.presence(candidate.file);
      if (observed === "absent") continue;
      if (observed !== "present") {
        unchecked.push(observed);
        continue;
      }
      const dir = files.realpath(path.dirname(candidate.file));
      if (typeof dir !== "string") {
        unchecked.push({ path: candidate.file, error: dir.error });
        continue;
      }
      present.push({ candidate, directory: dir });
    }
    const [winner, ...shadowed] = present;
    return winner === undefined
      ? { ...location, kind: "no-winner", unchecked }
      : {
          ...location,
          kind: "found",
          unchecked,
          winner: winner.candidate,
          shadowed: shadowed.map(({ candidate }) => candidate),
          directory: winner.directory,
        };
  });
}

export function searchConfig(
  locs: Locations,
  answers: RepoAnswers,
  query: ConfigQuery,
  files = discoveryFiles(),
): {
  readonly resolution: ConfigResolution;
  readonly question: RepoQuestion | null;
  readonly locations: readonly ObservedLocation[];
} {
  const { projectDir, configFile } = query;
  const locations = observeConfigLocations(configLocations(locs, query), files);
  const found = locations.flatMap((location) =>
    location.kind === "found" ? [location] : [],
  );
  const repoDirs = new Map<string, RepoDir>();
  for (const { role, directory } of found) {
    if (role === "user" || repoDirs.has(directory)) continue;
    repoDirs.set(directory, {
      dir: directory,
      link: files.worktree(directory),
    });
  }
  const dirs = [...repoDirs.values()];
  const seen = repoProject(projectDir, files);
  const repos = gateRepos(answers, dirs, seen.project);
  const question = repoQuestion(answers, dirs, seen.project);
  const layers: ConfigLayer[] = found
    .filter(
      ({ role, directory }) =>
        role === "user" || repos.approved.includes(directory),
    )
    .reverse()
    .map(({ role, winner }) => ({ role, path: winner.file }));
  const projectUnchecked = seen.unchecked === null ? [] : [seen.unchecked];
  const unchecked = locations.flatMap((location) => location.unchecked);
  const [failure] = unchecked;
  const resolution: ConfigResolution =
    configFile === undefined || layers.length > 0
      ? {
          kind: "chain",
          layers,
          home: configFile ?? userHome(locs, layers),
          unchecked: [...unchecked, ...projectUnchecked],
          repos,
        }
      : failure === undefined
        ? {
            kind: "missing",
            path: configFile,
            home: configFile,
            unchecked: projectUnchecked,
            repos,
          }
        : {
            kind: "unreadable",
            ...failure,
            home: configFile,
            unchecked: projectUnchecked,
            repos,
          };
  return { resolution, question, locations };
}

// [LAW:no-silent-failure] The failure to inspect a project is independent of
// the configuration path the session named.
type ProjectObservation =
  | { readonly project: RepoProject; readonly unchecked: null }
  | { readonly project: null; readonly unchecked: Unchecked | null };

export function repoProject(
  projectDir: string | undefined,
  files = discoveryFiles(),
): ProjectObservation {
  if (projectDir === undefined) return { project: null, unchecked: null };
  const present = files.presence(projectDir);
  if (present !== "present")
    return { project: null, unchecked: present === "absent" ? null : present };
  const dir = files.realpath(projectDir);
  if (typeof dir !== "string") return { project: null, unchecked: dir };
  // The same authored root `sessionPlugins` lists once the gate approves it.
  const listed = files.folders(path.join(projectDir, REPO_PLUGIN_DIR));
  return {
    project: {
      dir,
      link: files.worktree(dir),
      path: projectDir,
      ships: !("error" in listed) && listed.folders.length > 0,
    },
    unchecked: null,
  };
}

// [LAW:single-enforcer] The winner named here is the winner the same
// observation supplied to the chain, including when more suffixes are added.
export function configCollisionNotice(
  locations: readonly ObservedLocation[],
): string | null {
  const collisions = locations.flatMap((location) =>
    location.kind === "found" && location.shadowed.length > 0
      ? [
          `${location.winner.file} shadows ${location.shadowed.map(({ file }) => file).join(", ")}`,
        ]
      : [],
  );
  return collisions.length === 0
    ? null
    : `config-extension collision: ${collisions.join("; ")} — remove the duplicate`;
}
