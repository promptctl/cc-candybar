// The chain a search resolves, without the repository question it asks: what
// a test of the precedence and the gate reads.

import { searchConfig } from "../../src/daemon/config-discovery/config-search";
import { configQuery, type ConfigResolution, type Locations } from "../../src/config/loader/chain-places";

import type { RepoAnswers } from "../../src/config/loader/repo-gate";

export const observedAnswers = (result: RepoAnswers) => ({ result, paths: [] });

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
