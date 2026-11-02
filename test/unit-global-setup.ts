// The unit run's one global setup: the base's, then the repository's ignored
// paths, read once for the run and handed to every worker through the env, as the
// ledger path is (test/global-setup.ts).

import path from "node:path";

import baseSetup from "./global-setup";
import { IGNORED_ENV, gitIgnored } from "./helpers/package-files";

export default function unitGlobalSetup(): void {
  baseSetup();
  process.env[IGNORED_ENV] = JSON.stringify(gitIgnored(path.resolve(__dirname, "..")));
}
