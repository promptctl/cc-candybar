import { admit, type AdmittedWorld, type Host } from "../../src/host";
import type { RepositoryLocalEnv } from "../../src/proc/repository-local-env";
import { worldOf } from "./host";

// What a current git names, stated here so a daemon admitted for a test asks
// no git: only the repository-local tests ask a real one.
export const GIT_NAMES: RepositoryLocalEnv = {
  kind: "named",
  names: ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"],
};

// A daemon's world over `host`, admitted on what a current git names.
export const admittedOf = (host: Host): AdmittedWorld =>
  admit(worldOf(host), GIT_NAMES);
