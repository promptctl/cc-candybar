import { isolateGit } from "./helpers/checkout";

// A child_process call without an explicit env inherits the real process
// environment. Jest gives each test file a copy. Clear the runner's Git and
// forge overrides here, before Jest forks its workers or the unit run asks Git.
export default function globalSetup(): void {
  isolateGit(process.env);
}
