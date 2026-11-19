// [LAW:effects-at-boundaries] The host observes each location's candidates
// once. Both the writable chain and the diagnostics use that observation.

import path from "node:path";
import type { Unchecked } from "../../utils/presence.js";
import { REPO_PLUGIN_DIR } from "./plugin-folders.js";
import type { RepoQuestion } from "../../config/config-snapshot.js";
import {
  gateRepos,
  repoQuestion,
  type RepoConfigBook,
  type RepoGate,
  type RepoDir,
  type RepoProject,
} from "../../config/loader/repo-gate.js";
import {
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

const NO_REPOS: RepoGate = {
  plugins: null,
  approved: [],
  awaiting: [],
  declined: [],
  unproven: [],
  unread: null,
};

export function searchConfig(
  locs: Locations,
  readAnswers: () => StateObservation<RepoConfigBook>,
  query: ConfigQuery,
  files = discoveryFiles(),
): {
  readonly resolution: ConfigResolution;
  readonly question: RepoQuestion | null;
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
  const repoDirs = new Map<string, RepoDir>();
  for (const { role, directory } of found) {
    if (role === "user" || repoDirs.has(directory)) continue;
    repoDirs.set(directory, {
      dir: directory,
      link: files.worktree(directory),
    });
  }
  const dirs = [...repoDirs.values()];
  const seen = repoProject(
    query.kind === "chain" ? query.projectDir : undefined,
    files,
  );
  const book = query.kind === "file" ? null : readAnswers();
  const answers = book?.result ?? null;
  const repos =
    answers === null ? NO_REPOS : gateRepos(answers, dirs, seen.project);
  const question =
    answers === null ? null : repoQuestion(answers, dirs, seen.project);
  const layers: ConfigLayer[] = found
    .filter(
      ({ role, directory }) =>
        role === "user" || repos.approved.includes(directory),
    )
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
    repos,
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
    question,
    locations,
    watchedFiles: [...candidates, ...(book?.paths ?? [])],
  };
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
