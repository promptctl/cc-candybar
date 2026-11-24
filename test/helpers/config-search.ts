// The chain a search resolves, without the repository question it asks: what
// a test of the precedence and the gate reads.

import { searchConfig } from "../../src/daemon/config-discovery/config-search";
import { configQuery, type ConfigResolution, type Locations } from "../../src/config/loader/chain-places";

import type { RepoAnswers, RepoConfigBook } from "../../src/config/loader/repo-gate";
import type { StateObservation } from "../../src/daemon/state-file";

// A failed book names the file that did not read, as a real observation does.
export const observedAnswers = (result: RepoAnswers): StateObservation<RepoConfigBook> => ({
  result: result.kind === "ok" ? result : { ...result, file: "repo-configs.json" },
  paths: [],
  source: null,
});

export const resolutionOf = (
  locs: Locations,
  answers: RepoAnswers,
  scope: Parameters<typeof searchConfig>[2] | { projectDir?: string; configFile?: string },
  files?: Parameters<typeof searchConfig>[3],
): ConfigResolution =>
  searchConfig(
    locs,
    () => observedAnswers(answers),
    "kind" in scope ? scope : { kind: "chain", projectDir: scope.projectDir, path: scope.configFile },
    files,
  ).resolution;
