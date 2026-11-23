// The unit run's one global setup: what git says of the checkout, read once for
// the run and handed to every worker through the env. It is the one place the
// unit tier asks git: the repository's ignored paths for the refusal, and which
// paths the living documents cite are there.

import path from "node:path";

import { readCitationAnswer } from "./helpers/checkout";
import { DOC_CITATIONS_ENV } from "./helpers/doc-paths";
import { IGNORED_ENV, gitIgnored } from "./helpers/package-files";

export default function unitGlobalSetup(): void {
  const root = path.resolve(__dirname, "..");
  process.env[IGNORED_ENV] = JSON.stringify(gitIgnored(root));
  process.env[DOC_CITATIONS_ENV] = JSON.stringify(readCitationAnswer(root));
}
