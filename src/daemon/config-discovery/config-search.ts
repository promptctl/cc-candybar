// [LAW:effects-at-boundaries] The host observes each location's candidates
// once. Both the writable chain and the diagnostics use that observation.

import path from "node:path";
import type { Unchecked } from "../../utils/presence.js";
import {
  listedRepoRoot,
  repoPluginDir,
  type RootListing,
} from "./plugin-folders.js";
import {
  projectAccess,
  NO_PROJECT_ACCESS,
  type RepoConfigBook,
  type RepoProject,
} from "../../config/loader/repo-gate.js";
import {
  admitsLayer,
  configLocations,
  userConfigDefault,
  type ConfigCandidate,
  type ConfigLayer,
  type ConfigLocation,
  type ConfigQuery,
  type ConfigResolution,
  type Locations,
} from "../../config/loader/chain-places.js";
import { discoveryFiles, type DiscoveryFiles } from "./discovery-files.js";
import type { StateObservation } from "../state-file.js";

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
  selectedBase: string | null = null,
): readonly ObservedLocation[] {
  return locations.map((location) => {
    const present: Array<{ candidate: ConfigCandidate; directory: string }> =
      [];
    const unchecked: Unchecked[] = [];
    const candidates: ConfigCandidate[] = [];
    for (const candidate of location.candidates) {
      const observed = files.presence(candidate.file);
      if (
        observed === "present" &&
        location.role !== "user" &&
        selectedBase !== null &&
        files.realpath(candidate.file) === selectedBase
      )
        continue;
      candidates.push(candidate);
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
    const scope = { role: location.role, candidates, unchecked };
    return winner === undefined
      ? { ...scope, kind: "no-winner" }
      : {
          ...scope,
          kind: "found",
          winner: winner.candidate,
          shadowed: shadowed.map(({ candidate }) => candidate),
          directory: winner.directory,
        };
  });
}

export function searchConfig(
  locs: Locations,
  readAnswers: () => StateObservation<RepoConfigBook>,
  query: ConfigQuery,
  files = discoveryFiles(),
): {
  readonly resolution: ConfigResolution;
  readonly repoRoot: RootListing<string> | null;
  readonly locations: readonly ObservedLocation[];
  readonly watchedFiles: readonly string[];
} {
  const searched = configLocations(locs, query);
  const selected =
    query.kind === "chain" &&
    query.projectDir !== undefined &&
    query.path !== undefined
      ? files.realpath(query.path)
      : null;
  // A link to the named base stays watched, since it can become a separate
  // project file on retarget. It cannot be another layer or write target now.
  const locations = observeConfigLocations(
    searched,
    files,
    typeof selected === "string" ? selected : null,
  );
  const candidates = searched.flatMap(({ candidates }) =>
    candidates.map(({ file }) => file),
  );
  const found = locations.flatMap((location) =>
    location.kind === "found" ? [location] : [],
  );
  const seen = repoProject(
    query.kind === "chain" ? query.projectDir : undefined,
    found.some(({ role }) => role !== "user"),
    files,
  );
  // [LAW:one-source-of-truth] Only layered queries observe an answer book.
  const book = query.kind === "file" ? null : readAnswers();
  const project =
    book === null
      ? NO_PROJECT_ACCESS
      : projectAccess(book.result, seen.project);
  const layers: ConfigLayer[] = found
    .filter(({ role }) => admitsLayer(project, role))
    .reverse()
    .map(({ role, winner }) => ({ role, path: winner.file }));
  const user = locations.find(({ role }) => role === "user");
  const home =
    user?.kind === "found"
      ? user.winner.file
      : (query.path ?? userConfigDefault(locs));
  const namedFailure = query.path !== undefined && user?.kind !== "found";
  const unchecked = locations.flatMap((location) =>
    namedFailure && location === user ? [] : location.unchecked,
  );
  const common = {
    layers,
    home,
    project,
    unchecked:
      seen.unchecked === null ? unchecked : [...unchecked, seen.unchecked],
  };
  const problem = user?.unchecked[0];
  const resolution: ConfigResolution = !namedFailure
    ? { ...common, kind: "chain" }
    : problem === undefined
      ? { ...common, kind: "missing", path: home }
      : { ...common, kind: "unreadable", ...problem };
  return {
    resolution,
    repoRoot: listedRepoRoot(project.approved, seen.entries),
    locations,
    watchedFiles: [...candidates, ...(book?.paths ?? [])],
  };
}

// A layered query observes plugin names once, including a listing failure.
// The question and the definitions the host can read both use that result.
type ProjectObservation =
  | {
      readonly project: RepoProject;
      readonly unchecked: null;
      readonly entries: ReturnType<DiscoveryFiles["folders"]>;
    }
  | {
      readonly project: null;
      readonly unchecked: Unchecked | null;
      readonly entries: null;
    };

function repoProject(
  projectDir: string | undefined,
  hasConfig: boolean,
  files: DiscoveryFiles,
): ProjectObservation {
  if (projectDir === undefined)
    return { project: null, unchecked: null, entries: null };
  const present = files.presence(projectDir);
  if (present !== "present")
    return {
      project: null,
      unchecked: present === "absent" ? null : present,
      entries: null,
    };
  const dir = files.realpath(projectDir);
  if (typeof dir !== "string")
    return { project: null, unchecked: dir, entries: null };
  const entries = files.folders(repoPluginDir(projectDir));
  return {
    project: {
      dir,
      link: files.worktree(dir),
      path: projectDir,
      contributes:
        hasConfig || (!("error" in entries) && entries.folders.length > 0),
    },
    unchecked: null,
    entries,
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
