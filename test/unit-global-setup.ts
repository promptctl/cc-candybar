// The unit run's one global setup: the repository's ignored paths, read once for
// the run and handed to every worker through the env.

import path from "node:path";

import globalSetup from "./global-setup";
import { IGNORED_ENV, gitIgnored } from "./helpers/package-files";

export default function unitGlobalSetup(): void {
  globalSetup();
  process.env[IGNORED_ENV] = JSON.stringify(gitIgnored(path.resolve(__dirname, "..")));
}
