import { workflowsOnDisk } from "../e2e-checks/repo-on-disk";
import { stepsOf } from "../e2e-checks/workflow-daemons";

// The steps that hold a transitional file to shrinking, each pinned in all three
// parts: the pull_request guard, the file and the base commit. A step that
// compares the file with itself, or runs on pushes where there is no base, fails
// here. The ratchet is deleted by candybar-testing-ihvy.xql.

const stepFor = (file: string) =>
  `node scripts/check-shrinks.cjs ${file} \${{ github.event.pull_request.base.sha }}`;

test.each([
  ["the daemon-boot ratchet", "test/transitional-daemon-boots/ratchet.json"],
])("release.yml runs check-shrinks on %s against the pull request's base", (_, file) => {
  const release = workflowsOnDisk().find(({ name }) => name === "release.yml")!;
  const steps = stepsOf(release.text, "release.yml").filter((step) => step.run.trim() === stepFor(file));
  expect(steps.map((step) => step.condition)).toEqual(["github.event_name == 'pull_request'"]);
});
